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

// ΠΡΟΣΘΗΚΗ 1: Χρονόμετρο για Reset
let emptyRoomTimer = null;

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
    hand.filter(c => c && c.value).forEach(c => {
        if (c.value === 'A') score += 50;
        else if (['K', 'Q', 'J'].includes(c.value)) score += 10;
        else score += parseInt(c.value);
    });
    return score;
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        // ΠΡΟΣΘΗΚΗ 1: Αν μπει παίκτης, ακυρώνουμε το Reset
        if (emptyRoomTimer) {
            clearTimeout(emptyRoomTimer);
            emptyRoomTimer = null;
        }

        let username, sessionId;
        if (typeof data === 'object' && data !== null) {
            username = data.username;
            sessionId = data.sessionId;
        } else {
            username = data;
            sessionId = null;
        }

        let existingId = Object.keys(players).find(id => players[id].sessionId === sessionId && sessionId != null);

        if (existingId) {
            players[socket.id] = players[existingId];
            players[socket.id].id = socket.id; players[socket.id].connected = true;
            let idx = playerOrder.indexOf(existingId); if (idx !== -1) playerOrder[idx] = socket.id;
            if (existingId !== socket.id) delete players[existingId];
            socket.emit('rejoinSuccess', { gameStarted, myHand: players[socket.id].hand });
            io.emit('playerCountUpdate', Object.keys(players).length);
            if (gameStarted) broadcastUpdate();
        } else {
            if (gameStarted) return socket.emit('notification', 'Το παιχνίδι τρέχει ήδη!');
            let cleanName = (username && typeof username === 'string') ? username.trim() : "Παίκτης " + (Object.keys(players).length + 1);
            if (["δήμητρα", "δημητρα", "δημητρούλα", "δημητρουλα"].includes(cleanName.toLowerCase())) cleanName += " ❤️";
            
            players[socket.id] = { id: socket.id, sessionId: sessionId, hand: [], name: cleanName, totalScore: 0, hats: 0, hasDrawn: false, connected: true };
            
            if (!playerOrder.includes(socket.id)) playerOrder.push(socket.id);
            
            io.emit('playerCountUpdate', Object.keys(players).length);
            socket.emit('joinedLobby');
        }
    });

    socket.on('chatMessage', (msg) => {
        const p = players[socket.id];
        if (p) io.emit('chatUpdate', { name: p.name, text: msg });
    });

    socket.on('startGameRequest', () => { if (!gameStarted && playerOrder.length >= 2) startNewRound(true); });

    socket.on('playCard', (data) => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        
        let p = players[socket.id];
        let card = p.hand[data.index];
        if (!card) return;

        let topCard = discardPile[discardPile.length - 1];
        let effectiveSuit = activeSuit || topCard.suit, isValid = false;

        if (penaltyStack > 0) {
            if (penaltyType === '7' && card.value === '7') isValid = true;
            if (penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            if (card.value === 'A') {
                if (activeSuit) { 
                    if (card.suit === activeSuit) isValid = true; 
                } else {
                    isValid = true; 
                }
            }
            else if (card.value === topCard.value || card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true;
        }

        if (isValid) {
            let isSpecial = ['7', '8', 'J'].includes(card.value);
            let top1 = discardPile[discardPile.length - 1];
            let top2 = discardPile.length >= 2 ? discardPile[discardPile.length - 2] : null;

            if (!isSpecial) {
                if (top1 && card.value === top1.value && card.suit === top1.suit) {
                    io.emit('notification', 'Copy paste! 👯');
                } else if (top1 && top2 && top1.value === top2.value && top1.suit === top2.suit && card.value === top1.value && card.suit !== top1.suit) {
                    io.emit('notification', 'Copy erased! ❌');
                }
            }

            p.hand.splice(data.index, 1); 
            discardPile.push(card);
            
            if (p.hand.length === 0 && card.value === '8') {
                if (deck.length === 0) refillDeck();
                if (deck.length > 0) p.hand.push(deck.pop());
                io.emit('notification', `${p.name}: Έκλεισε με 8 και τραβάει αναγκαστικά 1 κάρτα!`);
            } 
            else if (p.hand.length === 0) {
                let isPenalty = false;
                let victimId = playerOrder[(turnIndex + direction + playerOrder.length) % playerOrder.length];
                let prevVictimId = playerOrder[(turnIndex - direction + playerOrder.length) % playerOrder.length];

                if (card.value === 'J' && card.color === 'black') {
                    // ΠΡΟΣΘΗΚΗ 4: Αθροιστικοί Βαλέδες
                    let totalCards = (penaltyType === 'J' ? penaltyStack : 0) + 10;
                    for(let i=0; i<totalCards; i++) {
                        if(deck.length === 0) refillDeck();
                        if(deck.length > 0 && players[victimId]) players[victimId].hand.push(deck.pop());
                    }
                    io.emit('notification', `Ο/Η ${p.name} έκλεισε με Μαύρο Βαλέ! +${totalCards} στον/στην ${players[victimId].name}!`);
                    penaltyStack = 0; penaltyType = null;
                    isPenalty = true;
                } else if (card.value === '7') {
                    let totalCards = (penaltyType === '7' ? penaltyStack : 0) + 2;
                    for(let i=0; i<totalCards; i++) {
                        if(deck.length === 0) refillDeck();
                        if(deck.length > 0 && players[victimId]) { players[victimId].hand.push(deck.pop()); }
                    }
                    io.emit('notification', `Ο/Η ${p.name} έκλεισε με 7! +${totalCards} στον/στην ${players[victimId].name}!`);
                    penaltyStack = 0; penaltyType = null;
                    isPenalty = true;
                } else if (card.value === '2') {
                    // ΠΡΟΣΘΗΚΗ 2: Ο προηγούμενος παίρνει 1 φύλλο αν κλείσεις με 2
                    if(deck.length === 0) refillDeck();
                    if(deck.length > 0 && players[prevVictimId]) { players[prevVictimId].hand.push(deck.pop()); }
                    io.emit('notification', `Ο/Η ${p.name} έκλεισε με 2! Ο/Η ${players[prevVictimId].name} παίρνει 1 κάρτα!`);
                    isPenalty = true; // Καθυστερεί το τέλος για να το δουν
                } else if (card.value === 'J' && card.color === 'red') {
                    penaltyStack = 0; penaltyType = null;
                }

                if (card.value === 'A') activeSuit = activeSuit ? null : (data.declaredSuit || card.suit);
                else activeSuit = null;

                broadcastUpdate(); 
                
                setTimeout(() => { handleRoundEnd(socket.id, card.value === 'A'); }, isPenalty ? 3500 : 1000);
                return;
            }

            if (p.hand.length === 1) {
                io.emit('notification', `${p.name}: Μία μία μία μία! ⚠️`);
            }

            if (card.value === 'A') {
                if (activeSuit) activeSuit = null; 
                else activeSuit = data.declaredSuit || card.suit;
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
        
        if (penaltyStack > 0) {
            let count = penaltyStack;
            for(let i=0; i<count; i++) { 
                if(deck.length === 0) refillDeck(); 
                if(deck.length > 0) p.hand.push(deck.pop()); 
            }
            penaltyStack = 0; penaltyType = null;
            advanceTurn(1); 
            broadcastUpdate();
            return;
        }

        if (p.hasDrawn) return socket.emit('notification', 'Έχεις ήδη τραβήξει!');
        
        if(deck.length === 0) refillDeck(); 
        if(deck.length > 0) p.hand.push(deck.pop()); 
        p.hasDrawn = true;
        broadcastUpdate();
    });

    socket.on('passTurn', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id || penaltyStack > 0 || !players[socket.id].hasDrawn) return;
        advanceTurn(1); broadcastUpdate();
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            players[socket.id].connected = false; 
            
            if (!gameStarted) {
                delete players[socket.id];
                playerOrder = playerOrder.filter(id => id !== socket.id);
            }
            
            io.emit('playerCountUpdate', Object.keys(players).length);

            // ΠΡΟΣΘΗΚΗ 1: Αν φύγουν όλοι, 2 λεπτά χρονόμετρο για καθαρισμό δωματίου
            let activeCount = Object.values(players).filter(p => p.connected).length;
            if (activeCount === 0) {
                emptyRoomTimer = setTimeout(() => {
                    gameStarted = false;
                    players = {};
                    playerOrder = [];
                    deck = [];
                    discardPile = [];
                    penaltyStack = 0;
                    activeSuit = null;
                    roundHistory = [];
                    turnIndex = 0;
                    console.log("Το δωμάτιο καθάρισε επιτυχώς μετά από 2 λεπτά αδράνειας.");
                }, 120000); // 120.000 ms = 2 λεπτά
            }
        }
    });
});

function processCardLogic(card, currentPlayer) {
    let advance = true, steps = 1, isStart = (!currentPlayer || !currentPlayer.id);
    if (card.value === '2') {
        consecutiveTwos++;
        if (consecutiveTwos >= 3) { io.emit('notification', 'Ξες πώς πάνε αυτά! 😂'); consecutiveTwos = 0; }
        if (!isStart) {
            let victimId = playerOrder[(turnIndex - direction + playerOrder.length) % playerOrder.length];
            if(deck.length === 0) refillDeck(); 
            if(deck.length > 0 && players[victimId]) players[victimId].hand.push(deck.pop());
        }
    } else consecutiveTwos = 0;

    if (card.value === '8') { advance = false; if(!isStart) currentPlayer.hasDrawn = false; }
    else if (card.value === '7') { penaltyStack += 2; penaltyType = '7'; }
    else if (card.value === 'J' && card.color === 'black') { penaltyStack += 10; penaltyType = 'J'; }
    else if (card.value === 'J' && card.color === 'red') { penaltyStack = 0; penaltyType = null; }
    else if (card.value === '3') { if (playerOrder.length === 2) advance = false; else direction *= -1; }
    else if (card.value === '9') {
        if (playerOrder.length === 2) {
             advance = false;
             if (!isStart) io.emit('notification', 'Άραξε 🍹'); 
        } else { 
            steps = 2; 
            if (!isStart) io.emit('notification', 'Άραξε 🍹');
        }
    }
    if (advance) advanceTurn(steps);
}

function startNewRound(reset = false) {
    gameStarted = true; deck = createDeck(); 
    
    if (reset) { 
        roundHistory = []; 
        playerOrder.forEach(id => { players[id].totalScore = 0; players[id].hats = 0; }); 
        roundStarterIndex = 0;
        turnIndex = 0; 
        io.emit('updateScoreboard', { history: [], players: playerOrder.map(id => players[id]) }); 
    } else {
        roundStarterIndex++; 
        turnIndex = roundStarterIndex % playerOrder.length;
    }
    
    direction = 1; 
    penaltyStack = 0; activeSuit = null;
    playerOrder.forEach(id => { players[id].hand = []; players[id].hasDrawn = false; });
    
    let dealCount = 0;
    let interval = setInterval(() => {
        playerOrder.forEach(id => { if(deck.length > 0) players[id].hand.push(deck.pop()); });
        if (++dealCount === 11) {
            clearInterval(interval);
            let first = deck.pop();
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

function handleRoundEnd(winnerId, closedWithAce) {
    let historyEntry = {};
    playerOrder.forEach(id => {
        if (id === winnerId) historyEntry[players[id].name] = "WC";
        else {
            let pts = calculateHandScore(players[id].hand) + (closedWithAce ? 50 : 0);
            players[id].totalScore += pts; historyEntry[players[id].name] = players[id].totalScore;
        }
    });

    io.emit('revealHands', playerOrder.map(id => players[id]).filter(p => p));

    let safePlayers = playerOrder.filter(id => players[id].totalScore < 500);
    
    if (safePlayers.length === 1 && playerOrder.length > 1) {
        let ultimateWinner = players[safePlayers[0]];
        let msgs = [
            `Είσαι ο μαστερ του Μαύρου Βαλέ, μπράβο κέρδισες ${ultimateWinner.name}!`,
            `Μπράβο είσαι η καλύτερη, έκανες την τύχη σου ${ultimateWinner.name}!`,
            `Συγχαρητήρια, είσαι κωλόφαρδος/η ${ultimateWinner.name}!`
        ];
        let finalMsg = msgs[Math.floor(Math.random() * msgs.length)];
        
        if (ultimateWinner.hats >= 2) {
            finalMsg = `Μπα, με τόσα καπέλα και ο παππούς μου κέρδιζε ${ultimateWinner.name} 😂`;
        }

        roundHistory.push(historyEntry);
        io.emit('updateScoreboard', { history: roundHistory, players: playerOrder.map(id => players[id]) });
        gameStarted = false; 
        io.emit('gameOver', finalMsg); 
        
        roundHistory = [];
        playerOrder.forEach(id => { players[id].totalScore = 0; players[id].hats = 0; });
        return;
    }

    let target = safePlayers.length > 0 ? Math.max(...safePlayers.map(id => players[id].totalScore)) : 0;
    playerOrder.forEach(id => { if (players[id].totalScore >= 500) { players[id].hats++; players[id].totalScore = target; } });
    
    roundHistory.push(historyEntry); 
    io.emit('updateScoreboard', { history: roundHistory, players: playerOrder.map(id => players[id]) });
    
    setTimeout(() => startNewRound(false), 3000);
}

function advanceTurn(steps) {
    turnIndex = (turnIndex + (direction * steps)) % playerOrder.length;
    if (turnIndex < 0) turnIndex += playerOrder.length;
    playerOrder.forEach(id => players[id].hasDrawn = false);
}

function refillDeck() {
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
            players: playerOrder.map(pid => {
                let p = players[pid];
                return { id: pid, name: p.name, handCount: p.hand.length, hats: p.hats, totalScore: p.totalScore, connected: p.connected };
            }),
            topCard: discardPile[discardPile.length - 1],
            penalty: penaltyStack, direction, myHand: safeHand, isMyTurn: (id === playerOrder[turnIndex]),
            currentPlayerName: cp ? cp.name : "...", activeSuit, deckCount: deck.length
        });
    });
}

server.listen(process.env.PORT || 3000);
