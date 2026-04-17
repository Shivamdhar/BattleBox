require('dotenv').config();
const fsSync = require('fs');
if (!fsSync.existsSync('./data')) fsSync.mkdirSync('./data');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const isProduction = process.env.NODE_ENV === 'production';
const ADMIN_CREDENTIALS = {
    user: process.env.ADMIN_USER || "admin",
    pass: process.env.ADMIN_PASS || "password123"
};

let contestQuestions = [];
let contestAnswers = {};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    path: '/socket.io/',
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['polling', 'websocket']
});

const PORT = 3000;
const CONTEST_MODE = process.env.CONTEST_MODE || 'batch';
const BUCKET_NAME = process.env.BUCKET_NAME || "my-contest-data-2026";

console.log(CONTEST_MODE, process.env);
// Isolate DB file per mode to prevent collision
const dbFile = path.join(__dirname, 'data', `contest_${CONTEST_MODE}.db`);
const db = new sqlite3.Database(dbFile);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teamName TEXT UNIQUE,
        answers TEXT,
        score INTEGER,
        submittedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS fasttrack_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teamName TEXT,
        questionId TEXT,
        isCorrect INTEGER,
        scoreAwarded INTEGER,
        UNIQUE(teamName, questionId)
    )`);
});

const s3Client = new S3Client({ region: "us-east-1" });
const ssmClient = new SSMClient({ region: "us-east-1" });
const activeTeams = new Map();

app.use(express.json({ limit: '10mb' })); // Increased limit for JSON config uploads
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'super-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 3600000 }
}));

async function bootstrap() {
    if (isProduction) {
        try {
            const userCmd = new GetParameterCommand({ Name: "/contest/admin_user" });
            const passCmd = new GetParameterCommand({ Name: "/contest/admin_pass" });
            const [uR, pR] = await Promise.all([ssmClient.send(userCmd), ssmClient.send(passCmd)]);
            ADMIN_CREDENTIALS.user = uR.Parameter.Value;
            ADMIN_CREDENTIALS.pass = pR.Parameter.Value;

            const qD = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: "questions.json" }));
            const aD = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: "answers.json" }));
            contestQuestions = JSON.parse(await qD.Body.transformToString());
            contestAnswers = JSON.parse(await aD.Body.transformToString());
            console.log("✅ Production mode: S3/SSM Loaded");
        } catch (err) { console.error("Bootstrap Error:", err.message); }
    } else {
        try {
            contestQuestions = JSON.parse(await fs.readFile('./questions.json', 'utf8'));
            contestAnswers = JSON.parse(await fs.readFile('./answers.json', 'utf8'));
            console.log("💻 Local mode: JSON files loaded");
        } catch (err) { console.log("⚠️ Local JSON files missing"); }
    }
}
bootstrap();


// Pass config to frontend
app.get('/api/config', (req, res) => {
    res.json({ mode: CONTEST_MODE });
});


// NEW: Single Question Validation for FastTrack
app.post('/api/check-task', (req, res) => {
    const { teamName, qId, sqId, answer } = req.body;
    const correctCfg = contestAnswers[qId];

    if (!correctCfg) return res.status(404).json({ error: "Question not found" });

    let isCorrect = false;
    let pointsAwarded = 0;
    let displayAnswer = "";

    // Identify if we are checking a sub-question or a top-level question
    const target = sqId ? correctCfg[sqId] : correctCfg;

    if (target.type === 'mcq') {
        isCorrect = (answer === target.ans);
        displayAnswer = target.ans;
        pointsAwarded = target.points || target.score;
    } else if (target.keywords) {
        isCorrect = target.keywords.some(kw =>
            (answer || "").toLowerCase().includes(kw.toLowerCase())
        );
        displayAnswer = target.keywords[0]; // Show the first keyword as the hint
        pointsAwarded = target.points || target.score;
    }

    // 🛡️ LOCKING LOGIC: Save to SQLite so they can't re-submit for points
    const attemptId = sqId ? `${qId}_${sqId}` : qId;
    
    db.get("SELECT isCorrect FROM fasttrack_attempts WHERE teamName = ? AND questionId = ?",
        [teamName, attemptId], (err, row) => {
            if (row) {
                return res.json({
                    alreadySubmitted: true,
                    correct: row.isCorrect === 1,
                    msg: "Task already attempted."
                });
            }

            db.run(
                "INSERT INTO fasttrack_attempts (teamName, questionId, isCorrect, scoreAwarded) VALUES (?, ?, ?, ?)",
                [teamName, attemptId, isCorrect ? 1 : 0, isCorrect ? pointsAwarded : 0],
                (err) => {
                    if (err) {
                        console.error(err);
                        return res.status(500).json({ error: "Storage error" });
                    }
                    res.json({
                        correct: isCorrect,
                        solution: isCorrect ? null : displayAnswer
                    });

                    if (isCorrect) {
                        // Ensure this function is defined or wrapped in a try/catch
                        try { updateLiveLeaderboard(); } catch (e) { }
                    }
                }
            );
        });
});

// --- CORE API ---
app.get('/api/questions', (req, res) => res.json(contestQuestions));

app.post('/api/validate-team', (req, res) => {
    const { teamName } = req.body;
    if (!teamName || teamName.trim().length < 2) return res.status(400).json({ error: "Invalid Name: Team name should have atleast 2 chars" });
    const cleanName = teamName.trim().toLowerCase();

    db.get("SELECT teamName FROM submissions WHERE LOWER(teamName) = ?", [cleanName], (err, row) => {
        if (row) return res.status(403).json({ error: "Team already submitted." });
        if (Array.from(activeTeams.values()).includes(cleanName)) return res.status(403).json({ error: "Team active elsewhere." });
        res.status(200).json({ message: "Valid" });
    });
});

// --- UPDATED GRADING LOGIC ---
app.post('/api/submit', (req, res) => {
    const { teamName, answers } = req.body;
    let score = 0;

    Object.keys(answers).forEach(qId => {
        const correctCfg = contestAnswers[qId];
        const userAns = answers[qId];

        if (!correctCfg) return;

        // Handle File Analysis (Nested Sub-Questions)
        if (typeof userAns === 'object' && !Array.isArray(userAns)) {
            Object.keys(userAns).forEach(sqId => {
                const sqCorrect = correctCfg[sqId];
                if (!sqCorrect) return;

                if (sqCorrect.type === 'mcq' && userAns[sqId] === sqCorrect.ans) {
                    score += sqCorrect.points;
                } else if (sqCorrect.keywords && sqCorrect.keywords.some(kw => (userAns[sqId] || "").toLowerCase().includes(kw.toLowerCase()))) {
                    score += sqCorrect.points;
                }
            });
        }
        // Handle Standard MCQ/Text
        else {
            if (correctCfg.type === 'mcq' && userAns === correctCfg.ans) score += correctCfg.score;
            else if (correctCfg.keywords && correctCfg.keywords.some(kw => (userAns || "").toLowerCase().includes(kw.toLowerCase()))) {
                score += correctCfg.score;
            }
        }
    });

    const stmt = db.prepare("INSERT INTO submissions (teamName, answers, score) VALUES (?, ?, ?)");
    stmt.run(teamName, JSON.stringify(answers), score, (err) => {
        if (err) return res.status(500).json({ error: "Submission failed." });
        res.json({ success: true, score });
    });
    stmt.finalize();
});

// --- ADMIN API (FIXED ROUTES) ---
app.post('/api/admin/login', (req, res) => {
    if (req.body.username === ADMIN_CREDENTIALS.user && req.body.password === ADMIN_CREDENTIALS.pass) {
        req.session.adminLoggedIn = true;
        res.json({ success: true });
    } else res.status(401).json({ error: "Invalid login" });
});

app.post('/api/admin/upload-config', async (req, res) => {
    if (!req.session.adminLoggedIn) return res.status(401).json({ error: "Unauthorized" });
    const { filename, content } = req.body;

    try {
        if (isProduction) {
            await s3Client.send(new PutObjectCommand({
                Bucket: BUCKET_NAME,
                Key: filename,
                Body: JSON.stringify(content, null, 2),
                ContentType: "application/json"
            }));
        } else {
            await fs.writeFile(path.join(__dirname, filename), JSON.stringify(content, null, 2));
        }
        res.json({ message: `${filename} uploaded successfully!` });
    } catch (err) {
        res.status(500).json({ error: "Upload failed: " + err.message });
    }
});

app.post('/api/admin/refresh-config', async (req, res) => {
    if (!req.session.adminLoggedIn) return res.status(401).json({ error: "Unauthorized" });
    await bootstrap();
    res.json({ questions: contestQuestions.length });
});

app.get('/api/admin/submissions', (req, res) => {
    if (!req.session.adminLoggedIn) return res.status(401).json({ error: "Unauthorized" });
    db.all("SELECT * FROM submissions ORDER BY score DESC", [], (err, rows) => {
        res.json(rows.map(r => ({ ...r, answers: JSON.parse(r.answers) })));
    });
});

app.get('/api/admin/server-stats', async (req, res) => {
    try {
        const response = await fetch('http://nginx-shield/nginx_status');
        res.send(await response.text());
    } catch (err) { res.status(500).send("Stats Unavailable"); }
});

app.get('/admin', (req, res) => {
    if (!req.session.adminLoggedIn) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

io.on('connection', (socket) => {
    socket.on('join-contest', (teamName) => {
        const cleanName = teamName?.trim().toLowerCase();
        if (cleanName) { socket.join(cleanName); activeTeams.set(socket.id, cleanName); }
    });
    socket.on('disconnect', () => activeTeams.delete(socket.id));
});

async function updateLiveLeaderboard() {
    const query = `
        SELECT teamName, SUM(scoreAwarded) as totalScore, MAX(id) as lastUpdate 
        FROM fasttrack_attempts 
        GROUP BY teamName 
        ORDER BY totalScore DESC
    `;

    db.all(query, [], (err, rows) => {
        if (err) return console.error("Leaderboard Error:", err);
        // Broadcast to all connected clients
        io.emit('leaderboard-update', rows);
    });
}

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port ${PORT}`));