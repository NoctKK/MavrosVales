const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

process.on('uncaughtException', (err) => { console.error('Αποτράπηκε Crash:', err); });

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let deck = [], discardPile = [], players = {}, playerOrder = [], turnIndex = 0;
let direction = 1, penaltyStack = 0, penaltyType = null, activeSuit = null;
let gameStarted = false, roundHistory = [], roundStarterIndex = 0, consecutiveTwos = 0;

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'], values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let newDeck = [];
    for (let i = 0; i < 2; i++) {
        suits.forEach(s => values.forEach(v => {
            newDeck.push({ suit: s, value: v, color: (s === '♥' || s === '♦') ? 'red' : 'black' });
        }));
    }
    return newDeck.sort(() => Math.random() - 0.5);
}

function calculateHandScore(hand) {
    let score = 0;
    hand.forEach(c => {
        if (c.value === 'A') score += 50;
        else if (['K', 'Q', 'J'].includes(c.value)) score += 10;
        else score += parseInt(c.value);
    });
    return score;
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        let username = data.username, sessionId = data.sessionId;
        let existingId = Object.keys(players).find(id => players[id].sessionId === sessionId && sessionId !== null);

        if (existingId) {
            players[socket.id] = players[existingId];
            players[socket.id].id = socket.id; players[socket.id].connected = true;
            let idx = playerOrder.indexOf(existingId); if (idx !== -1) playerOrder[idx] = socket.id;
            delete players[existingId];
            socket.emit('rejoinSuccess', { gameStarted, myHand: players[socket.id].hand });
            io.emit('playerCountUpdate', Object.keys(players).length);
            if (gameStarted) broadcastUpdate();
        } else {
            if (gameStarted) return socket.emit('notification', 'Το παιχνίδι τρέχει ήδη!');
            let cleanName = (username && typeof username === 'string') ? username.trim() : "Παίκτης " + (Object.keys(players).length + 1);
            if (["δήμητρα", "δημητρα", "δημητρούλα", "δημητρουλα"].includes(cleanName.toLowerCase())) cleanName += " ❤️";
            players[socket.id] = { id: socket.id, sessionId, hand: [], name: cleanName, totalScore: 0, hats: 0, hasDrawn: false, connected: true };
            io.emit('playerCountUpdate', Object.keys(players).length);
            socket.emit('joinedLobby');
        }
    });

    socket.on('chatMessage', (msg) => {
        const p = players[socket.id];
        if (p) io.emit('chatUpdate', { name: p.name, text: msg });
    });

    socket.on('startGameRequest', () => { if (!gameStarted && Object.keys(players).length >= 2) startNewRound(true); });

    socket.on('playCard', (data) => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id], card = p.hand[data.index], topCard = discardPile[discardPile.length - 1];
        let effectiveSuit = activeSuit || topCard.suit, isValid = false;

        if (penaltyStack > 0) {
            if (penaltyType === '7' && card.value === '7') isValid = true;
            if (penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            if (card.value === 'A') isValid = true;
            else if (card.value === topCard.value || card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true;
        }

        if (isValid) {
            p.hand.splice(data.index, 1); discardPile.push(card);
            if (p.hand.length === 1) io.emit('notification', `${p.name}: Μία μία μία μία! ⚠️`);
            if (p.hand.length === 0) {
                if (card.value === 'J' && card.color === 'black') {
                    let victimId = playerOrder[(turnIndex + direction + playerOrder.length) % playerOrder.length];
                    for(let i=0; i<10; i++) { if(deck.length===0) refillDeck(); players[victimId].hand.push(deck.pop()); }
                }
                handleRoundEnd(socket.id, card.value === 'A'); return;
            }
            activeSuit = (card.value === 'A') ? data.declaredSuit : null;
            processCardLogic(card, p); broadcastUpdate();
        } else { socket.emit('invalidMove'); }
    });

    socket.on('drawCard', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id];
        if (penaltyStack === 0 && p.hasDrawn) return socket.emit('notification', 'Έχεις ήδη τραβήξει!');
        let count = penaltyStack > 0 ? penaltyStack : 1;
        for(let i=0; i<count; i++) { if(deck.length===0) refillDeck(); p.hand.push(deck.pop()); }
        p.hasDrawn = (penaltyStack === 0); penaltyStack = 0; penaltyType = null;
        broadcastUpdate();
    });

    socket.on('passTurn', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id || penaltyStack > 0 || !players[socket.id].hasDrawn) return;
        advanceTurn(1); broadcastUpdate();
    });
});

function processCardLogic(card, currentPlayer) {
    let advance = true, steps = 1, isStart = (!currentPlayer || !currentPlayer.id);
    if (card.value === '2') {
        consecutiveTwos++;
        if (consecutiveTwos >= 3) { io.emit('notification', 'Ξες πώς πάνε αυτά! 😂'); consecutiveTwos = 0; }
        if (!isStart) {
            let victimId = playerOrder[(turnIndex - direction + playerOrder.length) % playerOrder.length];
            if(deck.length === 0) refillDeck(); players[victimId].hand.push(deck.pop());
        }
    } else consecutiveTwos = 0;

    if (card.value === '8') { advance = false; if(!isStart) currentPlayer.hasDrawn = false; }
    else if (card.value === '7') { penaltyStack += 2; penaltyType = '7'; }
    else if (card.value === 'J' && card.color === 'black') { penaltyStack += 10; penaltyType = 'J'; }
    else if (card.value === 'J' && card.color === 'red') { penaltyStack = 0; penaltyType = null; }
    else if (card.value === '3') { if (playerOrder.length === 2) advance = false; else direction *= -1; }
    else if (card.value === '9') {
        if (playerOrder.length === 2) advance = false; else steps = 2;
        if (!isStart) io.emit('notification', 'Άραξε 🍹');
    }
    if (advance) advanceTurn(steps);
}

function startNewRound(reset = false) {
    gameStarted = true; deck = createDeck(); playerOrder = Object.keys(players);
    if (reset) { roundHistory = []; playerOrder.forEach(id => { players[id].totalScore = 0; players[id].hats = 0; }); turnIndex = 0; }
    direction = 1; penaltyStack = 0; activeSuit = null;
    playerOrder.forEach(id => { players[id].hand = []; players[id].hasDrawn = false; });
    let dealCount = 0;
    let interval = setInterval(() => {
        playerOrder.forEach(id => players[id].hand.push(deck.pop()));
        if (++dealCount === 11) {
            clearInterval(interval);
            let first = deck.pop();
            while(first.value === 'J' && first.color === 'black') { deck.unshift(first); first = deck.pop(); }
            discardPile = [first]; io.emit('gameReady');
            processCardLogic(first, null); broadcastUpdate();
        }
    }, 50);
}

function handleRoundEnd(winnerId, closedWithAce) {
    let historyEntry = {};
    playerOrder.forEach(id => {
        if (id === winnerId) historyEntry[players[id].name] = "WC";
        else {
            let pts = calculateHandScore(players[id].hand) + (closedWithAce ? 50 : 0);
            players[id].totalScore += pts; historyEntry[players[id].name] = players[id].totalScore;
        }
    });
    let safe = playerOrder.filter(id => players[id].totalScore < 500);
    if (safe.length === 1 && playerOrder.length > 1) {
        io.emit('updateScoreboard', { history: [...roundHistory, historyEntry], players: playerOrder.map(id => players[id]) });
        io.emit('gameOver', players[safe[0]].name); gameStarted = false; return;
    }
    let target = safe.length > 0 ? Math.max(...safe.map(id => players[id].totalScore)) : 0;
    playerOrder.forEach(id => { if (players[id].totalScore >= 500) { players[id].hats++; players[id].totalScore = target; } });
    roundHistory.push(historyEntry);
    io.emit('updateScoreboard', { history: roundHistory, players: playerOrder.map(id => players[id]) });
    setTimeout(() => startNewRound(false), 2000);
}

function advanceTurn(steps) {
    turnIndex = (turnIndex + (direction * steps)) % playerOrder.length;
    if (turnIndex < 0) turnIndex += playerOrder.length;
    playerOrder.forEach(id => players[id].hasDrawn = false);
}

function refillDeck() {
    let top = discardPile.pop(); deck = [...discardPile].sort(() => Math.random() - 0.5); discardPile = [top];
    io.emit('notification', '🔄 Ανακάτεμα!');
}

function broadcastUpdate() {
    let cp = players[playerOrder[turnIndex]];
    playerOrder.forEach(id => {
        io.to(id).emit('updateUI', {
            players: playerOrder.map(pid => ({ id: pid, name: players[pid].name, handCount: players[pid].hand.length, hats: players[pid].hats, totalScore: players[pid].totalScore, connected: players[pid].connected })),
            topCard: discardPile[discardPile.length - 1],
            penalty: penaltyStack, direction, myHand: players[id].hand, isMyTurn: (id === playerOrder[turnIndex]),
            currentPlayerName: cp ? cp.name : "...", activeSuit, deckCount: deck.length
        });
    });
}

server.listen(process.env.PORT || 3000);
