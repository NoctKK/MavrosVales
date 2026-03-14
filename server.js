const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// === ΣΤΑΤΙΚΑ ΑΡΧΕΙΑ & PATHS ===
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/ping', (req, res) => res.send('pong'));

// === GAME CONSTANTS (Βελτιστοποίηση 4) ===
const TURN_TIME_MS = 60000;
const LOBBY_IDLE_MS = 120000;
const ROUND_RESTART_MS = 4000;
const DEAL_INTERVAL_MS = 50;
const STARTING_HAND_SIZE = 11;
const MAX_SCORE = 500;
const MAX_NAME_LEN = 15;
const MAX_CHAT_LEN = 80;

const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// === GLOBAL ERROR HANDLING (Βελτιστοποίηση 7) ===
process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR (Exception):', err);
    if (globalGameInstance) globalGameInstance.forceEmergencyReset();
});
process.on('unhandledRejection', (reason) => {
    console.error('CRITICAL ERROR (Rejection):', reason);
});

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

class Game {
    constructor() {
        this.deck = [];
        this.discardPile = [];
        this.discardCount = 0; // Fix 2: Move/Discard ID
        
        this.players = {};
        this.playerOrder = [];
        
        this.gameStarted = false;
        this.starting = false;
        this.roundHistory = [];
        this.roundStarterIndex = 0;
        
        this.timers = { lobby: null, deal: null, turn: null, restart: null }; // Fix 7: Centralized Timers
        
        this.resetRoundState(); // Βελτιστοποίηση 5
    }

    // === STATE & TIMERS MANAGEMENT ===
    resetRoundState() {
        this.penaltyStack = 0;
        this.penaltyType = null;
        this.activeSuit = null;
        this.consecutiveTwos = 0;
        this.direction = 1;
        this.turnIndex = 0;
    }

    clearAllTimers() {
        Object.keys(this.timers).forEach(key => {
            if (this.timers[key]) {
                clearTimeout(this.timers[key]);
                clearInterval(this.timers[key]);
                this.timers[key] = null;
            }
        });
    }

    forceEmergencyReset() {
        console.log("Emergency Game Reset initiated.");
        this.clearAllTimers();
        this.gameStarted = false;
        this.starting = false;
        io.emit('notification', '🚨 Σφάλμα διακομιστή. Επαναφορά τραπεζιού...');
        this.refreshLobbyTimer();
    }

    refreshLobbyTimer() { // Fix 8: Ανανέωση Lobby Timer σε κάθε action
        if (this.gameStarted) return;
        if (this.timers.lobby) clearTimeout(this.timers.lobby);
        this.timers.lobby = setTimeout(() => {
            if (!this.gameStarted) {
                this.players = {};
                this.playerOrder = [];
                io.emit('playerCountUpdate', 0);
                io.emit('notification', 'Το lobby μηδενίστηκε λόγω αδράνειας.');
            }
        }, LOBBY_IDLE_MS);
    }

    resetTurnTimer() {
        if (this.timers.turn) clearTimeout(this.timers.turn);
        if (!this.gameStarted || this.playerOrder.length === 0) return;
        this.timers.turn = setTimeout(() => this.autoPlayTurn(), TURN_TIME_MS);
    }

    // === CORE MECHANICS ===
    createDeck() {
        let newDeck = [];
        for (let i = 0; i < 2; i++) {
            SUITS.forEach(s => VALUES.forEach(v => {
                newDeck.push({ suit: s, value: v, color: (s === '♥' || s === '♦') ? 'red' : 'black' });
            }));
        }
        return this.shuffle(newDeck);
    }

    shuffle(deck) {
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    }

    calculateHandScore(hand) {
        return hand.reduce((score, c) => {
            if (c.value === 'A') return score + 50;
            if (['K', 'Q', 'J', '10'].includes(c.value)) return score + 10;
            return score + (Number(c.value) || 0);
        }, 0);
    }

    safeDraw(player) {
        if (this.deck.length === 0) {
            if (this.discardPile.length <= 1) return false;
            let topCard = this.discardPile.pop();
            this.deck = this.shuffle([...this.discardPile]);
            this.discardPile = [topCard];
            io.emit('notification', '🔄 Ανακάτεμα τράπουλας!');
        }
        if (this.deck.length > 0) {
            player.hand.push(this.deck.pop());
            return true;
        }
        return false;
    }

    // === TURN LOGIC & GHOST PLAYER AVOIDANCE (Fix 6) ===
    getNextActivePlayerIndex(startIndex, steps = 1) {
        let activeCount = this.playerOrder.filter(id => this.players[id].connected).length;
        if (activeCount === 0) return 0; // Ασφάλεια αν φύγουν όλοι

        let idx = startIndex;
        let n = this.playerOrder.length;
        
        for (let i = 0; i < steps; i++) {
            do {
                idx = (idx + this.direction + n) % n;
            } while (!this.players[this.playerOrder[idx]].connected);
        }
        return idx;
    }

    advanceTurn(steps) {
        if (this.playerOrder.length === 0) return;
        
        this.turnIndex = this.getNextActivePlayerIndex(this.turnIndex, steps);
        
        this.playerOrder.forEach(id => {
            if (this.players[id]) {
                this.players[id].hasDrawn = false;
                this.players[id].hasAtePenalty = false;
            }
        });
        this.resetTurnTimer();
    }

    autoPlayTurn() {
        if (!this.gameStarted || this.playerOrder.length === 0) return;
        let currentId = this.playerOrder[this.turnIndex];
        let p = this.players[currentId];
        if (!p || !p.connected) {
            this.advanceTurn(1);
            this.broadcastUpdate();
            return;
        }

        io.emit('notification', `Ο χρόνος έληξε! Auto-pass: ${p.name}`);

        if (this.penaltyStack > 0) {
            for(let i=0; i < this.penaltyStack; i++) this.safeDraw(p);
            this.penaltyStack = 0;
            this.penaltyType = null;
            p.hasAtePenalty = true;
        } else if (!p.hasDrawn) {
            this.safeDraw(p);
            p.hasDrawn = true;
        }
        this.advanceTurn(1);
        this.broadcastUpdate();
    }

    // === NETWORKING ===
    joinGame(socket, data) {
        this.refreshLobbyTimer();
        let username = data?.username;
        let sessionId = data?.sessionId;
        
        // Fix 9: Server side name validation/truncation
        let cleanName = username ? String(username).replace(/[<>]/g, '').trim().substring(0, MAX_NAME_LEN) : "Παίκτης " + (this.playerOrder.length + 1);
        if (["δήμητρα", "δημητρα", "δημητρούλα"].includes(cleanName.toLowerCase())) cleanName += " ❤️";

        let existingId = Object.keys(this.players).find(id => this.players[id].sessionId === sessionId && sessionId != null);

        if (existingId) {
            this.players[socket.id] = this.players[existingId];
            this.players[socket.id].id = socket.id;
            this.players[socket.id].connected = true;
            this.playerOrder[this.playerOrder.indexOf(existingId)] = socket.id;
            delete this.players[existingId];
            
            socket.emit('rejoinSuccess', { 
                gameStarted: this.gameStarted, 
                myHand: this.players[socket.id].hand, 
                history: this.roundHistory 
            });
            io.emit('playerCountUpdate', this.playerOrder.length);
            if (this.gameStarted) this.broadcastUpdate();
        } else {
            if (this.gameStarted) return socket.emit('notification', 'Το παιχνίδι έχει ήδη ξεκινήσει!');
            
            this.players[socket.id] = { 
                id: socket.id, sessionId: sessionId, hand: [], name: cleanName, 
                totalScore: 0, hats: 0, hasDrawn: false, hasAtePenalty: false, connected: true, lastChat: 0 
            };
            this.playerOrder.push(socket.id);
            io.emit('playerCountUpdate', this.playerOrder.length);
            socket.emit('joinedLobby');
        }
    }

    playCard(socket, data) {
        this.refreshLobbyTimer();
        let p = this.players[socket.id];
        
        // Fix 4 & 9: Reject early with event
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id || !p) {
            return socket.emit('actionRejected');
        }
        if (!Number.isInteger(data.index) || data.index < 0 || data.index >= p.hand.length) {
            return socket.emit('actionRejected');
        }
        if (data.declaredSuit && !SUITS.includes(data.declaredSuit)) {
            return socket.emit('actionRejected');
        }

        let card = p.hand[data.index];
        let topCard = this.discardPile[this.discardPile.length - 1];
        let top2 = this.discardPile.length >= 2 ? this.discardPile[this.discardPile.length - 2] : null;
        let effectiveSuit = this.activeSuit || topCard.suit;
        let isValid = false;

        // Logic check
        if (this.penaltyStack > 0) {
            if (this.penaltyType === '7' && card.value === '7') isValid = true;
            if (this.penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            if (card.value === 'A') isValid = true;
            else if (card.value === topCard.value || card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true;
        }

        if (!isValid) return socket.emit('invalidMove');

        // Apply Move
        let isSpecial = ['7', '8', 'J', 'A'].includes(card.value);
        if (!isSpecial && topCard) {
            if (card.value === topCard.value && card.suit === topCard.suit) io.emit('notification', `${p.name}: Copy paste! 👯`);
            else if (top2 && topCard.value === top2.value && topCard.suit === top2.suit && card.value === topCard.value && card.suit !== topCard.suit) io.emit('notification', `${p.name}: Copy erased! ❌`);
        }

        if (card.value === 'A') {
            if (topCard && topCard.value === 'A' && card.suit === effectiveSuit && !data.declaredSuit) {
                this.activeSuit = null;
                io.emit('notification', `${p.name}: Σαν φύλλο!`);
            } else {
                this.activeSuit = data.declaredSuit || card.suit;
            }
        } else {
            this.activeSuit = null;
        }

        p.hand.splice(data.index, 1);
        this.discardPile.push(card);
        this.discardCount++; // Fix 2

        if (p.hand.length === 1) io.emit('notification', `${p.name}: Μία μία μία μία! ⚠️`);

        if (p.hand.length === 0) {
            this.handleEmptyHand(socket.id, card, p);
            return;
        }

        this.processCardLogic(card, p);
        this.broadcastUpdate();
    }

    handleEmptyHand(socketId, card, p) {
        if (card.value === '8') {
            this.safeDraw(p);
            io.emit('notification', `${p.name}: Έκλεισα με 8 και τραβάω αναγκαστικά φύλλο! 🃏`);
            this.processCardLogic(card, p);
            this.broadcastUpdate();
            return;
        }

        let isPenaltyHandled = false;
        let nextVictim = this.playerOrder[this.getNextActivePlayerIndex(this.turnIndex, 1)];
        let prevVictim = this.playerOrder[this.getNextActivePlayerIndex(this.turnIndex, this.playerOrder.length - 1)];

        if (card.value === 'J' && card.color === 'black') {
            let totalPenalty = (this.penaltyType === 'J' ? this.penaltyStack : 0) + 10;
            for(let i=0; i<totalPenalty; i++) this.safeDraw(this.players[nextVictim]);
            io.emit('notification', `${p.name}: Κλείσιμο με Μαύρο Βαλέ! +${totalPenalty} στον/στην ${this.players[nextVictim].name}!`);
            this.penaltyStack = 0; this.penaltyType = null; isPenaltyHandled = true;
        } else if (card.value === '7') {
            let totalPenalty = (this.penaltyType === '7' ? this.penaltyStack : 0) + 2;
            for(let i=0; i<totalPenalty; i++) this.safeDraw(this.players[nextVictim]);
            io.emit('notification', `${p.name}: Κλείσιμο με 7! +${totalPenalty} στον/στην ${this.players[nextVictim].name}!`);
            this.penaltyStack = 0; this.penaltyType = null; isPenaltyHandled = true;
        } else if (card.value === '2') {
            this.safeDraw(this.players[prevVictim]);
            io.emit('notification', `${p.name}: Κλείσιμο με 2! +1 στον/στην ${this.players[prevVictim].name}!`);
            isPenaltyHandled = true;
        }

        if (this.timers.turn) clearTimeout(this.timers.turn);
        this.broadcastUpdate();
        this.timers.restart = setTimeout(() => this.handleRoundEnd(socketId, card.value === 'A'), isPenaltyHandled ? 3000 : 1500);
    }

    drawCard(socket) {
        this.refreshLobbyTimer();
        let p = this.players[socket.id];
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id || !p) {
            return socket.emit('actionRejected');
        }
        
        if (this.penaltyStack > 0) {
            for (let i = 0; i < this.penaltyStack; i++) this.safeDraw(p);
            this.penaltyStack = 0; this.penaltyType = null;
            p.hasAtePenalty = true;
            this.resetTurnTimer();
            this.broadcastUpdate();
            return;
        }

        if (p.hasDrawn) return socket.emit('notification', 'Έχεις ήδη τραβήξει φύλλο!');

        this.safeDraw(p);
        p.hasDrawn = true;
        this.resetTurnTimer();
        this.broadcastUpdate();
    }

    passTurn(socket) {
        this.refreshLobbyTimer();
        let p = this.players[socket.id];
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id || !p) return;
        
        if (this.penaltyStack > 0) return socket.emit('notification', 'Πρέπει να τραβήξεις τις κάρτες ποινής πρώτα!');
        if (!p.hasDrawn) return socket.emit('notification', 'Δεν μπορείς να πας πάσο αν δεν τραβήξεις φύλλο!');

        this.advanceTurn(1);
        this.broadcastUpdate();
    }

    processCardLogic(card, p) {
        let advance = true;
        let steps = 1;
        let isStart = (!p || !p.id);

        if (card.value === '2') {
            this.consecutiveTwos++;
            if (!isStart) {
                let msg = `${p.name}: Πάρε μία! 🃏`;
                if (this.consecutiveTwos >= 3) { msg += "\nΞες πώς πάνε αυτά! 😂"; this.consecutiveTwos = 0; }
                io.emit('notification', msg);
                let victimId = this.playerOrder[this.getNextActivePlayerIndex(this.turnIndex, this.playerOrder.length - 1)]; // previous active
                this.safeDraw(this.players[victimId]);
            }
        } else {
            this.consecutiveTwos = 0;
        }

        if (card.value === '8') {
            advance = false;
            if(!isStart) p.hasDrawn = false;
        } else if (card.value === '7') {
            this.penaltyStack += 2; this.penaltyType = '7';
        } else if (card.value === 'J' && card.color === 'black') {
            this.penaltyStack += 10; this.penaltyType = 'J';
        } else if (card.value === 'J' && card.color === 'red') {
            this.penaltyStack = 0; this.penaltyType = null;
        } else if (card.value === '3') {
            let activeCount = this.playerOrder.filter(id => this.players[id].connected).length;
            if (activeCount <= 2) advance = false;
            else this.direction *= -1;
        } else if (card.value === '9') {
            let activeCount = this.playerOrder.filter(id => this.players[id].connected).length;
            steps = (activeCount <= 2) ? 0 : 2;
            advance = (activeCount > 2);
            if (!isStart) io.emit('notification', (activeCount <= 2) ? `${p.name}: Ξανά παίζω! 🍹` : `${p.name}: Άραξε 🍹`);
        }

        if (advance) this.advanceTurn(steps);
        else this.resetTurnTimer();
    }

    startNewRound(reset = false) {
        this.gameStarted = true;
        this.starting = false;
        this.deck = this.createDeck();
        this.discardPile = [];
        this.discardCount = 0;
        this.resetRoundState();
        this.clearAllTimers();

        if (reset) {
            this.roundHistory = [];
            this.roundStarterIndex = 0;
            this.turnIndex = 0;
            this.playerOrder.forEach(id => { this.players[id].totalScore = 0; this.players[id].hats = 0; });
        } else {
            this.roundStarterIndex++;
            this.turnIndex = this.getNextActivePlayerIndex(this.roundStarterIndex, 0); // Find next valid starter
        }

        this.playerOrder.forEach(id => {
            this.players[id].hand = [];
            this.players[id].hasDrawn = false;
            this.players[id].hasAtePenalty = false;
        });

        let dealCount = 0;
        this.timers.deal = setInterval(() => {
            this.playerOrder.forEach(id => {
                if (this.players[id].connected && this.deck.length > 0) this.players[id].hand.push(this.deck.pop());
            });
            
            if (++dealCount === STARTING_HAND_SIZE) {
                clearInterval(this.timers.deal);
                this.timers.deal = null;
                
                let firstCard = this.deck.pop();
                while(firstCard && firstCard.value === 'J' && firstCard.color === 'black') {
                    this.deck.unshift(firstCard);
                    firstCard = this.deck.pop();
                }
                
                this.discardPile.push(firstCard);
                this.discardCount++;
                io.emit('gameReady');
                this.processCardLogic(firstCard, { id: null });
                this.resetTurnTimer();
                this.broadcastUpdate();
            }
        }, DEAL_INTERVAL_MS);
    }

    handleRoundEnd(winnerId, closedWithAce) {
        this.clearAllTimers();

        let historyEntry = {};
        this.playerOrder.forEach(id => {
            if (id === winnerId) historyEntry[id] = "WC";
            else {
                let pts = this.calculateHandScore(this.players[id].hand);
                if (closedWithAce) pts += 50;
                this.players[id].totalScore += pts;
                historyEntry[id] = this.players[id].totalScore;
            }
        });

        this.roundHistory.push(historyEntry);
        io.emit('revealHands', this.playerOrder.map(id => this.players[id]));
        io.emit('updateScoreboard', { history: this.roundHistory, players: this.playerOrder.map(id => this.players[id]) });

        let losers = this.playerOrder.filter(id => this.players[id].totalScore >= MAX_SCORE);
        let activeCount = this.playerOrder.filter(id => this.players[id].connected).length;

        if (losers.length === 1 && activeCount > 1) {
            let winner = this.players[winnerId];
            io.emit('gameOver', `Ο γύρος τελείωσε! Νικητής: ${winner.name}`);
            this.gameStarted = false;
            this.startLobbyTimer();
        } else {
            let target = losers.length > 0 ? Math.max(...losers.map(id => this.players[id].totalScore)) : 0;
            this.playerOrder.forEach(id => {
                if (this.players[id].totalScore >= MAX_SCORE) {
                    this.players[id].hats++;
                    this.players[id].totalScore = target;
                }
            });
            this.timers.restart = setTimeout(() => this.startNewRound(false), ROUND_RESTART_MS);
        }
    }

    broadcastUpdate() {
        let currentId = this.playerOrder[this.turnIndex];
        let cp = this.players[currentId];
        
        let publicPlayers = this.playerOrder.map(pid => {
            let p = this.players[pid];
            if (!p) return null;
            return {
                id: pid, name: p.name, handCount: p.hand.length,
                hats: p.hats, totalScore: p.totalScore, connected: p.connected
            };
        }).filter(Boolean);

        this.playerOrder.forEach(id => {
            let p = this.players[id];
            if (!p) return;
            io.to(id).emit('updateUI', {
                players: publicPlayers,
                topCard: this.discardPile[this.discardPile.length - 1],
                discardCount: this.discardCount, // Fix 2
                penalty: this.penaltyStack,
                direction: this.direction,
                currentPlayerName: cp ? cp.name : "...",
                currentPlayerId: currentId,
                activeSuit: this.activeSuit,
                deckCount: this.deck.length,
                myHand: p.hand,
                isMyTurn: (id === currentId)
            });
        });
    }

    disconnectPlayer(socketId) {
        this.refreshLobbyTimer();
        if (this.players[socketId]) {
            this.players[socketId].connected = false;
            
            let activeCount = this.playerOrder.filter(id => this.players[id] && this.players[id].connected).length;

            if (!this.gameStarted) {
                this.playerOrder = this.playerOrder.filter(id => id !== socketId);
                delete this.players[socketId];
                io.emit('playerCountUpdate', this.playerOrder.length);
            } else {
                if (activeCount < 2) {
                    this.gameStarted = false;
                    this.clearAllTimers();
                    this.startLobbyTimer();
                    io.emit('notification', 'Παίκτες αποσυνδέθηκαν. Το παιχνίδι διακόπηκε.');
                } else if (this.playerOrder[this.turnIndex] === socketId) {
                    this.advanceTurn(1);
                    this.broadcastUpdate();
                }
            }
        }
    }
}

let globalGameInstance = new Game();

io.on('connection', (socket) => {
    if (!globalGameInstance.gameStarted) globalGameInstance.startLobbyTimer();

    socket.on('joinGame', (data) => globalGameInstance.joinGame(socket, data));
    
    socket.on('startGameRequest', () => {
        globalGameInstance.refreshLobbyTimer();
        let activeCount = globalGameInstance.playerOrder.filter(id => globalGameInstance.players[id].connected).length;
        if (!globalGameInstance.gameStarted && !globalGameInstance.starting && activeCount >= 2) {
            globalGameInstance.starting = true;
            globalGameInstance.clearAllTimers();
            globalGameInstance.startNewRound(true);
        }
    });

    socket.on('playCard', data => globalGameInstance.playCard(socket, data));
    socket.on('drawCard', () => globalGameInstance.drawCard(socket));
    socket.on('passTurn', () => globalGameInstance.passTurn(socket));

    socket.on('chatMessage', (msg) => {
        globalGameInstance.refreshLobbyTimer();
        const p = globalGameInstance.players[socket.id];
        if (p && (!p.lastChat || Date.now() - p.lastChat > 500)) {
            p.lastChat = Date.now();
            io.emit('chatUpdate', { name: p.name, text: String(msg).replace(/[<>]/g, '').substring(0, MAX_CHAT_LEN) });
        }
    });

    socket.on('disconnect', () => globalGameInstance.disconnectPlayer(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game Server running on port ${PORT}`));
