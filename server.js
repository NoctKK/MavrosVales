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
let roundStarterIndex = 0;

// Keep Alive
app.get('/ping', (req, res) => res.send('pong'));

// --- ΣΥΝΑΡΤΗΣΕΙΣ ---
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
        if (c.value === 'A') score += 50;
        else if (['K', 'Q', 'J'].includes(c.value)) score += 10;
        else score += parseInt(c.value);
    });
    return score;
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    
    // ΕΔΩ ΗΤΑΝ ΤΟ ΠΡΟΒΛΗΜΑ: Τώρα δεχόμαστε αντικείμενο data
    socket.on('joinGame', (data) => {
        let username, sessionId;

        // Έλεγχος ασφαλείας για να μην κολλάει αν λάβει λάθος μορφή
        if (typeof data === 'object' && data !== null) {
            username = data.username;
            sessionId = data.sessionId;
        } else {
            username = data; // Για συμβατότητα με παλιά έκδοση
            sessionId = null;
        }

        // 1. Reconnection Logic
        let existingPlayerId = Object.keys(players).find(id => players[id].sessionId === sessionId && sessionId !== null);

        if (existingPlayerId) {
            console.log(`Player reconnected: ${username}`);
            
            players[socket.id] = players[existingPlayerId];
            players[socket.id].id = socket.id;
            players[socket.id].connected = true;

            let orderIdx = playerOrder.indexOf(existingPlayerId);
            if (orderIdx !== -1) playerOrder[orderIdx] = socket.id;

            if (existingPlayerId !== socket.id) delete players[existingPlayerId];

            socket.emit('rejoinSuccess', { 
                gameStarted: gameStarted,
                myHand: players[socket.id].hand 
            });

            io.emit('playerCountUpdate', Object.keys(players).length);
            if (gameStarted) broadcastUpdate();

        } else {
            // New Player Logic
            if (gameStarted) {
                socket.emit('notification', 'Το παιχνίδι τρέχει ήδη!');
                return;
            }

            let cleanName = (username && typeof username === 'string' && username.trim() !== "") ? username.trim() : "Παίκτης " + (Object.keys(players).length + 1);
            
            if (cleanName.toLowerCase() === "δήμητρα" || cleanName.toLowerCase() === "δημητρα" || 
                cleanName.toLowerCase() === "δημητρούλα" || cleanName.toLowerCase() === "δημητρουλα") {
                cleanName += " ❤️";
            }

            players[socket.id] = {
                id: socket.id, 
                sessionId: sessionId, 
                hand: [], 
                name: cleanName, 
                totalScore: 0, 
                hats: 0, 
                hasDrawn: false,
                connected: true
            };
            
            io.emit('playerCountUpdate', Object.keys(players).length);
        }
    });

    socket.on('startGameRequest', () => {
        if (gameStarted || Object.keys(players).length < 2) return;
        roundStarterIndex = 0;
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
            if (penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            if (card.value === 'A' && topCard.value === 'A') {
                if (card.suit === topCard.suit) isValid = true;
            }
            else if (card.value === 'A') isValid = true;
            else if (card.value === topCard.value) isValid = true;
            else if (card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true;
        }

        if (isValid) {
            p.hand.splice(data.index, 1);
            discardPile.push(card);

            if (p.hand.length === 0) {
                if (card.value === 'J') {
                    let nextIdx = (turnIndex + direction + playerOrder.length) % playerOrder.length;
                    let victimId = playerOrder[nextIdx];
                    for(let i=0; i<10; i++) {
                        if(deck.length===0) refillDeck();
                        if(deck.length>0) players[victimId].hand.push(deck.pop());
                    }
                    io.to(victimId).emit('notification', 'Ο αντίπαλος έκλεισε με Βαλέ! +10 κάρτες!');
                }
                handleRoundEnd(socket.id, card.value === 'A');
                return;
            }

            if (card.value === 'A') {
                if (topCard.value === 'A' && card.suit === topCard.suit) {
                } else {
                    activeSuit = declaredSuit ? declaredSuit : card.suit;
                }
            } else {
                activeSuit = null;
            }

            processCardLogic(card, p);
            broadcastUpdate();
        } else {
            socket.emit('invalidMove');
        }
    });

    socket.on('drawCard', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id];
        
        if (penaltyStack === 0 && p.hasDrawn) {
            socket.emit('notification', 'Έχεις ήδη τραβήξει! Παίξε ή Πάσο.');
            return;
        }

        let count = penaltyStack > 0 ? penaltyStack : 1;
        let drawnCount = 0;
        for(let i=0; i<count; i++) {
            if(deck.length===0) refillDeck();
            if(deck.length > 0) {
                p.hand.push(deck.pop());
                drawnCount++;
            }
        }
        
        if (penaltyStack > 0) {
            p.hasDrawn = false; 
            io.to(socket.id).emit('notification', `Έφαγες ${drawnCount} κάρτες!`);
        } else {
            p.hasDrawn = true;
        }

        penaltyStack = 0;
        penaltyType = null;
        broadcastUpdate();
    });

    socket.on('passTurn', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        if (penaltyStack > 0) return;

        let p = players[socket.id];
        if (!p.hasDrawn) {
            socket.emit('notification', 'Πρέπει να τραβήξεις κάρτα πριν πας πάσο!');
            return;
        }

        advanceTurn(1);
        broadcastUpdate();
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            players[socket.id].connected = false; 
            if (!gameStarted) {
                delete players[socket.id];
                io.emit('playerCountUpdate', Object.keys(players).length);
            } 
        }
    });
});

function processCardLogic(card, currentPlayer) {
    let advance = true; 
    let steps = 1;
    const isStartOfGame = (!currentPlayer || !currentPlayer.id);

    if (card.value === '8') { 
        advance = false; 
        if (!isStartOfGame) {
            currentPlayer.hasDrawn = false; 
            io.to(currentPlayer.id).emit('notification', 'Έριξες 8! Ξαναπαίζεις (ή τραβάς)!');
        }
    }
    else if (card.value === '7') { penaltyStack += 2; penaltyType = '7'; }
    else if (card.value === 'J' && card.color === 'black') { penaltyStack += 10; penaltyType = 'J'; }
    else if (card.value === 'J' && card.color === 'red') { penaltyStack = 0; penaltyType = null; }
    else if (card.value === '2') {
        let prevIdx = (turnIndex - direction + playerOrder.length) % playerOrder.length;
        let victimId = playerOrder[prevIdx];
        if (!isStartOfGame) {
            if (deck.length === 0) refillDeck();
            if (deck.length > 0) {
                players[victimId].hand.push(deck.pop());
                io.to(victimId).emit('notification', 'Ο παίκτης έριξε 2! Πήρες 1 κάρτα.');
            }
        }
    }
    else if (card.value === '3') { 
        if (playerOrder.length === 2) {
            advance = false; 
            if (!isStartOfGame) {
                currentPlayer.hasDrawn = false; 
                io.to(currentPlayer.id).emit('notification', 'Έριξες 3! Ξαναπαίζεις!');
            }
        }
        else direction *= -1; 
    }
    else if (card.value === '9') {
         if (playerOrder.length === 2) {
             advance = false; 
             if (!isStartOfGame) {
                currentPlayer.hasDrawn = false; 
                io.to(currentPlayer.id).emit('notification', 'Έριξες 9! Ξαναπαίζεις!');
             }
         }
         else steps = 2; 
    }

    if (advance) advanceTurn(steps);
}

function startNewRound(resetTotalScores = false) {
    gameStarted = true;
    deck = createDeck();
    playerOrder = Object.keys(players);
    turnIndex = roundStarterIndex % playerOrder.length;
    roundStarterIndex++;
    direction = 1; penaltyStack = 0; activeSuit = null;

    if (resetTotalScores) {
        roundHistory = [];
        playerOrder.forEach(id => {
            players[id].totalScore = 0;
            players[id].hats = 0; 
        });
        roundStarterIndex = 1;
        turnIndex = 0;
    }
    
    playerOrder.forEach(id => {
        players[id].hand = [];
        players[id].hasDrawn = false;
    });

    let dealCount = 0;
    let dealInterval = setInterval(() => {
        playerOrder.forEach(id => { if (deck.length > 0) players[id].hand.push(deck.pop()); });
        dealCount++;
        if (dealCount === 11) {
            clearInterval(dealInterval);
            let first;
            do {
                if(first) deck.unshift(first);
                deck = deck.sort(() => Math.random() - 0.5);
                first = deck.pop();
            } while (first.value === 'J' && first.color === 'black');
            
            discardPile = [first];
            io.emit('gameReady');
            processCardLogic(first, null);
            broadcastUpdate();
        }
    }, 50);
}

function handleRoundEnd(winnerId, closedWithAce) {
    let historyEntry = {};
    let burnedPlayers = [];

    playerOrder.forEach(id => {
        if (id === winnerId) {
            historyEntry[players[id].name] = "WC";
            io.to(id).emit('roundResultMsg', "Πάνε τουαλέτα 🚽");
        } else {
            let points = calculateHandScore(players[id].hand);
            if (closedWithAce) points += 50; 
            players[id].totalScore += points;
            historyEntry[players[id].name] = players[id].totalScore;
            io.to(id).emit('roundResultMsg', `Έγραψες ${points} πόντους`);
        }
    });

    let safeScores = playerOrder.map(id => players[id].totalScore).filter(score => score < 500);
    let targetScore = safeScores.length > 0 ? Math.max(...safeScores) : 0;

    playerOrder.forEach(id => {
        if (players[id].totalScore >= 500) {
            players[id].hats += 1;
            players[id].totalScore = targetScore; 
            burnedPlayers.push(players[id].name);
        }
    });

    roundHistory.push(historyEntry);
    io.emit('updateScoreboard', roundHistory);
    
    if (burnedPlayers.length > 0) {
        let msg = burnedPlayers.join(", ") + " κάηκε/αν και πήρε/αν Καπέλο 🎩!";
        io.emit('notification', msg);
    }

    setTimeout(() => startNewRound(false), 2000);
}

function advanceTurn(steps) {
    turnIndex = (turnIndex + (direction * steps)) % playerOrder.length;
    if (turnIndex < 0) turnIndex += playerOrder.length;
    playerOrder.forEach(id => players[id].hasDrawn = false);
}

function broadcastUpdate() {
    let currentPlayer = players[playerOrder[turnIndex]];
    let currentPlayerName = currentPlayer ? currentPlayer.name : "...";
    
    playerOrder.forEach(id => {
        io.to(id).emit('updateUI', {
            players: playerOrder.map(pid => ({ 
                id: pid, 
                name: players[pid].name, 
                handCount: players[pid].hand.length,
                hats: players[pid].hats, 
                totalScore: players[pid].totalScore,
                connected: players[pid].connected 
            })),
            topCard: discardPile[discardPile.length - 1],
            penalty: penaltyStack,
            penaltyType: penaltyType,
            direction: direction,
            myHand: players[id].hand,
            isMyTurn: (id === playerOrder[turnIndex]),
            currentPlayerName: currentPlayerName,
            activeSuit: activeSuit,
            deckCount: deck.length
        });
    });
}

function getGameState() {
    let safePlayers = [];
    Object.keys(players).forEach(id => {
        safePlayers.push({ 
            id: id, 
            name: players[id].name, 
            handCount: players[id].hand.length,
            hats: players[id].hats,
            totalScore: players[id].totalScore
        });
    });
    return {
        players: safePlayers,
        topCard: discardPile.length > 0 ? discardPile[discardPile.length - 1] : null,
        penalty: penaltyStack,
        penaltyType: penaltyType,
        direction: direction
    };
}

function refillDeck() {
    let top = discardPile.pop();
    deck = discardPile.sort(() => Math.random() - 0.5);
    discardPile = [top];
}

const port = process.env.PORT || 3000;
server.listen(port, () => console.log('Server running on ' + port));
