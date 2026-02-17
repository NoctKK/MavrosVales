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
let penaltyType = null; // '7' ή 'J'
let activeSuit = null; // Το χρώμα που δήλωσε ο Άσσος
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
    players[socket.id] = {
        id: socket.id, hand: [], name: "Παίκτης " + (Object.keys(players).length + 1)
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
        activeSuit = null;
        
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

    // --- PLAY CARD (Δέχεται και declaredSuit για τον Άσσο) ---
    socket.on('playCard', (data) => {
        if (playerOrder[turnIndex] !== socket.id) return;
        
        let p = players[socket.id];
        let cardIndex = data.index;
        let declaredSuit = data.declaredSuit; // Αν είναι Άσσος, εδώ έχει το χρώμα
        let card = p.hand[cardIndex];
        let topCard = discardPile[discardPile.length - 1];

        // --- ΕΛΕΓΧΟΣ ΕΓΚΥΡΟΤΗΤΑΣ ---
        let isValid = false;
        
        // Έλεγχος βάσει του "Δηλωμένου Χρώματος" (αν υπάρχει από προηγούμενο Άσσο)
        let effectiveSuit = activeSuit || topCard.suit;

        // 1. ΑΝ ΕΧΟΥΜΕ ΠΟΙΝΗ
        if (penaltyStack > 0) {
            if (penaltyType === '7' && card.value === '7') isValid = true;
            if (penaltyType === 'J' && card.value === 'J') isValid = true;
        } 
        // 2. ΚΑΝΟΝΙΚΗ ΡΟΗ
        else {
            if (card.value === 'A') {
                // Ο Άσσος παίζεται πάντα, ΑΡΚΕΙ να ταιριάζει με το προηγούμενο χρώμα (ή δηλωμένο χρώμα)
                // Ο χρήστης είπε: "παίζει άσσο καρδούλα πάνω σε 4 καρδούλα".
                // Άρα ελέγχουμε αν το suit του Άσσου ταιριάζει με το effectiveSuit
                // Ή αν θέλει να τον παίξει ως μπαλαντέρ αλλαγής (που συνήθως επιτρέπεται).
                // Στην Αγωνία συνήθως ο Άσσος πέφτει πάντα. Ας το αφήσουμε ελεύθερο εκτός αν υπάρχει ειδικός περιορισμός.
                isValid = true;
            } else if (card.value === topCard.value || card.suit === effectiveSuit || (card.value === 'J' && card.color === 'red')) {
                isValid = true;
            }
        }

        if (isValid) {
            p.hand.splice(cardIndex, 1);
            discardPile.push(card);

            // Διαχείριση Άσσου
            if (card.value === 'A') {
                if (declaredSuit) {
                    activeSuit = declaredSuit; // Ο παίκτης διάλεξε νέο χρώμα
                } else {
                    activeSuit = card.suit; // Ο παίκτης τον έπαιξε "σκέτο", άρα το χρώμα είναι αυτό του Άσσου
                }
            } else {
                activeSuit = null; // Κάθε άλλο φύλλο σβήνει την επιλογή του Άσσου
            }

            let shouldAdvance = true; 
            let steps = 1;

            // ΚΑΝΟΝΕΣ
            if (card.value === '8') { shouldAdvance = false; io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); }
            else if (card.value === '7') { penaltyStack += 2; penaltyType = '7'; }
            else if (card.value === 'J' && card.color === 'black') { penaltyStack += 10; penaltyType = 'J'; }
            else if (card.value === 'J' && card.color === 'red') { penaltyStack = 0; penaltyType = null; }
            else if (card.value === '3') { direction *= -1; }
            else if (card.value === '9') {
                 if (playerOrder.length === 2) { shouldAdvance = false; io.to(socket.id).emit('notification', "Ξαναπαίζεις!"); }
                 else { steps = 2; }
            }

            if (shouldAdvance) advanceTurn(steps);
            broadcastUpdate();
        } else {
            socket.emit('invalidMove');
        }
    });

    // --- DRAW CARD (ΤΡΑΒΗΓΜΑ) ---
    socket.on('drawCard', () => {
        if (playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id];
        
        let count = penaltyStack > 0 ? penaltyStack : 1;
        
        for(let i=0; i<count; i++) {
            if(deck.length===0) refillDeck();
            if(deck.length > 0) p.hand.push(deck.pop());
        }

        // ΑΛΛΑΓΗ: Αν τράβηξε λόγω ποινής, ΔΕΝ χάνει τη σειρά του (μπορεί να παίξει)
        // Αν τράβηξε μόνος του (count=1), πάλι έχει δικαίωμα να παίξει στην αγωνία.
        // Οπότε απλά μηδενίζουμε την ποινή και ΔΕΝ καλούμε advanceTurn.
        
        penaltyStack = 0;
        penaltyType = null;
        
        io.to(socket.id).emit('notification', `Τράβηξες ${count} φύλλα!`);
        broadcastUpdate();
    });

    // --- PASS (ΠΑΣΟ) ---
    // Αυτό χρειάζεται τώρα, γιατί αφού τραβήξεις, πρέπει να πατήσεις ΠΑΣΟ αν δεν έχεις να παίξεις
    socket.on('passTurn', () => {
        if (playerOrder[turnIndex] !== socket.id) return;
        advanceTurn(1);
        broadcastUpdate();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('updateUI', getGameState());
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
            activeSuit: activeSuit // Στέλνουμε το χρώμα που ζητάει ο Άσσος
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

server.listen(3000, () => console.log('Server running on 3000'));
