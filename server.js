const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    // Δημιουργία παίκτη
    players[socket.id] = {
        id: socket.id, hand: [], name: "Παίκτης " + (Object.keys(players).length + 1)
    };
    
    // Ενημέρωση για το πόσοι είναι συνδεδεμένοι (Για την οθόνη έναρξης)
    io.emit('playerCountUpdate', Object.keys(players).length);

    if (gameStarted) {
        // Αν μπει κάποιος ενώ παίζουν, του στέλνουμε την κατάσταση
        socket.emit('updateUI', getGameState());
    }

    socket.on('startGameRequest', () => {
        if (gameStarted || Object.keys(players).length < 2) return; // Ασφάλεια
        
        gameStarted = true;
        deck = createDeck();
        playerOrder = Object.keys(players);
        turnIndex = 0;
        direction = 1;
        penaltyStack = 0;
        activeSuit = null;
        
        // Μοίρασμα
        let dealCount = 0;
        let dealInterval = setInterval(() => {
            playerOrder.forEach(id => {
                if (deck.length > 0) {
                    players[id].hand.push(deck.pop());
                    io.to(id).emit('receiveCard'); // Εφέ ήχου/κίνησης
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
        if (playerOrder[turnIndex] !== socket.id) return;
        
        let p = players[socket.id];
        let card = p.hand[data.index];
        let topCard = discardPile[discardPile.length - 1];
        let declaredSuit = data.declaredSuit;

        // --- ΕΛΕΓΧΟΣ ΕΓΚΥΡΟΤΗΤΑΣ ---
        let isValid = false;
        let effectiveSuit = activeSuit || topCard.suit; // Το χρώμα που ισχύει

        // Αν έχουμε ποινή (7 ή J)
        if (penaltyStack > 0) {
            if (penaltyType === '7' && card.value === '7') isValid = true;
            if (penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            // Κανονική ροή
            if (card.value === 'A') isValid = true; // Ο Άσσος πέφτει πάντα
            else if (card.value === topCard.value) isValid = true; // Ίδιο νούμερο
            else if (card.suit === effectiveSuit) isValid = true; // Ίδιο χρώμα (ή δηλωμένο)
            else if (card.value === 'J' && card.color === 'red') isValid = true; // Ακυρωτικός
        }

        if (isValid) {
            p.hand.splice(data.index, 1);
            discardPile.push(card);

            // Διαχείριση Άσσου
            if (card.value === 'A') {
                activeSuit = declaredSuit ? declaredSuit : card.suit;
            } else {
                activeSuit = null; // Reset αν δεν είναι Άσσος
            }

            let advance = true; 
            let steps = 1;

            // ΚΑΝΟΝΕΣ
            if (card.value === '8') { 
                advance = false; 
                io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); 
            }
            else if (card.value === '7') { penaltyStack += 2; penaltyType = '7'; }
            else if (card.value === 'J' && card.color === 'black') { penaltyStack += 10; penaltyType = 'J'; }
            else if (card.value === 'J' && card.color === 'red') { penaltyStack = 0; penaltyType = null; }
            else if (card.value === '3') { direction *= -1; }
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
        if (playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id];
        let count = penaltyStack > 0 ? penaltyStack : 1;
        
        for(let i=0; i<count; i++) {
            if(deck.length===0) refillDeck();
            if(deck.length > 0) p.hand.push(deck.pop());
        }

        // ΣΗΜΑΝΤΙΚΟ: Μηδενισμός ποινής
        let wasPenalty = penaltyStack > 0;
        penaltyStack = 0;
        penaltyType = null;
        
        io.to(socket.id).emit('notification', `Τράβηξες ${count} φύλλα!`);
        
        // Αν τράβηξε λόγω ποινής (7άρι), ΔΕΝ χάνει τη σειρά του (advance = false)
        // Αν τράβηξε μόνος του (πάσο), επίσης δεν χάνει τη σειρά του μέχρι να πατήσει ΠΑΣΟ.
        broadcastUpdate();
    });

    socket.on('passTurn', () => {
        if (playerOrder[turnIndex] !== socket.id) return;
        if (penaltyStack > 0) return; // Δεν μπορείς να πας πάσο αν χρωστάς φύλλα
        
        advanceTurn(1);
        broadcastUpdate();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerCountUpdate', Object.keys(players).length);
        // Αν φύγει παίκτης, ίσως χρειαστεί reset, αλλά για τώρα το αφήνουμε απλό
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
