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
let roundStarterIndex = 0; // Ποιος ξεκινάει τον γύρο

// Keep Alive
app.get('/ping', (req, res) => res.send('pong'));

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
        if (c.value === 'A') score += 50;
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
        roundStarterIndex = 0; // Reset σειράς εκκίνησης
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

        // Έλεγχος Ποινής
        if (penaltyStack > 0) {
            if (penaltyType === '7' && card.value === '7') isValid = true;
            if (penaltyType === 'J' && card.value === 'J') isValid = true;
            // Το 2αρι δεν απαντάει σε ποινές πλέον
        } else {
            // --- ΚΑΝΟΝΕΣ VALIDATION ---
            
            // 1. Βαλές: ΔΕΝ ΕΙΝΑΙ ΜΠΑΛΑΝΤΕΡ ΠΙΑ. Πρέπει να ταιριάζει χρώμα ή αξία.
            // 2. Άσσος πάνω σε Άσσο: Πρέπει να έχει ίδιο χρώμα.
            
            if (card.value === 'A' && topCard.value === 'A') {
                if (card.suit === topCard.suit) isValid = true;
            }
            else if (card.value === topCard.value) isValid = true; // Ίδιος αριθμός/φιγούρα
            else if (card.suit === effectiveSuit) isValid = true; // Ίδιο χρώμα
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true; // Κόκκινος Βαλές σε Βαλέ
        }

        if (isValid) {
            p.hand.splice(data.index, 1);
            discardPile.push(card);

            // Έλεγχος αν βγήκε
            if (p.hand.length === 0) {
                if (card.value === 'J') {
                    let nextIdx = (turnIndex + direction + playerOrder.length) % playerOrder.length;
                    let victimId = playerOrder[nextIdx];
                    for(let i=0; i<10; i++) {
                        if(deck.length===0) refillDeck();
                        if(deck.length>0) players[victimId].hand.push(deck.pop());
                    }
                    io.to(victimId).emit('notification', "Ο αντίπαλος έκλεισε με Βαλέ! Έφαγες 10 κάρτες!");
                }
                handleRoundEnd(socket.id);
                return;
            }

            // --- ΛΟΓΙΚΗ ΑΣΣΟΥ ---
            if (card.value === 'A') {
                if (topCard.value === 'A') activeSuit = null; 
                else activeSuit = declaredSuit ? declaredSuit : card.suit;
            } else {
                activeSuit = null;
            }

            let advance = true; 
            let steps = 1;

            // --- ΕΙΔΙΚΟΙ ΚΑΝΟΝΕΣ ---
            if (card.value === '8') { advance = false; io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); }
            else if (card.value === '7') { penaltyStack += 2; penaltyType = '7'; }
            else if (card.value === 'J' && card.color === 'black') { penaltyStack += 10; penaltyType = 'J'; }
            else if (card.value === 'J' && card.color === 'red') { penaltyStack = 0; penaltyType = null; }
            
            // ΚΑΝΟΝΑΣ 2: Ο Προηγούμενος παίρνει μία κάρτα
            else if (card.value === '2') {
                let prevIdx = (turnIndex - direction + playerOrder.length) % playerOrder.length;
                let prevId = playerOrder[prevIdx];
                
                if (deck.length === 0) refillDeck();
                if (deck.length > 0) {
                    players[prevId].hand.push(deck.pop());
                    io.to(prevId).emit('notification', "Ο επόμενος έριξε 2! Τραβάς 1 κάρτα!");
                    io.to(prevId).emit('updateUI', { ...getGameState(), myHand: players[prevId].hand }); // Update only victim
                }
                // Δεν σταματάει η ροή, συνεχίζει στον επόμενο
            }
            
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
        
        // Αν δεν υπάρχει ποινή και έχει ήδη τραβήξει μια φορά (χωρίς να έχει προηγηθεί ποινή), στοπ.
        // ΑΛΛΑΓΗ: Αν μόλις έφαγε ποινή, του επιτρέπουμε να τραβήξει άλλη μία αν θέλει.
        // Οπότε ελέγχουμε το hasDrawn μόνο αν το penaltyStack είναι 0.
        
        if (penaltyStack === 0 && p.hasDrawn) {
            io.to(socket.id).emit('notification', "Έχεις ήδη τραβήξει! Παίξε ή Πάσο.");
            return;
        }

        let count = penaltyStack > 0 ? penaltyStack : 1;
        let drawnCards = 0;
        
        for(let i=0; i<count; i++) {
            if(deck.length===0) refillDeck();
            if(deck.length > 0) {
                p.hand.push(deck.pop());
                drawnCards++;
            }
        }

        // Αν τράβηξε λόγω ποινής, μηδενίζουμε το flag hasDrawn ώστε να μπορεί να τραβήξει άλλη μία αν θέλει
        if (penaltyStack > 0) {
            p.hasDrawn = false; 
        } else {
            p.hasDrawn = true; // Τράβηξε κανονική κάρτα
        }

        penaltyStack = 0;
        penaltyType = null;
        
        io.to(socket.id).emit('notification', `Τράβηξες ${drawnCards} φύλλα!`);
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
    
    // Rotation: Ξεκινάει ο επόμενος στη σειρά
    turnIndex = roundStarterIndex % playerOrder.length;
    roundStarterIndex++; // Αυξάνουμε για τον μεθεπόμενο γύρο

    direction = 1;
    penaltyStack = 0;
    activeSuit = null;

    if (resetTotalScores) {
        roundHistory = [];
        playerOrder.forEach(id => players[id].totalScore = 0);
        roundStarterIndex = 1; // Reset
        turnIndex = 0;
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
            io.to(id).emit('roundResultMsg', "Πάνε τουαλέτα 🚽");
        } else {
            let points = calculateHandScore(players[id].hand);
            players[id].totalScore += points;
            roundResults[id] = players[id].totalScore;
            io.to(id).emit('roundResultMsg', `Έγραψες ${points} πόντους`);
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
        setTimeout(() => startNewRound(false), 4000);
    }
}

function advanceTurn(steps) {
    turnIndex = (turnIndex + (direction * steps)) % playerOrder.length;
    if (turnIndex < 0) turnIndex += playerOrder.length;
    let nextPlayerId = playerOrder[turnIndex];
    if (players[nextPlayerId]) players[nextPlayerId].hasDrawn = false;
}

function broadcastUpdate() {
    // Βρίσκουμε το όνομα του τρέχοντος παίκτη για να το στείλουμε σε όλους
    let currentPlayerName = players[playerOrder[turnIndex]].name;

    playerOrder.forEach(id => {
        io.to(id).emit('updateUI', {
            ...getGameState(),
            myHand: players[id].hand,
            isMyTurn: (id === playerOrder[turnIndex]),
            currentPlayerName: currentPlayerName, // Στέλνουμε το όνομα
            activeSuit: activeSuit,
            deckCount: deck.length // Στέλνουμε πόσα φύλλα έμειναν
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
        penalty: penaltyStack,
        penaltyType: penaltyType,
        direction: direction // Στέλνουμε τη φορά
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
