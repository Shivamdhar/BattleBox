const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const basicAuth = require('express-basic-auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// 1. Database Connection
mongoose.connect('mongodb://localhost:27017/contest_db')
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("Could not connect to MongoDB", err));

const Submission = mongoose.model('Submission', new mongoose.Schema({
    teamName: { type: String, unique: true },
    answers: Object,
    submittedAt: Date,
    score: Number
}));

// 2. State Management
const activeTeams = new Map(); // teamName -> socketId

// 3. API Endpoints
// Check if team can log in
app.post('/api/validate-team', async (req, res) => {
    const { teamName } = req.body;
    
    // Check if already submitted
    const submitted = await Submission.findOne({ teamName });
    if (submitted) return res.status(403).json({ error: "Team has already submitted." });

    // Check if currently active in another window
    if (activeTeams.has(teamName)) return res.status(403).json({ error: "Team is active in another window." });

    res.status(200).json({ message: "Valid" });
});

function computeScores(answerMap) {
    const scoreQuestionMap = {
        "q1": {
            "ans": "Netscape", 
            "score": 10
        },
        "q2": {
            // Note: Descriptive answers usually require manual grading, 
            // but for auto-grading we can look for key terms.
            "keywords": ["scope", "function", "lexical"], 
            "score": 30
        },
        "q3": {
            // Looking for the vulnerability identified in the file explorer
            "keywords": ["DEBUG_MODE", "bypass", "config", "true"],
            "score": 40
        }
    };

    let totalScore = 0;

    for (const [key, value] of Object.entries(answerMap)) {
        if (key in scoreQuestionMap) {
            const config = scoreQuestionMap[key];
            const userAns = (value || "").toLowerCase();

            // Logic for MCQ (Exact Match)
            if (config.ans && config.ans.toLowerCase() === userAns) {
                totalScore += config.score;
            } 
            // Logic for Descriptive (Keyword Match)
            else if (config.keywords) {
                const matchFound = config.keywords.some(word => userAns.includes(word.toLowerCase()));
                if (matchFound) {
                    totalScore += config.score;
                }
            }
        }
    }
    return totalScore;
}
// Final Submit
app.post('/api/submit', async (req, res) => {
    try {
        const score = computeScores(req.body.answers);
        const submission = new Submission({ 
            teamName: req.body.teamName, 
            answers: req.body.answers, 
            score: score,
            submittedAt: new Date() 
        });
        await submission.save();
        res.status(200).json({ message: "Success" });
    } catch (e) {
        res.status(400).json({ error: "Submission failed" });
    }
});


app.use('/api/admin', basicAuth({
    users: { 'admin': 'p@ssword123' }, // Change these!
    challenge: true, // This triggers the browser login popup
    unauthorizedResponse: (req) => "Access Denied"
}));


// Add this to your server.js file
app.get('/api/admin/submissions', async (req, res) => {
    try {
        const data = await Submission.find({}, 'teamName submittedAt score').sort({ submittedAt: -1 });
        res.status(200).json(data);
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

// 4. Socket Logic
io.on('connection', (socket) => {
    socket.on('join-contest', (teamName) => {
        activeTeams.set(teamName, socket.id);
        console.log(`${teamName} joined`);
    });

    socket.on('disconnect', () => {
        for (let [team, id] of activeTeams.entries()) {
            if (id === socket.id) {
                activeTeams.delete(team);
                console.log(`${team} disconnected`);
            }
        }
    });
});

server.listen(3000, () => console.log('Server running on http://localhost:3000'));