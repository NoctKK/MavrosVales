const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- ΜΕΤΑΒΛΗΤΕΣ ΠΑΙΧΝΙΔΙΟΥ ---
let deck = [];
let discardPile = [];
let players = {}; 
let playerOrder = []; // Η σειρά των παικτών (IDs)
let turnIndex = 0;    // Ποιος παίζει τώρα (0, 1, 2...)
let direction = 1;    // 1 = Δεξιόστροφα, -1 = Αριστερόστροφα
let penaltyStack = 0; // Πόσα φύλλα πρέπει να τραβήξει ο επόμενος
let gameStarted = false;

// --- ΡΥΘΜΙΣΕΙΣ ---
function createDeck() {
    const suits = ['♠', '♣', '♥', '♦'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    let newDeck = [];
    // 2 Τράπουλες (104 φύλλα)
    for (let i = 0; i < 2; i++) {
        suits.forEach(s => values.forEach(v => {
            newDeck.push({ suit: s, value: v, color: (s === '♥' || s === '♦') ? 'red' : 'black' });
        }));
    }
    return newDeck.sort(() => Math.random() - 0.5);
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
    console.log('Παίκτης συνδέθηκε:', socket.id);

    // Δημιουργία Παίκτη
    players[socket.id] = { 
        id: socket.id, 
        hand: [], 
        name: "Παίκτης " + (Object.keys(players).length + 1) 
    };
    
    // Ενημέρωση όλων για τους παρόντες
    io.emit('updateUI', getGameState());

    // --- ΕΝΑΡΞΗ ΠΑΙΧΝΙΔΙΟΥ ---
    socket.on('startGameRequest', () => {
        if (gameStarted) return;
        gameStarted = true;
        deck = createDeck();
        playerOrder = Object.keys(players); // Κλειδώνει η σειρά
        turnIndex = 0;
        direction = 1;
        penaltyStack = 0;

        let dealCount = 0;
        // Μοίρασμα 11 φύλλων αργά
        let dealInterval = setInterval(() => {
            playerOrder.forEach(id => {
                if (deck.length > 0) {
                    let card = deck.pop();
                    players[id].hand.push(card);
                    io.to(id).emit('receiveCard', card); // Εφέ
                }
            });
            dealCount++;
            
            if (dealCount === 11) {
                clearInterval(dealInterval);
                // Πρώτο φύλλο κάτω
                let first = deck.pop();
                discardPile = [first];
                io.emit('gameReady'); // Κλείνει το Start Screen
                broadcastUpdate(); // Ενημερώνει το τραπέζι
            }
        }, 300);
    });

    // --- ΡΙΞΙΜΟ ΦΥΛΛΟΥ ---
    socket.on('playCard', (cardIndex) => {
        // 1. Έλεγχος Σειράς
        if (playerOrder[turnIndex] !== socket.id) return; 

        let player = players[socket.id];
        let card = player.hand[cardIndex];
        let topCard = discardPile[discardPile.length - 1];

        // 2. Έλεγχος Εγκυρότητας (Κανόνες)
        // Επιτρέπεται αν: Ίδιο Σχήμα OR Ίδιο Νούμερο OR Είναι Άσσος OR Είναι Κόκκινος Βαλές (ακυρωτικό)
        let isValid = (card.suit === topCard.suit) || 
                      (card.value === topCard.value) || 
                      (card.value === 'A') ||
                      (card.value === 'J' && card.color === 'red');

        // Ειδική περίπτωση: Αν υπάρχει ποινή (Μαύρος Βαλές), πρέπει να απαντήσεις με Βαλές
        if (penaltyStack > 0) {
             if (card.value !== 'J') isValid = false;
        }

        if (isValid) {
            // Αφαίρεση από το χέρι
            player.hand.splice(cardIndex, 1);
            discardPile.push(card);

            // Εφαρμογή Ειδικών Κανόνων
            if (card.value === 'J' && card.color === 'black') penaltyStack += 10;
            if (card.value === 'J' && card.color === 'red') penaltyStack = 0;
            if (card.value === '3') direction *= -1;
            if (card.value === '2') {
                // Ο προηγούμενος τραβάει 1 (απλοποιημένο: ο επόμενος χάνει σειρά ή παίρνει φύλλο - ας το κάνουμε να αλλάζει σειρά κανονικά)
            }

            // Αλλαγή Σειράς
            advanceTurn();
            broadcastUpdate();
        } else {
            // Λάθος κίνηση -> Ειδοποίηση
            socket.emit('invalidMove');
        }
    });

    // --- ΤΡΑΒΗΓΜΑ ΦΥΛΛΟΥ ---
    socket.on('drawCard', () => {
        if (playerOrder[turnIndex] !== socket.id) return; // Μόνο αν είναι η σειρά σου

        let player = players[socket.id];
        let cardsToTake = penaltyStack > 0 ? penaltyStack : 1;
        
        for (let i = 0; i < cardsToTake; i++) {
            if (deck.length === 0) refillDeck();
            player.hand.push(deck.pop());
        }
        
        penaltyStack = 0; // Η ποινή εκτελέστηκε
        // advanceTurn(); // Αν θέλεις να χάνει τη σειρά του μόλις τραβήξει, βγάλε τα σχόλια.
        // Αν θέλεις να μπορεί να παίξει το φύλλο που τράβηξε, άσε το σχολιασμένο (πρέπει να πατήσει ΠΑΣΟ).
        
        broadcastUpdate();
    });

    socket.on('passTurn', () => {
        if (playerOrder[turnIndex] !== socket.id) return;
        advanceTurn();
        broadcastUpdate();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        // Αν κάποιος φύγει, ξαναφτιάχνουμε τη σειρά
        playerOrder = Object.keys(players);
        turnIndex = 0;
        io.emit('updateUI', getGameState());
    });
});

// --- ΒΟΗΘΗΤΙΚΕΣ ΣΥΝΑΡΤΗΣΕΙΣ ---
function advanceTurn() {
    // Υπολογισμός επόμενου δείκτη με βάση τη φορά (direction)
    turnIndex = (turnIndex + direction + playerOrder.length) % playerOrder.length;
}

function broadcastUpdate() {
    // Στέλνει σε κάθε παίκτη τα δεδομένα που πρέπει να βλέπει
    playerOrder.forEach(id => {
        io.to(id).emit('updateUI', {
            ...getGameState(),
            myHand: players[id].hand,
            isMyTurn: (id === playerOrder[turnIndex])
        });
    });
}

function getGameState() {
    // Δεδομένα που βλέπουν όλοι (χωρίς τα κρυφά φύλλα των άλλων)
    let safePlayers = [];
    Object.keys(players).forEach(id => {
        safePlayers.push({
            id: id,
            name: players[id].name,
            handCount: players[id].hand.length,
            score: 0 // Θα το προσθέσουμε μετά
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

server.listen(3000, () => console.log('Server running on 3000'));
