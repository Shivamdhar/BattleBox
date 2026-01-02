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
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm"); // New
// Check if we are running in production (AWS)
const isProduction = process.env.NODE_ENV === 'production';
// These will now pull from .env locally or the OS/SSM on AWS
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
const BUCKET_NAME = "my-contest-data-2026"; // Match your CloudFormation param

// --- DATABASE INITIALIZATION ---
const db = new sqlite3.Database('./data/contest.db', (err) => {
    if (err) console.error("❌ SQLite Error:", err.message);
    else console.log("✅ Connected to SQLite");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teamName TEXT UNIQUE,
        answers TEXT,
        score INTEGER,
        submittedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- CLIENTS ---
const s3Client = new S3Client({ region: "us-east-1" });
const ssmClient = new SSMClient({ region: "us-east-1" }); // New
const activeTeams = new Map();

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'super-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 3600000 }
}));

// --- BOOTSTRAP LOGIC (SSM + S3) ---
async function bootstrap() {


    if (isProduction) {
        // --- CLOUD MODE (AWS SSM & S3) ---
        try {
            console.log("⏳ Loading configuration from AWS...");

            // 1. Fetch Credentials from SSM
            const userCmd = new GetParameterCommand({ Name: "/contest/admin_user" });
            const passCmd = new GetParameterCommand({ Name: "/contest/admin_pass" });

            const [userRes, passRes] = await Promise.all([
                ssmClient.send(userCmd),
                ssmClient.send(passCmd)
            ]);

            ADMIN_CREDENTIALS.user = userRes.Parameter.Value;
            ADMIN_CREDENTIALS.pass = passRes.Parameter.Value;
            console.log("✅ Admin credentials loaded from SSM");

            // 2. Fetch Questions/Answers from S3
            const qData = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: "questions.json" }));
            const aData = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: "answers.json" }));

            contestQuestions = JSON.parse(await qData.Body.transformToString());
            contestAnswers = JSON.parse(await aData.Body.transformToString());
            console.log("✅ Contest content loaded from S3");

            // 3. Start Server ONLY after everything is ready
            server.listen(PORT, '0.0.0.0', () => {
                console.log(`🚀 Server fully initialized and running on port ${PORT}`);
            });

        } catch (err) {
            console.error("❌ Bootstrap Failed:", err.message);
            process.exit(1); // Stop if we can't get credentials
        }
    } else {
        // --- LOCAL MODE (Hardcoded + Local Files) ---
        try {
            // Read from local files in your project root
            const qFile = await fs.readFile('./questions.json', 'utf8');
            const aFile = await fs.readFile('./answers.json', 'utf8');

            contestQuestions = JSON.parse(qFile);
            contestAnswers = JSON.parse(aFile);

            console.log("💻 Local Mode: Using hardcoded admin and local JSON files");
        } catch (err) {
            console.error("❌ Local Load Failed (Check if questions.json exists):", err.message);
        }
    }
}

// Start the process
bootstrap();

// --- API ROUTES ---

app.get('/api/questions', (req, res) => res.json(contestQuestions));

app.post('/api/validate-team', (req, res) => {
    const { teamName } = req.body;
    if (!teamName || teamName.trim().length < 3) return res.status(400).json({ error: "Invalid Name" });

    const cleanName = teamName.trim().toLowerCase();

    // Check SQLite for existing submission
    db.get("SELECT teamName FROM submissions WHERE LOWER(teamName) = ?", [cleanName], (err, row) => {
        if (row) return res.status(403).json({ error: "Team already submitted." });

        // Check Active Socket Sessions
        if (Array.from(activeTeams.values()).includes(cleanName)) {
            return res.status(403).json({ error: "Team active elsewhere." });
        }
        res.status(200).json({ message: "Valid" });
    });
});

app.post('/api/submit', (req, res) => {
    const { teamName, answers } = req.body;
    let score = 0;

    Object.keys(answers).forEach(qId => {
        const correct = contestAnswers[qId];
        if (correct) {
            if (correct.type === 'mcq' && answers[qId] === correct.ans) score += correct.score;
            else if (correct.keywords && correct.keywords.some(kw => (answers[qId] || "").toLowerCase().includes(kw.toLowerCase()))) {
                score += correct.score;
            }
        }
    });

    // Insert into SQLite
    const stmt = db.prepare("INSERT INTO submissions (teamName, answers, score) VALUES (?, ?, ?)");
    stmt.run(teamName, JSON.stringify(answers), score, (err) => {
        if (err) return res.status(500).json({ error: "Submission failed." });
        res.json({ success: true, score });
    });
    stmt.finalize();
});

// --- ADMIN ROUTES ---
app.get('/api/admin/submissions', (req, res) => {
    if (!req.session.adminLoggedIn) return res.status(401).json({ error: "Unauthorized" });

    db.all("SELECT * FROM submissions ORDER BY score DESC", [], (err, rows) => {
        res.json(rows.map(r => ({ ...r, answers: JSON.parse(r.answers) })));
    });
});

app.post('/api/admin/login', (req, res) => {
    if (req.body.username === ADMIN_CREDENTIALS.user && req.body.password === ADMIN_CREDENTIALS.pass) {
        req.session.adminLoggedIn = true;
        res.json({ success: true });
    } else res.status(401).json({ error: "Invalid login" });
});

app.post('/api/admin/logout', (req, res) => {
    // 1. Destroy the session in the store (SQLite/Memory)
    req.session.destroy((err) => {
        if (err) {
            console.error("Logout Error:", err);
            return res.status(500).json({ error: "Could not log out" });
        }

        // 2. Clear the cookie by name (default is 'connect.sid')
        res.clearCookie('connect.sid');

        // 3. Send success response
        res.json({ success: true });
    });
});

app.get('/admin', (req, res) => {
    if (!req.session.adminLoggedIn) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    socket.on('join-contest', (teamName) => {
        if (!teamName) return;
        const cleanName = teamName.trim().toLowerCase();
        socket.join(cleanName);
        activeTeams.set(socket.id, cleanName);
    });

    socket.on('disconnect', () => activeTeams.delete(socket.id));
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 SQLite Server running on port ${PORT}`));