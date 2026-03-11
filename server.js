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
    hand.filter(c => c && c.value).forEach(c => {
        if (c.value === 'A') score += 50;
        else if (['K', 'Q', 'J'].includes(c.value)) score += 10;
        else score += parseInt(c.value);
@@ -64,6 +64,10 @@
            if (["δήμητρα", "δημητρα", "δημητρούλα", "δημητρουλα"].includes(cleanName.toLowerCase())) cleanName += " ❤️";

            players[socket.id] = { id: socket.id, sessionId: sessionId, hand: [], name: cleanName, totalScore: 0, hats: 0, hasDrawn: false, connected: true };
            
            // ΣΗΜΑΝΤΙΚΟ: Αποθήκευση της σειράς αυστηρά!
            if (!playerOrder.includes(socket.id)) playerOrder.push(socket.id);
            
            io.emit('playerCountUpdate', Object.keys(players).length);
            socket.emit('joinedLobby');
        }
@@ -74,31 +78,34 @@
        if (p) io.emit('chatUpdate', { name: p.name, text: msg });
    });

    socket.on('startGameRequest', () => { if (!gameStarted && Object.keys(players).length >= 2) startNewRound(true); });
    socket.on('startGameRequest', () => { if (!gameStarted && playerOrder.length >= 2) startNewRound(true); });

    socket.on('playCard', (data) => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id], card = p.hand[data.index], topCard = discardPile[discardPile.length - 1];
        
        let p = players[socket.id];
        let card = p.hand[data.index];
        if (!card) return;

        let topCard = discardPile[discardPile.length - 1];
        let effectiveSuit = activeSuit || topCard.suit, isValid = false;

        // Βασικοί Κανόνες & Ο Νέος Κανόνας του Άσσου
        if (penaltyStack > 0) {
            if (penaltyType === '7' && card.value === '7') isValid = true;
            if (penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            if (card.value === 'A') {
                if (activeSuit) { // Αν υπάρχει ενεργό σχέδιο από προηγούμενο Άσσο, ΠΡΕΠΕΙ να ταιριάζει
                if (activeSuit) { 
                    if (card.suit === activeSuit) isValid = true; 
                } else {
                    isValid = true; // Αν δεν υπάρχει περιορισμός, πέφτει παντού
                    isValid = true; 
                }
            }
            else if (card.value === topCard.value || card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true;
        }

        if (isValid) {
            // --- ΛΟΓΙΚΗ COPY PASTE & ERASED ---
            let isSpecial = ['7', '8', 'J'].includes(card.value);
            let top1 = discardPile[discardPile.length - 1];
            let top2 = discardPile.length >= 2 ? discardPile[discardPile.length - 2] : null;
@@ -110,35 +117,32 @@
                    io.emit('notification', 'Copy erased! ❌');
                }
            }
            // ----------------------------------

            p.hand.splice(data.index, 1); 
            discardPile.push(card);

            // Έλεγχος: Αν έκλεισε με 8 τραβάει υποχρεωτικά
            if (p.hand.length === 0 && card.value === '8') {
                if (deck.length === 0) refillDeck();
                if (deck.length > 0) p.hand.push(deck.pop());
                io.emit('notification', `${p.name}: Έκλεισε με 8 και τραβάει αναγκαστικά 1 κάρτα!`);
            } 
            // Έλεγχος: Κανονικό κλείσιμο
            else if (p.hand.length === 0) {
                let isPenalty = false;
                let victimId = playerOrder[(turnIndex + direction + playerOrder.length) % playerOrder.length];

                if (card.value === 'J' && card.color === 'black') {
                    for(let i=0; i<10; i++) {
                        if(deck.length===0) refillDeck();
                        players[victimId].hand.push(deck.pop());
                        if(deck.length === 0) refillDeck();
                        if(deck.length > 0) players[victimId].hand.push(deck.pop());
                    }
                    io.emit('notification', `Ο/Η ${p.name} έκλεισε με Μαύρο Βαλέ! +10 στον/στην ${players[victimId].name}!`);
                    isPenalty = true;
                } else if (card.value === '7') {
                    penaltyStack += 2;
                    let drawn = 0;
                    for(let i=0; i<penaltyStack; i++) {
                        if(deck.length===0) refillDeck();
                        if(deck.length>0) { players[victimId].hand.push(deck.pop()); drawn++; }
                        if(deck.length === 0) refillDeck();
                        if(deck.length > 0) { players[victimId].hand.push(deck.pop()); drawn++; }
                    }
                    io.emit('notification', `Ο/Η ${p.name} έκλεισε με 7! +${drawn} στον/στην ${players[victimId].name}!`);
                    penaltyStack = 0; penaltyType = null;
@@ -149,16 +153,16 @@
                else activeSuit = null;

                broadcastUpdate(); 
                setTimeout(() => { handleRoundEnd(socket.id, card.value === 'A'); }, isPenalty ? 3500 : 1500);
                
                // ΚΑΘΥΣΤΕΡΗΣΗ 1 SEC ΓΙΑ ΚΑΝΟΝΙΚΟ ΤΕΛΟΣ, 3.5 SEC ΓΙΑ ΠΟΙΝΗ
                setTimeout(() => { handleRoundEnd(socket.id, card.value === 'A'); }, isPenalty ? 3500 : 1000);
                return;
            }

            // Μία μία
            if (p.hand.length === 1) {
                io.emit('notification', `${p.name}: Μία μία μία μία! ⚠️`);
            }

            // Άσσος χάνει την ιδιότητα του αν πέσει πάνω σε απαιτούμενο σχέδιο
            if (card.value === 'A') {
                if (activeSuit) activeSuit = null; 
                else activeSuit = data.declaredSuit || card.suit;
@@ -176,15 +180,43 @@
    socket.on('drawCard', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id];
        if (penaltyStack === 0 && p.hasDrawn) return socket.emit('notification', 'Έχεις ήδη τραβήξει!');
        
        if (penaltyStack === 0 && p.hasDrawn) {
            socket.emit('notification', 'Έχεις ήδη τραβήξει! Παίξε ή Πάσο.');
            return;
        }

        let count = penaltyStack > 0 ? penaltyStack : 1;
        for(let i=0; i<count; i++) { if(deck.length===0) refillDeck(); p.hand.push(deck.pop()); }
        p.hasDrawn = (penaltyStack === 0); penaltyStack = 0; penaltyType = null;
        let drawnCount = 0;
        for(let i=0; i<count; i++) { 
            if(deck.length === 0) refillDeck(); 
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

        penaltyStack = 0; penaltyType = null;
        broadcastUpdate();
    });

    socket.on('passTurn', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id || penaltyStack > 0 || !players[socket.id].hasDrawn) return;
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        if (penaltyStack > 0) return;

        let p = players[socket.id];
        if (!p.hasDrawn) {
            socket.emit('notification', 'Πρέπει να τραβήξεις κάρτα πριν πας πάσο!');
            return;
        }

        advanceTurn(1); broadcastUpdate();
    });

@@ -193,6 +225,7 @@
            players[socket.id].connected = false; 
            if (!gameStarted) {
                delete players[socket.id];
                playerOrder = playerOrder.filter(id => id !== socket.id);
                io.emit('playerCountUpdate', Object.keys(players).length);
            } 
        }
@@ -206,7 +239,8 @@
        if (consecutiveTwos >= 3) { io.emit('notification', 'Ξες πώς πάνε αυτά! 😂'); consecutiveTwos = 0; }
        if (!isStart) {
            let victimId = playerOrder[(turnIndex - direction + playerOrder.length) % playerOrder.length];
            if(deck.length === 0) refillDeck(); players[victimId].hand.push(deck.pop());
            if(deck.length === 0) refillDeck(); 
            if(deck.length > 0) players[victimId].hand.push(deck.pop());
        }
    } else consecutiveTwos = 0;

@@ -228,25 +262,36 @@
}

function startNewRound(reset = false) {
    gameStarted = true; deck = createDeck(); playerOrder = Object.keys(players);
    gameStarted = true; deck = createDeck(); 
    
    if (reset) { 
        roundHistory = []; 
        playerOrder.forEach(id => { players[id].totalScore = 0; players[id].hats = 0; }); 
        roundStarterIndex = 0;
        turnIndex = 0; 
        io.emit('updateScoreboard', { history: [], players: playerOrder.map(id => players[id]) }); 
    } else {
        roundStarterIndex++; // Αλλάζει ο πρώτος παίκτης κάθε γύρο
        turnIndex = roundStarterIndex % playerOrder.length;
    }
    direction = 1; // Επαναφορά φοράς δεξιόστροφα σε κάθε γύρο!
    
    direction = 1; // ΠΑΝΤΑ ΔΕΞΙΟΣΤΡΟΦΑ ΣΤΗΝ ΑΡΧΗ
    penaltyStack = 0; activeSuit = null;
    playerOrder.forEach(id => { players[id].hand = []; players[id].hasDrawn = false; });
    
    let dealCount = 0;
    let interval = setInterval(() => {
        playerOrder.forEach(id => players[id].hand.push(deck.pop()));
        playerOrder.forEach(id => { if(deck.length > 0) players[id].hand.push(deck.pop()); });
        if (++dealCount === 11) {
            clearInterval(interval);
            let first = deck.pop();
            while(first.value === 'J' && first.color === 'black') { deck.unshift(first); first = deck.pop(); }
            discardPile = [first]; io.emit('gameReady');
            processCardLogic(first, null); broadcastUpdate();
            while(first && first.value === 'J' && first.color === 'black') { 
                deck.unshift(first); first = deck.pop(); 
            }
            if (first) {
                discardPile = [first]; io.emit('gameReady');
                processCardLogic(first, null); broadcastUpdate();
            }
        }
    }, 50);
}
@@ -261,12 +306,13 @@
        }
    });

    // 1. Γυρνάμε τις κάρτες των αντιπάλων για να τις δουν όλοι!
    io.emit('revealHands', playerOrder.map(id => players[id]));

    let safePlayers = playerOrder.filter(id => players[id].totalScore < 500);

    // ΕΛΕΓΧΟΣ ΜΕΓΑΛΟΥ ΝΙΚΗΤΗ
    if (safePlayers.length === 1 && playerOrder.length > 1) {
        let ultimateWinner = players[safePlayers[0]];
        
        let msgs = [
            `Είσαι ο μαστερ του Μαύρου Βαλέ, μπράβο κέρδισες ${ultimateWinner.name}!`,
            `Μπράβο είσαι η καλύτερη, έκανες την τύχη σου ${ultimateWinner.name}!`,
@@ -282,16 +328,11 @@

        roundHistory.push(historyEntry);
        io.emit('updateScoreboard', { history: roundHistory, players: playerOrder.map(id => players[id]) });
        
        gameStarted = false; 
        io.emit('gameOver', finalMsg); 

        roundHistory = [];
        playerOrder.forEach(id => {
            players[id].totalScore = 0;
            players[id].hats = 0;
        });

        playerOrder.forEach(id => { players[id].totalScore = 0; players[id].hats = 0; });
        return;
    }

@@ -300,7 +341,9 @@

    roundHistory.push(historyEntry); 
    io.emit('updateScoreboard', { history: roundHistory, players: playerOrder.map(id => players[id]) });
    setTimeout(() => startNewRound(false), 2000);
    
    // Ξεκινάει ο νέος γύρος μετά από 3 δευτερόλεπτα (ώστε να προλάβουν να δουν τις γυρισμένες κάρτες και το σκορ)
    setTimeout(() => startNewRound(false), 3000);
}

function advanceTurn(steps) {
@@ -310,20 +353,31 @@
}

function refillDeck() {
    let top = discardPile.pop(); deck = [...discardPile].sort(() => Math.random() - 0.5); discardPile = [top];
    io.emit('notification', '🔄 Ανακάτεμα!');
    if (discardPile.length > 1) {
        let top = discardPile.pop(); 
        deck = [...discardPile].sort(() => Math.random() - 0.5); 
        discardPile = [top];
        io.emit('notification', '🔄 Ανακάτεμα!');
    }
}

function broadcastUpdate() {
    let cp = players[playerOrder[turnIndex]];
    playerOrder.forEach(id => {
        let safeHand = [];
        if (players[id] && players[id].hand) {
            safeHand = players[id].hand.filter(c => c && c.value && c.suit);
        }
        io.to(id).emit('updateUI', {
            players: playerOrder.map(pid => ({ id: pid, name: players[pid].name, handCount: players[pid].hand.length, hats: players[pid].hats, totalScore: players[pid].totalScore, connected: players[pid].connected })),
            players: playerOrder.map(pid => {
                let p = players[pid];
                return { id: pid, name: p.name, handCount: p.hand.length, hats: p.hats, totalScore: p.totalScore, connected: p.connected };
            }),
            topCard: discardPile[discardPile.length - 1],
            penalty: penaltyStack, direction, myHand: players[id].hand, isMyTurn: (id === playerOrder[turnIndex]),
            currentPlayerName: cp ? cp.name : "...", activeSuit, deckCount: deck.length, activeSuitModalTriggered: !!activeSuit
            penalty: penaltyStack, direction, myHand: safeHand, isMyTurn: (id === playerOrder[turnIndex]),
            currentPlayerName: cp ? cp.name : "...", activeSuit, deckCount: deck.length
        });
    });
}

server.listen(process.env.PORT || 3000);
