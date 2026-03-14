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

const globalGameInstance = new Game(io);

// static αρχεία από root, styles, js
app.use(express.static(__dirname));
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use('/js', express.static(path.join(__dirname, 'js')));

// routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

// global error handling
process.on('uncaughtException', (err) => {
    console.error('Αποτράπηκε Crash (Exception):', err);
    if (globalGameInstance && typeof globalGameInstance.forceEmergencyReset === 'function') {
        globalGameInstance.forceEmergencyReset();
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('Αποτράπηκε Crash (Rejection):', reason);
});

// socket handlers
io.on('connection', (socket) => {
    registerSocketHandlers(io, socket, globalGameInstance);
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Ο Μαύρος Βαλές τρέχει στο port ${PORT}`);
});
