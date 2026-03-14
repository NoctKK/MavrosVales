const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// === ΣΤΑΤΙΚΑ ΑΡΧΕΙΑ & PATHS ===
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ping', (req, res) => {
    res.send('pong');
});

// === GLOBAL ERROR HANDLING ===
process.on('uncaughtException', (err) => {
    console.error('Αποτράπηκε Crash (Exception):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Αποτράπηκε Crash (Rejection):', reason);
});

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// === ΣΤΑΘΕΡΕΣ ΠΑΙΧΝΙΔΙΟΥ ===
const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

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
        this.lobbyTimer = null;
        this.dealInterval = null;
        this.turnTimer = null; 
    }

    createDeck() {
        let newDeck = [];
        for (let i = 0; i < 2; i++) {
            SUITS.forEach(s => {
                VALUES.forEach(v => {
                    newDeck.push({ 
                        suit: s, 
                        value: v, 
                        color: (s === '♥' || s === '♦') ? 'red' : 'black' 
                    });
                });
            });
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
        let score = 0;
        hand.forEach(c => {
            if (c.value === 'A') score += 50;
            else if (['K', 'Q', 'J'].includes(c.value)) score += 10;
            else if (c.value === '10') score += 10;
            else score += Number(c.value) || 0;
        });
        return score;
    }

    resetLobby() {
        if (!this.gameStarted) {
            this.players = {};
            this.playerOrder = [];
            io.emit('playerCountUpdate', 0);
            io.emit('notification', 'Το lobby μηδενίστηκε λόγω αδράνειας.');
        }
    }

    startLobbyTimer() {
        if (this.lobbyTimer) {
            clearTimeout(this.lobbyTimer);
            this.lobbyTimer = null;
        }
        this.lobbyTimer = setTimeout(() => this.resetLobby(), 120000); 
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

    resetTurnTimer() {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.turnTimer = null;
        }
        if (!this.gameStarted || this.playerOrder.length === 0) return;

        this.turnTimer = setTimeout(() => {
            this.autoPlayTurn();
        }, 60000); 
    }

    autoPlayTurn() {
        if (!this.gameStarted || this.playerOrder.length === 0) return;
        
        let currentId = this.playerOrder[this.turnIndex];
        let p = this.players[currentId];
        if (!p) return;

        io.emit('notification', `Ο χρόνος έληξε! Auto-pass για: ${p.name}`);

        if (this.penaltyStack > 0) {
            for(let i=0; i < this.penaltyStack; i++) {
                this.safeDraw(p);
            }
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

    joinGame(socket, data) {
        let username, sessionId;
        if (typeof data === 'object' && data !== null) {
            username = data.username;
            sessionId = data.sessionId;
        } else {
            username = data;
            sessionId = null;
        }
        
        let existingId = Object.keys(this.players).find(id => this.players[id].sessionId === sessionId && sessionId != null);

        if (existingId) {
            this.players[socket.id] = this.players[existingId];
            this.players[socket.id].id = socket.id;
            this.players[socket.id].connected = true;
            let idx = this.playerOrder.indexOf(existingId);
            if (idx !== -1) this.playerOrder[idx] = socket.id;
            delete this.players[existingId];
            
            socket.emit('rejoinSuccess', { 
                gameStarted: this.gameStarted, 
                myHand: this.players[socket.id].hand, 
                history: this.roundHistory 
            });
            io.emit('playerCountUpdate', this.playerOrder.length);
            if (this.gameStarted) this.broadcastUpdate();
        } else {
            if (this.gameStarted) {
                return socket.emit('notification', 'Το παιχνίδι έχει ήδη ξεκινήσει!');
            }
            
            let cleanName = username ? username.replace(/[<>]/g, '').trim() : "Παίκτης " + (this.playerOrder.length + 1);
            if (["δήμητρα", "δημητρα", "δημητρούλα"].includes(cleanName.toLowerCase())) cleanName += " ❤️";

            this.players[socket.id] = { 
                id: socket.id, 
                sessionId: sessionId, 
                hand: [], 
                name: cleanName, 
                totalScore: 0, 
                hats: 0, 
                hasDrawn: false, 
                hasAtePenalty: false,
                connected: true, 
                lastChat: 0 
            };
            this.playerOrder.push(socket.id);
            
            io.emit('playerCountUpdate', this.playerOrder.length);
            socket.emit('joinedLobby');
        }
    }

    playCard(socket, data) {
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id) return;
        
        let p = this.players[socket.id];
        if (!p || data.index === undefined) return;

        let card = p.hand[data.index];
        if (!card) return;

        let topCard = this.discardPile[this.discardPile.length - 1];
        let top2 = this.discardPile.length >= 2 ? this.discardPile[this.discardPile.length - 2] : null;
        let effectiveSuit = this.activeSuit || topCard.suit;
        let isValid = false;

        if (this.penaltyStack > 0) {
            if (this.penaltyType === '7' && card.value === '7') isValid = true;
            if (this.penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            if (card.value === 'A') isValid = true;
            else if (card.value === topCard.value || card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true;
        }

        if (isValid) {
            let isSpecial = ['7', '8', 'J', 'A'].includes(card.value);
            
            // Έλεγχος Copy Paste
            if (!isSpecial && topCard) {
                if (card.value === topCard.value && card.suit === topCard.suit) {
                    io.emit('notification', `${p.name}: Copy paste! 👯`);
                } else if (top2 && topCard.value === top2.value && topCard.suit === top2.suit && card.value === topCard.value && card.suit !== topCard.suit) {
                    io.emit('notification', `${p.name}: Copy erased! ❌`);
                }
            }

            // ΕΙΔΙΚΗ ΛΟΓΙΚΗ ΓΙΑ ΤΟΝ ΑΣΣΟ ("Σαν φύλλο")
            if (card.value === 'A') {
                if (topCard && topCard.value === 'A' && card.suit === effectiveSuit && !data.declaredSuit) {
                    // Παίχτηκε σαν φύλλο, δεν αλλάζει το χρώμα, απλά παίρνει το δικό του
                    this.activeSuit = null;
                    io.emit('notification', `${p.name}: Σαν φύλλο!`);
                } else {
                    // Παίχτηκε κανονικά ως μπαλαντέρ, αλλάζει το χρώμα
                    this.activeSuit = data.declaredSuit || card.suit;
                }
            } else {
                this.activeSuit = null;
            }

            p.hand.splice(data.index, 1);
            this.discardPile.push(card);
            
            if (p.hand.length === 1) {
                io.emit('notification', `${p.name}: Μία μία μία μία! ⚠️`);
            }

            if (p.hand.length === 0) {
                if (card.value === '8') {
                    this.safeDraw(p);
                    io.emit('notification', `${p.name}: Έκλεισα με 8 και τραβάω αναγκαστικά φύλλο! 🃏`);
                    this.processCardLogic(card, p);
                    this.broadcastUpdate();
                    return;
                }

                let isPenaltyHandled = false;
                let nextVictim = this.playerOrder[(this.turnIndex + this.direction + this.playerOrder.length) % this.playerOrder.length];
                let prevVictim = this.playerOrder[(this.turnIndex - this.direction + this.playerOrder.length) % this.playerOrder.length];

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

                if (this.turnTimer) clearTimeout(this.turnTimer);
                this.broadcastUpdate();
                setTimeout(() => this.handleRoundEnd(socket.id, card.value === 'A'), isPenaltyHandled ? 3000 : 1500);
                return;
            }

            this.processCardLogic(card, p);
            this.broadcastUpdate();
        } else {
            socket.emit('invalidMove');
        }
    }

    drawCard(socket) {
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id) return;
        let p = this.players[socket.id];
        
        if (this.penaltyStack > 0) {
            for (let i = 0; i < this.penaltyStack; i++) {
                this.safeDraw(p);
            }
            this.penaltyStack = 0;
            this.penaltyType = null;
            p.hasAtePenalty = true;
            this.resetTurnTimer();
            this.broadcastUpdate();
            return;
        }

        if (p.hasDrawn) {
            socket.emit('notification', 'Έχεις ήδη τραβήξει φύλλο!');
            return;
        }

        this.safeDraw(p);
        p.hasDrawn = true;
        this.resetTurnTimer();
        this.broadcastUpdate();
    }

    passTurn(socket) {
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id) return;
        let p = this.players[socket.id];
        
        if (this.penaltyStack > 0) {
            socket.emit('notification', 'Πρέπει να τραβήξεις τις κάρτες ποινής πρώτα!');
            return;
        }
        
        if (!p.hasDrawn) {
            socket.emit('notification', 'Δεν μπορείς να πας πάσο αν δεν τραβήξεις φύλλο!');
            return;
        }

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
                if (this.consecutiveTwos >= 3) {
                    msg += "\nΞες πώς πάνε αυτά! 😂";
                    this.consecutiveTwos = 0;
                }
                io.emit('notification', msg);
                let victimId = this.playerOrder[(this.turnIndex - this.direction + this.playerOrder.length) % this.playerOrder.length];
                this.safeDraw(this.players[victimId]);
            }
        } else {
            this.consecutiveTwos = 0;
        }

        if (card.value === '8') {
            advance = false;
            if(!isStart) p.hasDrawn = false;
        } else if (card.value === '7') {
            this.penaltyStack += 2;
            this.penaltyType = '7';
        } else if (card.value === 'J' && card.color === 'black') {
            this.penaltyStack += 10;
            this.penaltyType = 'J';
        } else if (card.value === 'J' && card.color === 'red') {
            this.penaltyStack = 0;
            this.penaltyType = null;
        } else if (card.value === '3') {
            if (this.playerOrder.length === 2) advance = false;
            else this.direction *= -1;
        } else if (card.value === '9') {
            steps = (this.playerOrder.length === 2) ? 0 : 2;
            advance = (this.playerOrder.length !== 2);
            if (!isStart) {
                if (this.playerOrder.length === 2) io.emit('notification', `${p.name}: Ξανά παίζω! 🍹`);
                else io.emit('notification', `${p.name}: Άραξε 🍹`);
            }
        }

        if (advance) this.advanceTurn(steps);
        else this.resetTurnTimer();
    }

    startNewRound(reset = false) {
        this.gameStarted = true;
        this.starting = false;
        this.deck = this.createDeck();
        this.discardPile = [];
        this.penaltyStack = 0;
        this.activeSuit = null;
        this.consecutiveTwos = 0;
        this.direction = 1;

        if (this.turnTimer) clearTimeout(this.turnTimer);

        if (reset) {
            this.roundHistory = [];
            this.roundStarterIndex = 0;
            this.turnIndex = 0;
            this.playerOrder.forEach(id => {
                this.players[id].totalScore = 0;
                this.players[id].hats = 0;
            });
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
        if (this.dealInterval) clearInterval(this.dealInterval);

        this.dealInterval = setInterval(() => {
            this.playerOrder.forEach(id => {
                if (this.deck.length > 0) this.players[id].hand.push(this.deck.pop());
            });
            
            if (++dealCount === 11) {
                clearInterval(this.dealInterval);
                this.dealInterval = null;
                
                let firstCard = this.deck.pop();
                while(firstCard && firstCard.value === 'J' && firstCard.color === 'black') {
                    this.deck.unshift(firstCard);
                    firstCard = this.deck.pop();
                }
                
                this.discardPile.push(firstCard);
                io.emit('gameReady');
                this.processCardLogic(firstCard, { id: null });
                this.resetTurnTimer();
                this.broadcastUpdate();
            }
        }, 50);
    }

    handleRoundEnd(winnerId, closedWithAce) {
        if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }

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

        let losers = this.playerOrder.filter(id => this.players[id].totalScore >= 500);
        
        if (losers.length === 1 && this.playerOrder.length > 1) {
            let winner = this.players[winnerId];
            io.emit('gameOver', `Ο γύρος τελείωσε! Νικητής: ${winner.name}`);
            this.gameStarted = false;
        } else {
            let target = losers.length > 0 ? Math.max(...losers.map(id => this.players[id].totalScore)) : 0;
            this.playerOrder.forEach(id => {
                if (this.players[id].totalScore >= 500) {
                    this.players[id].hats++;
                    this.players[id].totalScore = target;
                }
            });
            setTimeout(() => this.startNewRound(false), 4000);
        }
    }

    advanceTurn(steps) {
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

    broadcastUpdate() {
        let currentId = this.playerOrder[this.turnIndex];
        let cp = this.players[currentId];
        
        let publicPlayers = this.playerOrder.map(pid => {
            let p = this.players[pid];
            if (!p) return null;
            return {
                id: pid,
                name: p.name,
                handCount: p.hand.length,
                hats: p.hats,
                totalScore: p.totalScore,
                connected: p.connected
            };
        }).filter(Boolean);

        this.playerOrder.forEach(id => {
            let p = this.players[id];
            if (!p) return;
            io.to(id).emit('updateUI', {
                players: publicPlayers,
                topCard: this.discardPile[this.discardPile.length - 1],
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
        if (this.players[socketId]) {
            this.players[socketId].connected = false;
            if (!this.gameStarted) {
                this.playerOrder = this.playerOrder.filter(id => id !== socketId);
                delete this.players[socketId];
                io.emit('playerCountUpdate', this.playerOrder.length);
            } else {
                if (this.playerOrder[this.turnIndex] === socketId) {
                    this.advanceTurn(1);
                    this.broadcastUpdate();
                }
                
                if (this.playerOrder.every(id => !this.players[id] || !this.players[id].connected)) {
                    this.gameStarted = false;
                    if (this.turnTimer) {
                        clearTimeout(this.turnTimer);
                        this.turnTimer = null;
                    }
                    this.startLobbyTimer();
                }
            }
        }
    }
}

const game = new Game();

io.on('connection', (socket) => {
    if (!game.gameStarted) game.startLobbyTimer();

    socket.on('joinGame', (data) => {
        game.joinGame(socket, data);
    });

    socket.on('startGameRequest', () => {
        if (!game.gameStarted && !game.starting && game.playerOrder.length >= 2) {
            game.starting = true;
            if (game.lobbyTimer) {
                clearTimeout(game.lobbyTimer);
                game.lobbyTimer = null;
            }
            game.startNewRound(true);
        }
    });

    socket.on('playCard', (data) => {
        game.playCard(socket, data);
    });

    socket.on('drawCard', () => {
        game.drawCard(socket);
    });

    socket.on('passTurn', () => {
        game.passTurn(socket);
    });

    socket.on('chatMessage', (msg) => {
        const p = game.players[socket.id];
        if (p && (!p.lastChat || Date.now() - p.lastChat > 500)) {
            p.lastChat = Date.now();
            io.emit('chatUpdate', { 
                name: p.name, 
                text: String(msg).replace(/[<>]/g, '').substring(0, 100) 
            });
        }
    });

    socket.on('disconnect', () => {
        game.disconnectPlayer(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Ο Μαύρος Βαλές τρέχει στο port ${PORT}`);
});
