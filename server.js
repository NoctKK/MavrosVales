const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const Game = require('./game/Game');
const registerSocketHandlers = require('./sockets/registerSocketHandlers');

const app = express();
const server = http.createServer(app);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const globalGameInstance = new Game(io);

process.on('uncaughtException', (err) => {
    console.error('Αποτράπηκε Crash (Exception):', err);
    if (globalGameInstance) globalGameInstance.forceEmergencyReset();
});

process.on('unhandledRejection', (reason) => {
    console.error('Αποτράπηκε Crash (Rejection):', reason);
});

registerSocketHandlers(io, globalGameInstance);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Ο Μαύρος Βαλές τρέχει στο port ${PORT}`);
});
