const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Ρυθμίσεις CORS (για να συνδέονται οι φίλοι σου)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
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

// --- ΡΥΘΜΙΣΕΙΣ ---
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

// Υπολογισμός Πόντων (Α=11, Φιγούρες=10, Αριθμοί=Αξία)
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
        id: socket.id, hand: [], name: "Παίκτης " + (Object.keys(players).length + 1), score: 0
    };
    
    io.emit('playerCountUpdate', Object.keys(players).length);

    if (gameStarted) {
        socket.emit('updateUI', getGameState());
    }

    socket.on('startGameRequest', () => {
        if (gameStarted || Object.keys(players).length < 2) return;
        
        gameStarted = true;
        deck = createDeck();
        playerOrder = Object.keys(players);
        turnIndex = 0;
        direction = 1;
        penaltyStack = 0;
        activeSuit = null;
        
        // Reset scores
        playerOrder.forEach(id => players[id].score = 0);

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
                broadcastUpdate();
            }
        }, 200);
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
            if (penaltyType === '2' && card.value === '2') isValid = true; // Τα 2αρια αθροίζονται; (Συνήθως όχι, αλλά ας το αφήσουμε απλό)
            if (penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            // Κανονική Ροή
            if (card.value === 'A') isValid = true;
            else if (card.value === topCard.value) isValid = true;
            else if (card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red') isValid = true;
        }

        if (isValid) {
            // Αφαίρεση φύλλου
            p.hand.splice(data.index, 1);
            discardPile.push(card);

            // --- ΕΛΕΓΧΟΣ ΝΙΚΗΣ (ΤΕΛΟΣ ΠΑΙΧΝΙΔΙΟΥ) ---
            if (p.hand.length === 0) {
                gameStarted = false;
                // Υπολογισμός σκορ για όλους
                let results = [];
                playerOrder.forEach(id => {
                    let pts = calculateHandScore(players[id].hand);
                    players[id].score = pts; // Ο νικητής έχει 0
                    results.push({ name: players[id].name, score: pts, isWinner: id === socket.id });
                });
                
                io.emit('gameOver', results);
                return; // Σταματάμε εδώ
            }

            // Χρώμα Άσσου
            if (card.value === 'A') {
                activeSuit = declaredSuit ? declaredSuit : card.suit;
            } else {
                activeSuit = null;
            }

            let advance = true; 
            let steps = 1;

            // --- ΕΙΔΙΚΟΙ ΚΑΝΟΝΕΣ ---
            
            // Κανόνας 8: Ξαναπαίζει
            if (card.value === '8') { 
                advance = false; 
                io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); 
            }
            // Κανόνας 7: Ποινή +2
            else if (card.value === '7') { 
                penaltyStack += 2; 
                penaltyType = '7'; 
            }
            // Κανόνας 2: Ποινή +1 (Στον επόμενο)
            else if (card.value === '2') {
                penaltyStack += 1;
                penaltyType = '2'; // Ειδικός τύπος ποινής για το 2
            }
            // Κανόνας J (Μαύρος): Ποινή +10
            else if (card.value === 'J' && card.color === 'black') { 
                penaltyStack += 10; 
                penaltyType = 'J'; 
            }
            // Κανόνας J (Κόκκινος): Ακύρωση
            else if (card.value === 'J' && card.color === 'red') { 
                penaltyStack = 0; 
                penaltyType = null; 
            }
            // Κανόνας 3: Αλλαγή Φοράς
            else if (card.value === '3') { 
                if (playerOrder.length === 2) {
                    // Αν είναι 2 παίκτες, το 3 λειτουργεί σαν "ξαναπαίζεις"
                    advance = false;
                    io.to(socket.id).emit('notification', "Ξαναπαίζεις!");
                } else {
                    direction *= -1; // Αλλαγή φοράς
                }
            }
            // Κανόνας 9: Πηδάει παίκτη
            else if (card.value === '9') {
                 if (playerOrder.length === 2) { 
                     advance = false; 
                     io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); 
                 } else { 
                     steps = 2; 
                 }
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
        let count = penaltyStack > 0 ? penaltyStack : 1;
        
        for(let i=0; i<count; i++) {
            if(deck.length===0) refillDeck();
            if(deck.length > 0) p.hand.push(deck.pop());
        }

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
        if (gameStarted) {
             // Reset αν φύγει κάποιος για να μην κολλήσει
             gameStarted = false;
             io.emit('notification', "Ο παίκτης αποσυνδέθηκε. Το παιχνίδι έληξε.");
             setTimeout(() => io.emit('gameEndedForced'), 2000); // Reload
        }
    });
});

function advanceTurn(steps) {
    turnIndex = (turnIndex + (direction * steps)) % playerOrder.length;
    if (turnIndex < 0) turnIndex += playerOrder.length;
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
