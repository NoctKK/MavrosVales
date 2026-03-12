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
let lobbyTimer = null;

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

function resetLobby() {
    if (!gameStarted) {
        players = {};
        playerOrder = [];
        io.emit('playerCountUpdate', 0);
        io.emit('notification', 'Το lobby μηδενίστηκε λόγω αδράνειας.');
    }
}

function startLobbyTimer() {
    if (lobbyTimer) clearTimeout(lobbyTimer);
    lobbyTimer = setTimeout(resetLobby, 120000); // 2 λεπτά
}

io.on('connection', (socket) => {
    if (!gameStarted) startLobbyTimer();

    socket.on('joinGame', (data) => {
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
            socket.emit('rejoinSuccess', { gameStarted, myHand: players[socket.id].hand, history: roundHistory });
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

    socket.on('startGameRequest', () => { 
        if (!gameStarted && playerOrder.length >= 2) {
            if (lobbyTimer) clearTimeout(lobbyTimer);
            startNewRound(true); 
        }
    });

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
                if (activeSuit) { if (card.suit === activeSuit) isValid = true; } 
                else { isValid = true; }
            }
            else if (card.value === topCard.value || card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true;
        }

        if (isValid) {
            if (card.value === 'A' && !activeSuit && card.suit === topCard.suit && !data.declaredSuit) {
                socket.emit('notification', 'Σαν φύλλο! 🃏');
            }

            let top1 = discardPile[discardPile.length - 1];
            let top2 = discardPile.length >= 2 ? discardPile[discardPile.length - 2] : null;
            let isSpecial = ['7', '8', 'J'].includes(card.value);
            if (!isSpecial && top1) {
                if (card.value === top1.value && card.suit === top1.suit) {
                    io.emit('notification', 'Copy paste! 👯');
                } else if (top2 && top1.value === top2.value && top1.suit === top2.suit && card.value === top1.value && card.suit !== top1.suit) {
                    io.emit('notification', 'Copy erased! ❌');
                }
            }

            p.hand.splice(data.index, 1);
            discardPile.push(card);
            
            if (p.hand.length === 0) {
                let isPenaltyHandled = false;
                let nextVictim = playerOrder[(turnIndex + direction + playerOrder.length) % playerOrder.length];
                let prevVictim = playerOrder[(turnIndex - direction + playerOrder.length) % playerOrder.length];

                if (card.value === 'J' && card.color === 'black') {
                    let totalPenalty = (penaltyType === 'J' ? penaltyStack : 0) + 10;
                    for(let i=0; i<totalPenalty; i++) {
                        if(deck.length === 0) refillDeck();
                        if(deck.length > 0) players[nextVictim].hand.push(deck.pop());
                    }
                    io.emit('notification', `Κλείσιμο με Μαύρο Βαλέ! +${totalPenalty} στον/στην ${players[nextVictim].name}!`);
                    penaltyStack = 0; penaltyType = null; isPenaltyHandled = true;
                } else if (card.value === '7') {
                    let totalPenalty = (penaltyType === '7' ? penaltyStack : 0) + 2;
                    for(let i=0; i<totalPenalty; i++) {
                        if(deck.length === 0) refillDeck();
                        if(deck.length > 0) players[nextVictim].hand.push(deck.pop());
                    }
                    io.emit('notification', `Κλείσιμο με 7! +${totalPenalty} στον/στην ${players[nextVictim].name}!`);
                    penaltyStack = 0; penaltyType = null; isPenaltyHandled = true;
                } else if (card.value === '2') {
                    if(deck.length === 0) refillDeck();
                    if(deck.length > 0) players[prevVictim].hand.push(deck.pop());
                    io.emit('notification', `Κλείσιμο με 2! +1 στον/στην ${players[prevVictim].name}!`);
                    isPenaltyHandled = true;
                }

                if (card.value === 'A') activeSuit = data.declaredSuit || card.suit;
                else activeSuit = null;

                broadcastUpdate();
                setTimeout(() => { handleRoundEnd(socket.id, card.value === 'A'); }, isPenaltyHandled ? 3000 : 1000);
                return;
            }

            if (card.value === 'A') {
                if (!activeSuit && card.suit === topCard.suit) activeSuit = null; 
                else activeSuit = data.declaredSuit || card.suit;
            } else { activeSuit = null; }

            processCardLogic(card, p);
            broadcastUpdate();
        } else { socket.emit('invalidMove'); }
    });

    socket.on('drawCard', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id];
        
        if (penaltyStack > 0) {
            for(let i=0; i<penaltyStack; i++) {
                if(deck.length === 0) refillDeck();
                if(deck.length > 0) p.hand.push(deck.pop());
            }
            penaltyStack = 0; penaltyType = null;
            // Έφαγε την ποινή. Το p.hasDrawn μένει false, οπότε για να πάει πάσο,
            // θα πρέπει να ξαναπατήσει "ΤΡΑΒΑ" για το κανονικό του φύλλο.
            broadcastUpdate(); 
            return;
        }

        if (p.hasDrawn) {
            socket.emit('notification', 'Έχεις ήδη τραβήξει φύλλο!');
            return;
        }

        if(deck.length === 0) refillDeck();
        if(deck.length > 0) p.hand.push(deck.pop());
        p.hasDrawn = true; 
        broadcastUpdate();
    });

    socket.on('passTurn', () => {
        if (!gameStarted || playerOrder[turnIndex] !== socket.id) return;
        let p = players[socket.id];
        
        if (penaltyStack > 0) {
            socket.emit('notification', 'Πρέπει να τραβήξεις τις κάρτες ποινής πρώτα!');
            return;
        }
        
        // ΔΙΟΡΘΩΣΗ: Αφαίρεσα το hasAtePenalty. Τώρα, για να πας πάσο, 
        // ΠΡΕΠΕΙ υποχρεωτικά το p.hasDrawn να είναι true (δηλαδή να έχεις τραβήξει 1 κανονικό φύλλο).
        if (!p.hasDrawn) {
            socket.emit('notification', 'Δεν μπορείς να πας πάσο αν δεν τραβήξεις φύλλο!');
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
                playerOrder = playerOrder.filter(id => id !== socket.id);
                io.emit('playerCountUpdate', Object.keys(players).length);
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
            if(deck.length > 0) players[victimId].hand.push(deck.pop());
        }
    } else { consecutiveTwos = 0; }
    
    if (card.value === '8') { advance = false; if(!isStart) currentPlayer.hasDrawn = false; }
    else if (card.value === '7') { penaltyStack += 2; penaltyType = '7'; }
    else if (card.value === 'J' && card.color === 'black') { penaltyStack += 10; penaltyType = 'J'; }
    else if (card.value === 'J' && card.color === 'red') { penaltyStack = 0; penaltyType = null; }
    else if (card.value === '3') { if (playerOrder.length === 2) advance = false; else direction *= -1; }
    else if (card.value === '9') { 
        steps = (playerOrder.length === 2) ? 0 : 2; 
        advance = (playerOrder.length !== 2); 
        if (!isStart) io.emit('notification', 'Άραξε 🍹');
    }
    
    if (advance) advanceTurn(steps);
}

function startNewRound(reset = false) {
    gameStarted = true; deck = createDeck(); discardPile = [];
    if (reset) { 
        roundHistory = []; roundStarterIndex = 0; turnIndex = 0;
        playerOrder.forEach(id => { players[id].totalScore = 0; players[id].hats = 0; });
    } else {
        roundStarterIndex++; turnIndex = roundStarterIndex % playerOrder.length;
    }
    direction = 1; penaltyStack = 0; activeSuit = null; consecutiveTwos = 0;
    
    playerOrder.forEach(id => { players[id].hand = []; players[id].hasDrawn = false; });
    
    let dealCount = 0;
    let interval = setInterval(() => {
        playerOrder.forEach(id => { if(deck.length > 0) players[id].hand.push(deck.pop()); });
        if (++dealCount === 11) {
            clearInterval(interval);
            let first = deck.pop();
            while(first && first.value === 'J' && first.color === 'black') { deck.unshift(first); first = deck.pop(); }
            discardPile = [first]; 
            io.emit('gameReady');
            processCardLogic(first, null); 
            broadcastUpdate();
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
    io.emit('revealHands', playerOrder.map(id => players[id]));
    let safePlayers = playerOrder.filter(id => players[id].totalScore < 500);
    
    if (safePlayers.length === 1 && playerOrder.length > 1) {
        let winner = players[safePlayers[0]];
        roundHistory.push(historyEntry);
        io.emit('updateScoreboard', { history: roundHistory, players: playerOrder.map(id => players[id]) });
        gameStarted = false;
        io.emit('gameOver', `Ο/Η ${winner.name} κέρδισε το παιχνίδι!`);
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
    
    playerOrder.forEach(id => { 
        if(players[id]) {
            players[id].hasDrawn = false; 
        }
    });
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
        io.to(id).emit('updateUI', {
            players: playerOrder.map(pid => ({ id: pid, name: players[pid].name, handCount: players[pid].hand.length, hats: players[pid].hats, totalScore: players[pid].totalScore, connected: players[pid].connected })),
            topCard: discardPile[discardPile.length - 1], penalty: penaltyStack, direction, 
            myHand: players[id].hand.filter(c => c && c.value), isMyTurn: (id === playerOrder[turnIndex]),
            currentPlayerName: cp ? cp.name : "...", activeSuit, deckCount: deck.length
        });
    });
}

server.listen(process.env.PORT || 3000);
