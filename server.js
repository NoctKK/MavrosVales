const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const Game = require('./game/Game');
const registerSocketHandlers = require('./sockets/registerSocketHandlers');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// === STATIC FILES ===
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use('/js', express.static(path.join(__dirname, 'js')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

// === GAME INSTANCE ===
let globalGameInstance = new Game(io);

// === GLOBAL ERROR HANDLING ===
process.on('uncaughtException', (err) => {
    console.error('Αποτράπηκε Crash (Exception):', err);

    if (globalGameInstance && typeof globalGameInstance.forceEmergencyReset === 'function') {
        try {
            globalGameInstance.forceEmergencyReset();
        } catch (resetErr) {
            console.error('Σφάλμα στο emergency reset:', resetErr);
        }
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('Αποτράπηκε Crash (Rejection):', reason);
});

// === SOCKETS ===
io.on('connection', (socket) => {
    registerSocketHandlers(io, socket, globalGameInstance);
});

// === START SERVER ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Ο Μαύρος Βαλές τρέχει στο port ${PORT}`);
});
