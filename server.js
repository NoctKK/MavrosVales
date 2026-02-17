const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Ρυθμίσεις CORS
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- ΜΕΤΑΒΛΗΤΕΣ ---
let deck = [];
let discardPile = [];
let players = {};
let playerOrder = [];
let turnIndex = 0;
let direction = 1;
let penaltyStack = 0;
let penaltyType = null; 
let activeSuit = null; 
let gameStarted = false;
let roundHistory = [];

// --- ΒΟΗΘΗΤΙΚΕΣ ---
function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
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
        if (c.value === 'A') score += 11;
        else if (['K', 'Q', 'J'].includes(c.value)) score += 10;
        else score += parseInt(c.value);
    });
    return score;
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    players[socket.id] = {
        id: socket.id, hand: [], name: "Παίκτης " + (Object.keys(players).length + 1), totalScore: 0, hasDrawn: false
    };
    
    io.emit('playerCountUpdate', Object.keys(players).length);

    if (gameStarted) {
        socket.emit('updateUI', getGameState());
        socket.emit('updateScoreboard', roundHistory);
    }

    socket.on('startGameRequest', () => {
        if (gameStarted || Object.keys(players).length < 2) return;
        startNewRound(true);
    });

    socket.on('playCard', (data) => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        
        let p = players[socket.id];
        let card = p.hand[data.index];
        let topCard = discardPile[discardPile.length - 1];
        let declaredSuit = data.declaredSuit;

        let isValid = false;
        let effectiveSuit = activeSuit || topCard.suit;

        if (penaltyStack > 0) {
            if (penaltyType === '7' && card.value === '7') isValid = true;
            if (penaltyType === '2' && card.value === '2') isValid = true;
            if (penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            if (card.value === 'A') isValid = true;
            else if (card.value === topCard.value) isValid = true;
            else if (card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red') isValid = true;
        }

        if (isValid) {
            p.hand.splice(data.index, 1);
            discardPile.push(card);

            if (p.hand.length === 0) {
                handleRoundEnd(socket.id);
                return;
            }

            if (card.value === 'A') activeSuit = declaredSuit ? declaredSuit : card.suit;
            else activeSuit = null;

            let advance = true; 
            let steps = 1;

            if (card.value === '8') { advance = false; io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); }
            else if (card.value === '7') { penaltyStack += 2; penaltyType = '7'; }
            else if (card.value === '2') { penaltyStack += 1; penaltyType = '2'; }
            else if (card.value === 'J' && card.color === 'black') { penaltyStack += 10; penaltyType = 'J'; }
            else if (card.value === 'J' && card.color === 'red') { penaltyStack = 0; penaltyType = null; }
            else if (card.value === '3') { 
                if (playerOrder.length === 2) { advance = false; io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); }
                else direction *= -1; 
            }
            else if (card.value === '9') {
                 if (playerOrder.length === 2) { advance = false; io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); }
                 else steps = 2; 
            }

            if (advance) advanceTurn(steps);
            broadcastUpdate();
        } else {
            socket.emit('invalidMove');
        }
    });

    socket.on('drawCard', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id];
        
        if (penaltyStack === 0 && p.hasDrawn) {
            io.to(socket.id).emit('notification', "Έχεις ήδη τραβήξει! Παίξε ή Πάσο.");
            return;
        }

        let count = penaltyStack > 0 ? penaltyStack : 1;
        for(let i=0; i<count; i++) {
            if(deck.length===0) refillDeck();
            if(deck.length > 0) p.hand.push(deck.pop());
        }

        p.hasDrawn = true;
        penaltyStack = 0;
        penaltyType = null;
        
        io.to(socket.id).emit('notification', `Τράβηξες ${count} φύλλα!`);
        broadcastUpdate();
    });

    socket.on('passTurn', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        if (penaltyStack > 0) return;
        
        advanceTurn(1);
        broadcastUpdate();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerCountUpdate', Object.keys(players).length);
        if (gameStarted && Object.keys(players).length < 2) {
             gameStarted = false;
             io.emit('notification', "Διακοπή! Έμεινε μόνο ένας παίκτης.");
             setTimeout(() => io.emit('gameEndedForced'), 2000);
        }
    });
});

function startNewRound(resetTotalScores = false) {
    gameStarted = true;
    deck = createDeck();
    playerOrder = Object.keys(players);
    turnIndex = 0;
    direction = 1;
    penaltyStack = 0;
    activeSuit = null;

    if (resetTotalScores) {
        roundHistory = [];
        playerOrder.forEach(id => players[id].totalScore = 0);
    }
    
    playerOrder.forEach(id => {
        players[id].hand = [];
        players[id].hasDrawn = false;
    });

    let dealCount = 0;
    let dealInterval = setInterval(() => {
        playerOrder.forEach(id => {
            if (deck.length > 0) {
                players[id].hand.push(deck.pop());
                io.to(id).emit('receiveCard');
            }
        });
        dealCount++;
        if (dealCount === 11) {
            clearInterval(dealInterval);
            let first = deck.pop();
            discardPile = [first];
            io.emit('gameReady');
            io.emit('updateScoreboard', roundHistory);
            broadcastUpdate();
        }
    }, 100);
}

function handleRoundEnd(winnerId) {
    let roundResults = {};
    playerOrder.forEach(id => {
        if (id === winnerId) {
            roundResults[id] = "WC";
        } else {
            let points = calculateHandScore(players[id].hand);
            players[id].totalScore += points;
            roundResults[id] = players[id].totalScore;
        }
    });

    let historyEntry = {};
    playerOrder.forEach(id => {
        historyEntry[players[id].name] = roundResults[id];
    });
    roundHistory.push(historyEntry);

    io.emit('updateScoreboard', roundHistory);

    let loser = playerOrder.find(id => players[id].totalScore >= 500);
    
    if (loser) {
        gameStarted = false;
        let sortedPlayers = playerOrder.map(id => players[id]).sort((a,b) => a.totalScore - b.totalScore);
        io.emit('gameOver', sortedPlayers);
    } else {
        io.emit('notification', `Ο ${players[winnerId].name} κέρδισε τον γύρο!`);
        setTimeout(() => {
            startNewRound(false);
        }, 3000);
    }
}

function advanceTurn(steps) {
    turnIndex = (turnIndex + (direction * steps)) % playerOrder.length;
    if (turnIndex < 0) turnIndex += playerOrder.length;
    let nextPlayerId = playerOrder[turnIndex];
    if (players[nextPlayerId]) players[nextPlayerId].hasDrawn = false;
}

function broadcastUpdate() {
    playerOrder.forEach(id => {
        io.to(id).emit('updateUI', {
            ...getGameState(),
            myHand: players[id].hand,
            isMyTurn: (id === playerOrder[turnIndex]),
            activeSuit: activeSuit
        });
    });
}

function getGameState() {
    let safePlayers = [];
    Object.keys(players).forEach(id => {
        safePlayers.push({ id: id, name: players[id].name, handCount: players[id].hand.length });
    });
    return {
        players: safePlayers,
        topCard: discardPile.length > 0 ? discardPile[discardPile.length - 1] : null,
        penalty: penaltyStack
    };
}

function refillDeck() {
    if (discardPile.length <= 1) return;
    let top = discardPile.pop();
    deck = discardPile.sort(() => Math.random() - 0.5);
    discardPile = [top];
}

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('Server running on ' + port));
