const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// === STATIC FILES ===
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/ping', (req, res) => res.send('pong'));

// === GLOBAL ERROR HANDLING ===
process.on('uncaughtException', (err) => console.error('Exception prevented:', err));
process.on('unhandledRejection', (reason) => console.error('Rejection prevented:', reason));

const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

// === GAME CONSTANTS ===
const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SPECIAL_CARDS = { ACE: 'A', TWO: '2', THREE: '3', SEVEN: '7', EIGHT: '8', NINE: '9', BLACK_JACK: 'J' };
const COLORS = { RED: ['♥','♦'], BLACK: ['♠','♣'] };
const MAX_HAND_SCORE = 500;
const LOBBY_TIMEOUT = 120000;
const TURN_TIMEOUT = 60000;
const DEAL_INTERVAL_MS = 50;

class Game {
    constructor() {
        this.deck = [];
        this.discardPile = [];
        this.players = {};
        this.playerOrder = [];
        this.turnIndex = 0;
        this.direction = 1;
        this.penaltyStack = 0;
        this.penaltyType = null;
        this.activeSuit = null;
        this.gameStarted = false;
        this.starting = false;
        this.roundHistory = [];
        this.roundStarterIndex = 0;
        this.consecutiveTwos = 0;

        this.timers = { lobby: null, deal: null, turn: null };
    }

    // ================= TIMERS =================
    clearTimer(name) {
        if (this.timers[name]) { clearTimeout(this.timers[name]); this.timers[name] = null; }
    }
    clearAllTimers() { Object.keys(this.timers).forEach(k => this.clearTimer(k)); }

    startLobbyTimer() {
        this.clearAllTimers();
        this.timers.lobby = setTimeout(() => this.resetLobby(), LOBBY_TIMEOUT);
    }

    resetLobby() {
        if (!this.gameStarted) {
            this.players = {}; 
            this.playerOrder = [];
            io.emit('playerCountUpdate', 0);
            io.emit('notification', 'Το lobby μηδενίστηκε λόγω αδράνειας.');
        }
    }

    resetTurnTimer() {
        this.clearTimer('turn');
        if (!this.gameStarted || this.playerOrder.length === 0) return;
        this.timers.turn = setTimeout(() => this.autoPlayTurn(), TURN_TIMEOUT);
    }

    // ================= DECK =================
    createDeck() {
        let deck = [];
        for (let i=0; i<2; i++)
            SUITS.forEach(s => VALUES.forEach(v => deck.push({ suit: s, value: v, color: COLORS.RED.includes(s) ? 'red' : 'black' })));
        return this.shuffle(deck);
    }

    shuffle(deck) {
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    }

    safeDraw(player) {
        if (!player) return false;
        if (this.deck.length === 0) {
            if (this.discardPile.length <= 1) {
                io.emit('notification', '⚠️ Η τράπουλα εξαντλήθηκε τελείως!');
                return false; 
            }
            let top = this.discardPile.pop();
            this.deck = this.shuffle([...this.discardPile]);
            this.discardPile = [top];
            io.emit('notification', '🔄 Ανακάτεμα τράπουλας!');
        }
        if (this.deck.length > 0) { player.hand.push(this.deck.pop()); return true; }
        return false;
    }

    calculateHandScore(hand) {
        return hand.reduce((sum, c) => {
            if (!c || !c.value) return sum;
            if (c.value === SPECIAL_CARDS.ACE) return sum + 50;
            if (['K','Q','J','10'].includes(c.value)) return sum + 10;
            return sum + (Number(c.value) || 0);
        }, 0);
    }

    // ================= PLAYER MANAGEMENT =================
    advanceTurn(steps = 1) {
        if (this.playerOrder.length === 0) return;
        
        this.turnIndex = (this.turnIndex + (this.direction * steps)) % this.playerOrder.length;
        if (this.turnIndex < 0) this.turnIndex += this.playerOrder.length;
        
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
        if (!p) return;

        io.emit('notification', `Ο χρόνος έληξε! Auto-pass για: ${p.name}`);

        if (this.penaltyStack > 0) {
            this.applyPenalty(currentId, 0, this.penaltyType);
            p.hasAtePenalty = true;
        } else if (!p.hasDrawn) {
            this.safeDraw(p);
            p.hasDrawn = true;
        }

        this.advanceTurn(1);
        this.broadcastUpdate();
    }

    joinGame(socket, data) {
        let username = data?.username || "Player " + (this.playerOrder.length + 1);
        let sessionId = data?.sessionId || null;
        username = String(username).replace(/[<>]/g,'').trim().substring(0,15);

        if (["δήμητρα","δημητρα","δημητρούλα"].includes(username.toLowerCase())) username += " ❤️";

        let existingId = Object.keys(this.players).find(id => this.players[id].sessionId === sessionId && sessionId);
        
        if (existingId) {
            this.players[socket.id] = { ...this.players[existingId], id: socket.id, connected: true };
            this.playerOrder[this.playerOrder.indexOf(existingId)] = socket.id;
            delete this.players[existingId];
            
            socket.emit('rejoinSuccess', { gameStarted: this.gameStarted, myHand: this.players[socket.id].hand, history: this.roundHistory });
            io.emit('playerCountUpdate', this.playerOrder.length);
            if (this.gameStarted) this.broadcastUpdate();
            return;
        }

        if (this.gameStarted) return socket.emit('notification', 'Το παιχνίδι έχει ήδη ξεκινήσει!');
        
        this.players[socket.id] = { id: socket.id, sessionId, hand: [], name: username, totalScore:0, hats:0, hasDrawn:false, hasAtePenalty:false, connected:true, lastChat:0 };
        this.playerOrder.push(socket.id);
        
        io.emit('playerCountUpdate', this.playerOrder.length);
        socket.emit('joinedLobby');
    }

    disconnectPlayer(socketId) {
        let p = this.players[socketId];
        if (!p) return;
        p.connected = false;

        if (!this.gameStarted) {
            this.playerOrder = this.playerOrder.filter(id => id !== socketId);
            delete this.players[socketId];
            io.emit('playerCountUpdate', this.playerOrder.length);
            return;
        }

        if (this.playerOrder[this.turnIndex] === socketId) this.advanceTurn(1);
        this.broadcastUpdate();

        let connectedCount = this.playerOrder.filter(id => this.players[id]?.connected).length;
        if (connectedCount < 2) {
            this.gameStarted = false;
            this.clearAllTimers();
            io.emit('notification','Το παιχνίδι διακόπηκε λόγω έλλειψης παικτών.');
            this.startLobbyTimer();
        }
    }

    // ================= GAME LOGIC =================
    startNewRound(reset = false) {
        this.gameStarted = true;
        this.starting = false;
        this.deck = this.createDeck();
        this.discardPile = [];
        this.penaltyStack = 0;
        this.activeSuit = null;
        this.consecutiveTwos = 0;
        this.direction = 1;

        this.clearTimer('turn');

        if (reset) {
            this.roundHistory = [];
            this.roundStarterIndex = 0;
            this.turnIndex = 0;
            this.playerOrder.forEach(id => { this.players[id].totalScore = 0; this.players[id].hats = 0; });
        } else {
            this.roundStarterIndex++;
            this.turnIndex = this.roundStarterIndex % this.playerOrder.length;
        }

        this.playerOrder.forEach(id => {
            this.players[id].hand = [];
            this.players[id].hasDrawn = false;
            this.players[id].hasAtePenalty = false;
        });

        let dealCount = 0;
        this.clearTimer('deal');
        
        this.timers.deal = setInterval(() => {
            if (!this.gameStarted) { this.clearTimer('deal'); return; }
            
            this.playerOrder.forEach(id => this.safeDraw(this.players[id]));
            
            if (++dealCount >= 11) {
                this.clearTimer('deal');
                
                let firstCard = this.deck.pop();
                while(firstCard && firstCard.value === SPECIAL_CARDS.BLACK_JACK && firstCard.color === 'black') {
                    let randIndex = Math.floor(Math.random() * this.deck.length);
                    this.deck.splice(randIndex, 0, firstCard);
                    firstCard = this.deck.pop();
                }
                
                this.discardPile.push(firstCard);
                io.emit('gameReady');
                this.processCardLogic(firstCard, { id: null }); // Process first card (null player means no penalties applied)
                this.resetTurnTimer();
                this.broadcastUpdate();
            }
        }, DEAL_INTERVAL_MS);
    }

    handleRoundEnd(winnerId, closedWithAce) {
        this.clearTimer('turn');

        let historyEntry = {};
        this.playerOrder.forEach(id => {
            if (id === winnerId) {
                historyEntry[id] = "WC";
            } else {
                let pts = this.calculateHandScore(this.players[id].hand);
                if (closedWithAce) pts += 50; 
                this.players[id].totalScore += pts;
                historyEntry[id] = this.players[id].totalScore;
            }
        });

        this.roundHistory.push(historyEntry);
        io.emit('revealHands', this.playerOrder.map(id => this.players[id]));
        io.emit('updateScoreboard', { history: this.roundHistory, players: this.playerOrder.map(id => this.players[id]) });

        let safePlayers = this.playerOrder.filter(id => this.players[id].totalScore < MAX_HAND_SCORE);
        
        if (safePlayers.length <= 1 && this.playerOrder.length > 1) {
            let overallWinnerId = this.playerOrder.reduce((min, id) => this.players[id].totalScore < this.players[min].totalScore ? id : min, this.playerOrder[0]);
            io.emit('gameOver', `🏆 Το παιχνίδι τελείωσε! Νικητής: ${this.players[overallWinnerId].name}`);
            this.gameStarted = false;
            this.startLobbyTimer();
        } else {
            let target = safePlayers.length > 0 ? Math.max(...safePlayers.map(id => this.players[id].totalScore)) : 0;
            this.playerOrder.forEach(id => {
                if (this.players[id].totalScore >= MAX_HAND_SCORE) {
                    this.players[id].hats++;
                    this.players[id].totalScore = target;
                }
            });
            setTimeout(() => { if(this.gameStarted) this.startNewRound(false); }, 4000);
        }
    }

    // ================= PLAY CARD LOGIC =================
    playCard(socket, data) {
        if (!this.gameStarted || this.playerOrder.length === 0) return;
        if (this.playerOrder[this.turnIndex] !== socket.id) return;

        const p = this.players[socket.id];
        if (!p || data.index === undefined) return;

        const card = p.hand[data.index];
        if (!card) return;

        const topCard = this.discardPile[this.discardPile.length - 1];
        const effectiveSuit = this.activeSuit || topCard.suit;

        if (!this.isValidMove(card, topCard, effectiveSuit)) {
            return socket.emit('invalidMove');
        }

        // Copy-Paste Check
        let top2 = this.discardPile.length >= 2 ? this.discardPile[this.discardPile.length - 2] : null;
        let isSpecial = Object.values(SPECIAL_CARDS).includes(card.value);
        
        if (!isSpecial && topCard) {
            if (card.value === topCard.value && card.suit === topCard.suit) {
                io.emit('notification', 'Copy paste! 👯');
            } else if (top2 && topCard.value === top2.value && topCard.suit === top2.suit && card.value === topCard.value && card.suit !== topCard.suit) {
                io.emit('notification', 'Copy erased! ❌');
            }
        }

        // Apply Play
        p.hand.splice(data.index, 1);
        this.discardPile.push(card);
        this.activeSuit = (card.value === SPECIAL_CARDS.ACE) ? (data.declaredSuit || card.suit) : null;

        if (p.hand.length === 1) io.emit('notification', `${p.name}: Μία μία μία μία! ⚠️`);

        if (p.hand.length === 0) {
            let endsRound = this.handleEmptyHand(socket.id, card, p);
            if (endsRound) return; 
        } else {
            this.processCardLogic(card, p);
        }
        
        this.broadcastUpdate();
    }

    isValidMove(card, topCard, effectiveSuit) {
        if (this.penaltyStack > 0) {
            return (this.penaltyType === '7' && card.value === '7') || 
                   (this.penaltyType === 'J' && card.value === 'J');
        }
        if (card.value === SPECIAL_CARDS.ACE) return true;
        if (card.value === topCard.value || card.suit === effectiveSuit) return true;
        if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') return true;
        return false;
    }

    handleEmptyHand(playerId, card, p) {
        const nextVictim = this.playerOrder[(this.turnIndex + this.direction + this.playerOrder.length) % this.playerOrder.length];
        const prevVictim = this.playerOrder[(this.turnIndex - this.direction + this.playerOrder.length) % this.playerOrder.length];
        let penaltyHandled = false;

        // Αν κλείσει με 8, το παιχνίδι ΔΕΝ τελειώνει!
        if (card.value === SPECIAL_CARDS.EIGHT) {
            this.safeDraw(p);
            io.emit('notification', `${p.name} έκλεισε με 8 και τραβάει αναγκαστικά φύλλο! 🃏`);
            this.processCardLogic(card, p);
            return false; 
        }

        if (card.value === SPECIAL_CARDS.BLACK_JACK && card.color === 'black') {
            let total = this.applyPenalty(nextVictim, 10, 'J');
            io.emit('notification', `Κλείσιμο με Μαύρο Βαλέ! +${total} στον/στην ${this.players[nextVictim].name}!`);
            penaltyHandled = true;
        } else if (card.value === SPECIAL_CARDS.SEVEN) {
            let total = this.applyPenalty(nextVictim, 2, '7');
            io.emit('notification', `Κλείσιμο με 7! +${total} στον/στην ${this.players[nextVictim].name}!`);
            penaltyHandled = true;
        } else if (card.value === SPECIAL_CARDS.TWO) {
            this.safeDraw(this.players[prevVictim]);
            io.emit('notification', `Κλείσιμο με 2! +1 στον/στην ${this.players[prevVictim].name}!`);
            penaltyHandled = true;
        } else {
            this.penaltyStack = 0; 
            this.penaltyType = null;
        }

        this.clearTimer('turn');
        this.broadcastUpdate();
        setTimeout(() => this.handleRoundEnd(playerId, card.value === SPECIAL_CARDS.ACE), penaltyHandled ? 3000 : 1500);
        return true;
    }

    processCardLogic(card, p) {
        let advance = true;
        let steps = 1;
        let isStart = (!p || !p.id);

        if (card.value !== SPECIAL_CARDS.TWO) this.consecutiveTwos = 0;

        switch(card.value) {
            case SPECIAL_CARDS.TWO:
                this.consecutiveTwos++;
                if (!isStart) {
                    let msg = "Πάρε μία! 🃏";
                    if (this.consecutiveTwos >= 3) { msg += "\nΞες πώς πάνε αυτά! 😂"; this.consecutiveTwos = 0; }
                    io.emit('notification', msg);
                    let victimId = this.playerOrder[(this.turnIndex - this.direction + this.playerOrder.length) % this.playerOrder.length];
                    this.safeDraw(this.players[victimId]);
                }
                break;
            case SPECIAL_CARDS.EIGHT:
                advance = false;
                if (!isStart) p.hasDrawn = false;
                break;
            case SPECIAL_CARDS.SEVEN:
                this.penaltyStack += 2; this.penaltyType = '7';
                break;
            case SPECIAL_CARDS.BLACK_JACK:
                if(card.color === 'black') { this.penaltyStack += 10; this.penaltyType = 'J'; }
                else { this.penaltyStack = 0; this.penaltyType = null; }
                break;
            case SPECIAL_CARDS.THREE:
                if(this.playerOrder.length === 2) advance = false;
                else this.direction *= -1;
                break;
            case SPECIAL_CARDS.NINE:
                if(this.playerOrder.length === 2) {
                    advance = false;
                    if (!isStart) io.emit('notification', 'Ξανά παίζεις! 🍹');
                } else {
                    steps = 2;
                    if (!isStart) io.emit('notification', 'Άραξε 🍹');
                }
                break;
        }

        if(advance) this.advanceTurn(steps);
        else this.resetTurnTimer();
    }

    applyPenalty(playerId, baseCount, type) {
        let totalCount = baseCount + (this.penaltyType === type ? this.penaltyStack : 0);
        for(let i=0; i < totalCount; i++) {
            this.safeDraw(this.players[playerId]);
        }
        this.penaltyStack = 0; 
        this.penaltyType = null;
        return totalCount;
    }

    // ================= DRAW & PASS =================
    drawCard(socket) {
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id) return;
        const p = this.players[socket.id];

        if(this.penaltyStack > 0) {
            this.applyPenalty(socket.id, 0, this.penaltyType);
            p.hasAtePenalty = true;
            this.resetTurnTimer();
            this.broadcastUpdate();
            return;
        }

        if(p.hasDrawn) return socket.emit('notification','Έχεις ήδη τραβήξει φύλλο!');
        this.safeDraw(p);
        p.hasDrawn = true;
        this.resetTurnTimer();
        this.broadcastUpdate();
    }

    passTurn(socket) {
        if (!this.gameStarted || this.playerOrder.length === 0 || this.playerOrder[this.turnIndex] !== socket.id) return;
        const p = this.players[socket.id];
        if(this.penaltyStack > 0) return socket.emit('notification','Πρέπει να τραβήξεις τις κάρτες ποινής πρώτα!');
        if(!p.hasDrawn) return socket.emit('notification','Δεν μπορείς να πας πάσο αν δεν τραβήξεις φύλλο!');

        this.advanceTurn(1);
        this.broadcastUpdate();
    }

    // ================= BROADCAST =================
    broadcastUpdate() {
        if (!this.playerOrder.length) return;
        let currentId = this.playerOrder[this.turnIndex];
        let cp = this.players[currentId];

        let publicPlayers = this.playerOrder.map(id => {
            let p = this.players[id]; if(!p) return null;
            return { id, name: p.name, handCount: p.hand.length, hats: p.hats, totalScore: p.totalScore, connected: p.connected };
        }).filter(Boolean);

        this.playerOrder.forEach(id => {
            let p = this.players[id]; if(!p) return;
            io.to(id).emit('updateUI', {
                players: publicPlayers,
                topCard: this.discardPile[this.discardPile.length-1],
                penalty: this.penaltyStack,
                direction: this.direction,
                currentPlayerName: cp?.name || "...",
                currentPlayerId: currentId,
                activeSuit: this.activeSuit,
                deckCount: this.deck.length,
                myHand: p.hand,
                isMyTurn: (id === currentId)
            });
        });
    }
}

// ================= INIT =================
const game = new Game();

io.on('connection', socket => {
    if (!game.gameStarted) game.startLobbyTimer();

    socket.on('joinGame', data => game.joinGame(socket, data));
    socket.on('startGameRequest', () => {
        if (!game.gameStarted && !game.starting && game.playerOrder.length >= 2) {
            game.starting = true;
            game.clearAllTimers();
            game.startNewRound(true);
        }
    });

    socket.on('playCard', data => game.playCard(socket, data));
    socket.on('drawCard', () => game.drawCard(socket));
    socket.on('passTurn', () => game.passTurn(socket));

    socket.on('chatMessage', msg => {
        const p = game.players[socket.id];
        if (!p) return;
        if (!p.lastChat || Date.now() - p.lastChat > 500) {
            p.lastChat = Date.now();
            io.emit('chatUpdate', { name: p.name, text: String(msg).replace(/[<>]/g,'').substring(0,100) });
        }
    });

    socket.on('disconnect', () => game.disconnectPlayer(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ο Μαύρος Βαλές τρέχει στο port ${PORT}`));
