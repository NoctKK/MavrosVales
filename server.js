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
let penaltyType = null; // '7' ή 'J' ή null
let gameStarted = false;

// --- ΔΗΜΙΟΥΡΓΙΑ ΤΡΑΠΟΥΛΑΣ ---
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
    players[socket.id] = {
        id: socket.id,
        hand: [],
        name: "Παίκτης " + (Object.keys(players).length + 1),
        score: 0
    };
    
    io.emit('updateUI', getGameState());

    socket.on('startGameRequest', () => {
        if (gameStarted) return;
        gameStarted = true;
        deck = createDeck();
        playerOrder = Object.keys(players);
        turnIndex = 0;
        direction = 1;
        penaltyStack = 0;
        penaltyType = null;
        
        let dealCount = 0;
        let dealInterval = setInterval(() => {
            playerOrder.forEach(id => {
                if (deck.length > 0) {
                    let card = deck.pop();
                    players[id].hand.push(card);
                    io.to(id).emit('receiveCard', card);
                }
            });
            dealCount++;
            if (dealCount === 11) {
                clearInterval(dealInterval);
                let first = deck.pop();
                // Αν το πρώτο φύλλο είναι ειδικό, το αγνοούμε για αρχή (απλοποίηση)
                discardPile = [first];
                io.emit('gameReady');
                broadcastUpdate();
            }
        }, 200);
    });

    socket.on('playCard', (cardIndex) => {
        if (playerOrder[turnIndex] !== socket.id) return;
        
        let p = players[socket.id];
        let card = p.hand[cardIndex];
        let topCard = discardPile[discardPile.length - 1];

        // --- ΕΛΕΓΧΟΣ ΕΓΚΥΡΟΤΗΤΑΣ ---
        let isValid = false;

        // 1. ΑΝ ΥΠΑΡΧΕΙ ΠΟΙΝΗ (Πρέπει να απαντήσεις)
        if (penaltyStack > 0) {
            if (penaltyType === '7') {
                // Αν η ποινή είναι από 7, πρέπει να ρίξεις 7
                if (card.value === '7') isValid = true;
            } else if (penaltyType === 'J') {
                // Αν η ποινή είναι από Βαλέ, πρέπει να ρίξεις Βαλέ (Μαύρο ή Κόκκινο)
                if (card.value === 'J') isValid = true;
            }
        } 
        // 2. ΚΑΝΟΝΙΚΗ ΡΟΗ (Χωρίς ποινή)
        else {
            if (card.value === topCard.value || card.suit === topCard.suit || card.value === 'A' || (card.value === 'J' && card.color === 'red')) {
                isValid = true;
            }
        }

        if (isValid) {
            // Ρίξιμο φύλλου
            p.hand.splice(cardIndex, 1);
            discardPile.push(card);

            let shouldAdvance = true; // Αν θα αλλάξει η σειρά
            let steps = 1;

            // --- ΕΙΔΙΚΟΙ ΚΑΝΟΝΕΣ ---

            // ΚΑΝΟΝΑΣ 8: Ξαναπαίζει (Δεν αλλάζει η σειρά)
            if (card.value === '8') {
                shouldAdvance = false; 
                // Ειδοποίηση ότι ξαναπαίζει
                io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); 
            }

            // ΚΑΝΟΝΑΣ 7: Ποινή +2
            else if (card.value === '7') {
                penaltyStack += 2;
                penaltyType = '7';
            }

            // ΚΑΝΟΝΑΣ 9: Πηδάει παίκτη
            else if (card.value === '9') {
                if (playerOrder.length === 2) {
                    // Στους 2 παίκτες, το 9 λειτουργεί σαν 8 (ξαναπαίζει ο ίδιος)
                    shouldAdvance = false; 
                    io.to(socket.id).emit('notification', "Ξαναπαίζεις (9)!");
                } else {
                    steps = 2; // Πηδάει τον επόμενο
                }
            }

            // ΚΑΝΟΝΑΣ J (Μαύρος): Ποινή +10
            else if (card.value === 'J' && card.color === 'black') {
                penaltyStack += 10;
                penaltyType = 'J';
            }

            // ΚΑΝΟΝΑΣ J (Κόκκινος): Ακύρωση Ποινής
            else if (card.value === 'J' && card.color === 'red') {
                penaltyStack = 0;
                penaltyType = null;
            }

            // ΚΑΝΟΝΑΣ 3: Αλλαγή Φοράς
            else if (card.value === '3') {
                direction *= -1;
            }

            // Αλλαγή Σειράς (Μόνο αν δεν είναι 8άρι ή 9άρι σε 2 παίκτες)
            if (shouldAdvance) {
                advanceTurn(steps);
            }

            broadcastUpdate();
        } else {
            socket.emit('invalidMove');
        }
    });

    socket.on('drawCard', () => {
        if (playerOrder[turnIndex] !== socket.id) return;
        
        let p = players[socket.id];
        
        // Αν υπάρχει ποινή, τραβάει πολλά. Αν όχι, τραβάει 1.
        let count = penaltyStack > 0 ? penaltyStack : 1;
        
        for(let i=0; i<count; i++) {
            if(deck.length===0) refillDeck();
            if(deck.length > 0) p.hand.push(deck.pop());
        }
        
        // Μηδενισμός ποινής μετά το τράβηγμα
        penaltyStack = 0;
        penaltyType = null;
        
        // Μετά το τράβηγμα, χάνει τη σειρά του (Απλοποίηση για να μην κολλάει)
        // Στην κανονική αγωνία αν τραβήξεις και βρεις, παίζεις. 
        // Εδώ για να μη γίνει περίπλοκο στο Web, μόλις τραβήξεις, παίζει ο επόμενος.
        advanceTurn(1);
        
        broadcastUpdate();
    });

    socket.on('passTurn', () => {
        if (playerOrder[turnIndex] !== socket.id) return;
        advanceTurn(1);
        broadcastUpdate();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        // Αν φύγει κάποιος εν ώρα παιχνιδιού, ίσως χρειαστεί restart
        io.emit('updateUI', getGameState());
    });
});

function advanceTurn(steps) {
    // Υπολογισμός με βάση τη φορά
    // Το steps καθορίζει αν πάμε στον επόμενο (1) ή μεθεπόμενο (2 - λόγω 9αριού)
    turnIndex = (turnIndex + (direction * steps)) % playerOrder.length;
    
    // Διόρθωση για αρνητικούς αριθμούς (όταν πάμε ανάποδα)
    if (turnIndex < 0) {
        turnIndex += playerOrder.length;
    }
}

function broadcastUpdate() {
    playerOrder.forEach(id => {
        io.to(id).emit('updateUI', {
            ...getGameState(),
            myHand: players[id].hand,
            isMyTurn: (id === playerOrder[turnIndex])
        });
    });
}

function getGameState() {
    let safePlayers = [];
    Object.keys(players).forEach(id => {
        safePlayers.push({
            id: id,
            name: players[id].name,
            handCount: players[id].hand.length
        });
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

// Προσοχή στη θύρα για Render/Glitch/Replit
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('Server running on port ' + port);
});
