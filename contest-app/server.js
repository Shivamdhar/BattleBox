const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const mongoose = require('mongoose');
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const server = http.createServer(app);

// 1. Socket.io Setup (Fixed for Docker mapping)
const io = new Server(server, {
    path: '/socket.io/',
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['polling', 'websocket']
});

const PORT = 3000;
const BUCKET_NAME = "contes-app-s3-bucket"; // Replace with your actual bucket name
const ADMIN_CREDENTIALS = { user: "admin", pass: "password123" };

// --- CONFIG & S3 CLIENT ---
const s3Client = new S3Client({ region: "us-east-1" });

// --- IN-MEMORY CACHE ---
let contestQuestions = [];
let contestAnswers = {}; 
const activeTeams = new Map(); // SocketID -> TeamName

// --- DATABASE CONNECTION (Docker Fix) ---
const mongoURI = process.env.MONGO_URI || 'mongodb://db:27017/contest';
mongoose.connect(mongoURI)
    .then(() => console.log("✅ Connected to MongoDB (Docker)"))
    .catch(err => console.error("❌ MongoDB Error:", err));

const Submission = mongoose.model('Submission', new mongoose.Schema({
    teamName: { type: String, unique: true },
    answers: Object,
    submittedAt: { type: Date, default: Date.now },
    score: Number
}));

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'super-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 3600000 }
}));

const isAdmin = (req, res, next) => {
    if (req.session.adminLoggedIn) return next();
    res.status(401).json({ error: "Unauthorized" });
};

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

app.get('/api/questions', (req, res) => {
    res.json(contestQuestions || []);
});

// FIXED: Validate Team Name + Mongo Check + Active Session Check
app.post('/api/validate-team', async (req, res) => {
    const { teamName } = req.body;
    if (!teamName || teamName.trim().length < 3) {
        return res.status(400).json({ error: "Team name must be at least 3 characters." });
    }

    const cleanName = teamName.trim().toLowerCase();

    try {
        // 1. Check if they already submitted in MongoDB
        const submitted = await Submission.findOne({ teamName: new RegExp(`^${cleanName}$`, 'i') });
        if (submitted) return res.status(403).json({ error: "This team has already submitted their answers." });

        // 2. Check if team is currently active in another browser tab
        const currentActive = Array.from(activeTeams.values());
        if (currentActive.includes(cleanName)) {
            return res.status(403).json({ error: "This team is already logged in elsewhere." });
        }

        res.status(200).json({ message: "Valid" });
    } catch (err) {
        res.status(500).json({ error: "Database validation error." });
    }
});

app.post('/api/submit', async (req, res) => {
    const { teamName, answers } = req.body;
    let score = 0;

    // Scoring Logic
    Object.keys(answers).forEach(qId => {
        const correct = contestAnswers[qId];
        if (correct) {
            if (correct.type === 'mcq' && answers[qId] === correct.ans) score += correct.score;
            else if (correct.keywords && correct.keywords.some(kw => answers[qId].toLowerCase().includes(kw.toLowerCase()))) {
                score += correct.score;
            }
        }
    });

    try {
        await Submission.create({ teamName, answers, score });
        res.json({ success: true, score });
    } catch (e) { res.status(500).json({ error: "Submission failed." }); }
});

// --- ADMIN ROUTES ---
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_CREDENTIALS.user && password === ADMIN_CREDENTIALS.pass) {
        req.session.adminLoggedIn = true;
        res.json({ success: true });
    } else res.status(401).json({ error: "Invalid login" });
});

app.get('/api/admin/submissions', isAdmin, async (req, res) => {
    const subs = await Submission.find().sort({ score: -1 });
    res.json(subs);
});

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    socket.on('join-contest', (teamName) => {
        if (!teamName) return;
        const cleanName = teamName.trim().toLowerCase();
        socket.join(cleanName);
        activeTeams.set(socket.id, cleanName); // Link Socket ID to Team Name
        console.log(`📡 Team Joined: ${cleanName}`);
    });

    socket.on('disconnect', () => {
        activeTeams.delete(socket.id); // Remove from active list on disconnect
    });
});

// --- SERVE ADMIN UI ---
app.get('/admin', (req, res) => {
    if (!req.session.adminLoggedIn) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- START SERVER ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});