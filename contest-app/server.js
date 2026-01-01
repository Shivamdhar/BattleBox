const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const sqlite3 = require('sqlite3').verbose(); // Use SQLite instead of Mongoose
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    path: '/socket.io/',
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['polling', 'websocket']
});

const PORT = 3000;
const BUCKET_NAME = "contes-app-s3-bucket";
const ADMIN_CREDENTIALS = { user: "admin", pass: "password123" };

// --- DATABASE INITIALIZATION (SQLite) ---
// This creates a file named 'contest.db' in your project root
const db = new sqlite3.Database('./data/contest.db', (err) => {
    if (err) console.error("❌ SQLite Connection Error:", err.message);
    else console.log("✅ Connected to SQLite Database");
});

// Create the submissions table if it doesn't exist
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teamName TEXT UNIQUE,
        answers TEXT,
        score INTEGER,
        submittedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- S3 CLIENT & CACHE ---
const s3Client = new S3Client({ region: "us-east-1" });
let contestQuestions = [];
let contestAnswers = {}; 
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

// --- INITIALIZATION ---
async function loadContestConfig() {
    try {
        const qData = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: "questions.json" }));
        const aData = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: "answers.json" }));
        contestQuestions = JSON.parse(await qData.Body.transformToString());
        contestAnswers = JSON.parse(await aData.Body.transformToString());
        console.log("✅ Questions Loaded from S3");
    } catch (err) { console.error("❌ S3 Load Error:", err.message); }
}
loadContestConfig();

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