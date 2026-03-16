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
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000
});

// === NO-CACHE FOR HTML / JS / CSS ===
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// === STATIC FILES ===
app.use('/styles', express.static(path.join(__dirname, 'styles'), {
    etag: false,
    lastModified: false
}));

app.use('/js', express.static(path.join(__dirname, 'js'), {
    etag: false,
    lastModified: false
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
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

process.on('SIGTERM', () => {
    console.log('SIGTERM received:', new Date().toISOString());
});

process.on('exit', (code) => {
    console.log('Process exit with code:', code, new Date().toISOString());
});

setInterval(() => {
    console.log('SERVER ALIVE', new Date().toISOString());
}, 30000);

// === SOCKETS ===
io.on('connection', (socket) => {
    console.log('[SOCKET] connect', {
        id: socket.id,
        time: new Date().toISOString()
    });

    // extra heartbeat support από client
    socket.on('heartbeat', () => {
        socket.emit('heartbeatAck', { ok: true, t: Date.now() });
    });

    socket.on('disconnect', (reason) => {
        console.log('[SOCKET] disconnect', {
            id: socket.id,
            reason,
            time: new Date().toISOString()
        });
    });

    registerSocketHandlers(io, socket, globalGameInstance);
});

// === START SERVER ===
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Ο Μαύρος Βαλές τρέχει στο port ${PORT}`);
});
