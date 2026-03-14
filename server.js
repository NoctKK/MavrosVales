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

process.on('unhandledRejection', (reason) => {
    console.error('Αποτράπηκε Crash (Rejection):', reason);
});

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
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
        const newDeck = [];
        for (let i = 0; i < 2; i++) {
            SUITS.forEach((suit) => {
                VALUES.forEach((value) => {
                    newDeck.push({
                        suit,
                        value,
                        color: suit === '♥' || suit === '♦' ? 'red' : 'black'
                    });
                });
            });
        }
        return this.shuffle(newDeck);
    }

    shuffle(deck) {
        const arr = [...deck];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    calculateHandScore(hand) {
        let score = 0;
        hand.forEach((c) => {
            if (c.value === 'A') score += 50;
            else if (['K', 'Q', 'J', '10'].includes(c.value)) score += 10;
            else score += Number(c.value) || 0;
        });
        return score;
    }

    clearLobbyTimer() {
        if (this.lobbyTimer) {
            clearTimeout(this.lobbyTimer);
            this.lobbyTimer = null;
        }
    }

    clearTurnTimer() {
        if (this.turnTimer) {
            clearTimeout(this.turnTimer);
            this.turnTimer = null;
        }
    }

    clearDealInterval() {
        if (this.dealInterval) {
            clearInterval(this.dealInterval);
            this.dealInterval = null;
        }
    }

    resetLobby() {
        if (!this.gameStarted) {
            this.clearLobbyTimer();
            this.clearTurnTimer();
            this.clearDealInterval();

            this.deck = [];
            this.discardPile = [];
            this.players = {};
            this.playerOrder = [];
            this.turnIndex = 0;
            this.direction = 1;
            this.penaltyStack = 0;
            this.penaltyType = null;
            this.activeSuit = null;
            this.starting = false;
            this.roundHistory = [];
            this.roundStarterIndex = 0;
            this.consecutiveTwos = 0;

            io.emit('playerCountUpdate', 0);
            io.emit('notification', 'Το lobby μηδενίστηκε λόγω αδράνειας.');
        }
    }

    startLobbyTimer() {
        this.clearLobbyTimer();
        this.lobbyTimer = setTimeout(() => this.resetLobby(), 120000);
    }

    safeDraw(player) {
        if (!player) return false;

        if (this.deck.length === 0) {
            if (this.discardPile.length <= 1) return false;

            const topCard = this.discardPile.pop();
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

    getCurrentPlayerId() {
        if (this.playerOrder.length === 0) return null;
        return this.playerOrder[this.turnIndex] || null;
    }

    getNextIndex(fromIndex, stepDirection = this.direction) {
        if (this.playerOrder.length === 0) return 0;
        let idx = (fromIndex + stepDirection) % this.playerOrder.length;
        if (idx < 0) idx += this.playerOrder.length;
        return idx;
    }

    getConnectedCount() {
        return this.playerOrder.filter((id) => this.players[id] && this.players[id].connected).length;
    }

    moveTurnToNextConnected(steps = 1) {
        if (this.playerOrder.length === 0) return;

        let idx = this.turnIndex;
        let moved = 0;
        let guard = 0;
        const maxGuard = this.playerOrder.length * 4;

        while (moved < steps && guard < maxGuard) {
            idx = this.getNextIndex(idx, this.direction);
            const pid = this.playerOrder[idx];
            const player = this.players[pid];

            if (player && player.connected) {
                moved++;
            }

            guard++;
        }

        this.turnIndex = idx;
    }

    resetTurnTimer() {
        this.clearTurnTimer();

        if (!this.gameStarted || this.playerOrder.length === 0) return;
        if (this.getConnectedCount() === 0) return;

        const currentId = this.getCurrentPlayerId();
        const currentPlayer = currentId ? this.players[currentId] : null;

        if (!currentPlayer || !currentPlayer.connected) {
            this.advanceTurn(1);
            this.broadcastUpdate();
            return;
        }

        this.turnTimer = setTimeout(() => {
            this.autoPlayTurn();
        }, 60000);
    }

    autoPlayTurn() {
        if (!this.gameStarted || this.playerOrder.length === 0) return;

        const currentId = this.getCurrentPlayerId();
        const p = currentId ? this.players[currentId] : null;

        if (!p || !p.connected) {
            this.advanceTurn(1);
            this.broadcastUpdate();
            return;
        }

        io.emit('notification', `Ο χρόνος έληξε! Auto-pass για: ${p.name}`);

        if (this.penaltyStack > 0) {
            for (let i = 0; i < this.penaltyStack; i++) {
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
        let username;
        let sessionId;

        if (typeof data === 'object' && data !== null) {
            username = data.username;
            sessionId = data.sessionId;
        } else {
            username = data;
            sessionId = null;
        }

        const existingId = Object.keys(this.players).find(
            (id) => this.players[id].sessionId === sessionId && sessionId != null
        );

        if (existingId) {
            this.players[socket.id] = this.players[existingId];
            this.players[socket.id].id = socket.id;
            this.players[socket.id].connected = true;

            const idx = this.playerOrder.indexOf(existingId);
            if (idx !== -1) {
                this.playerOrder[idx] = socket.id;
                if (this.turnIndex === idx) {
                    // turn index remains valid because only id changed
                }
            }

            delete this.players[existingId];

            socket.emit('rejoinSuccess', {
                gameStarted: this.gameStarted,
                myHand: this.players[socket.id].hand,
                history: this.roundHistory
            });

            if (this.gameStarted) {
                socket.emit('gameReady');
                this.broadcastUpdate();
            } else {
                io.emit('playerCountUpdate', this.playerOrder.length);
            }

            return;
        }

        if (this.gameStarted) {
            socket.emit('notification', 'Το παιχνίδι έχει ήδη ξεκινήσει!');
            return;
        }

        let cleanName = username ? String(username).replace(/[<>]/g, '').trim() : `Παίκτης ${this.playerOrder.length + 1}`;
        if (!cleanName) cleanName = `Παίκτης ${this.playerOrder.length + 1}`;
        cleanName = cleanName.substring(0, 15);

        if (['δήμητρα', 'δημητρα', 'δημητρούλα'].includes(cleanName.toLowerCase())) {
            cleanName += ' ❤️';
        }

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

    playCard(socket, data) {
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id) return;

        const p = this.players[socket.id];
        if (!p || data == null || data.index === undefined) return;

        const card = p.hand[data.index];
        if (!card) return;

        const topCard = this.discardPile[this.discardPile.length - 1];
        if (!topCard) return;

        const effectiveSuit = this.activeSuit || topCard.suit;
        let isValid = false;

        if (this.penaltyStack > 0) {
            if (this.penaltyType === '7' && card.value === '7') isValid = true;
            if (this.penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            if (card.value === 'A') isValid = true;
            else if (card.value === topCard.value || card.suit === effectiveSuit) isValid = true;
            else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') isValid = true;
        }

        if (!isValid) {
            socket.emit('invalidMove');
            return;
        }

        if (card.value === 'A') {
            this.activeSuit = data.declaredSuit || card.suit;
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
                io.emit('notification', `Ο/Η ${p.name} έκλεισε με 8 και τραβάει αναγκαστικά φύλλο! 🃏`);
                this.processCardLogic(card, p);
                this.broadcastUpdate();
                return;
            }

            let isPenaltyHandled = false;

            const nextVictim = this.playerOrder[
                (this.turnIndex + this.direction + this.playerOrder.length) % this.playerOrder.length
            ];
            const prevVictim = this.playerOrder[
                (this.turnIndex - this.direction + this.playerOrder.length) % this.playerOrder.length
            ];

            if (card.value === 'J' && card.color === 'black') {
                const totalPenalty = (this.penaltyType === 'J' ? this.penaltyStack : 0) + 10;
                for (let i = 0; i < totalPenalty; i++) this.safeDraw(this.players[nextVictim]);
                io.emit('notification', `Κλείσιμο με Μαύρο Βαλέ! +${totalPenalty} στον/στην ${this.players[nextVictim].name}!`);
                this.penaltyStack = 0;
                this.penaltyType = null;
                isPenaltyHandled = true;
            } else if (card.value === '7') {
                const totalPenalty = (this.penaltyType === '7' ? this.penaltyStack : 0) + 2;
                for (let i = 0; i < totalPenalty; i++) this.safeDraw(this.players[nextVictim]);
                io.emit('notification', `Κλείσιμο με 7! +${totalPenalty} στον/στην ${this.players[nextVictim].name}!`);
                this.penaltyStack = 0;
                this.penaltyType = null;
                isPenaltyHandled = true;
            } else if (card.value === '2') {
                this.safeDraw(this.players[prevVictim]);
                io.emit('notification', `Κλείσιμο με 2! +1 στον/στην ${this.players[prevVictim].name}!`);
                isPenaltyHandled = true;
            }

            this.clearTurnTimer();
            this.broadcastUpdate();

            setTimeout(() => this.handleRoundEnd(socket.id, card.value === 'A'), isPenaltyHandled ? 3000 : 1500);
            return;
        }

        this.processCardLogic(card, p);
        this.broadcastUpdate();
    }

    drawCard(socket) {
        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id) return;

        const p = this.players[socket.id];
        if (!p) return;

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

        const p = this.players[socket.id];
        if (!p) return;

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
        const isStart = !p || !p.id;

        if (card.value === '2') {
            this.consecutiveTwos++;
            if (!isStart) {
                let msg = 'Πάρε μία! 🃏';
                if (this.consecutiveTwos >= 3) {
                    msg += '\nΞες πώς πάνε αυτά! 😂';
                    this.consecutiveTwos = 0;
                }
                io.emit('notification', msg);

                // ΟΠΩΣ ΤΟ ΘΕΛΕΙΣ: το 2 δίνει στον προηγούμενο παίκτη
                const victimId = this.playerOrder[
                    (this.turnIndex - this.direction + this.playerOrder.length) % this.playerOrder.length
                ];
                this.safeDraw(this.players[victimId]);
            }
        } else {
            this.consecutiveTwos = 0;
        }

        if (card.value === '8') {
            advance = false;
            if (!isStart) p.hasDrawn = false;
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
            steps = this.playerOrder.length === 2 ? 0 : 2;
            advance = this.playerOrder.length !== 2;
            if (!isStart) io.emit('notification', 'Άραξε 🍹');
        }

        if (advance) this.advanceTurn(steps);
        else this.resetTurnTimer();
    }

    drawValidFirstCard() {
        if (this.deck.length === 0) return null;

        let attempts = 0;
        const maxAttempts = this.deck.length + 5;

        while (attempts < maxAttempts && this.deck.length > 0) {
            const firstCard = this.deck.pop();

            if (!(firstCard.value === 'J' && firstCard.color === 'black')) {
                return firstCard;
            }

            this.deck.unshift(firstCard);
            this.deck = this.shuffle(this.deck);
            attempts++;
        }

        // fallback ασφάλειας
        return this.deck.pop() || null;
    }

    startNewRound(reset = false) {
        this.gameStarted = true;
        this.starting = false;
        this.deck = this.createDeck();
        this.discardPile = [];
        this.penaltyStack = 0;
        this.penaltyType = null;
        this.activeSuit = null;
        this.consecutiveTwos = 0;
        this.direction = 1;

        this.clearTurnTimer();
        this.clearDealInterval();

        if (reset) {
            this.roundHistory = [];
            this.roundStarterIndex = 0;
            this.turnIndex = 0;
            this.playerOrder.forEach((id) => {
                if (this.players[id]) {
                    this.players[id].totalScore = 0;
                    this.players[id].hats = 0;
                }
            });
        } else {
            this.roundStarterIndex++;
            this.turnIndex = this.roundStarterIndex % this.playerOrder.length;
        }

        this.playerOrder.forEach((id) => {
            if (this.players[id]) {
                this.players[id].hand = [];
                this.players[id].hasDrawn = false;
                this.players[id].hasAtePenalty = false;
            }
        });

        let dealCount = 0;

        this.dealInterval = setInterval(() => {
            this.playerOrder.forEach((id) => {
                if (this.deck.length > 0 && this.players[id]) {
                    this.players[id].hand.push(this.deck.pop());
                }
            });

            if (++dealCount === 11) {
                this.clearDealInterval();

                const firstCard = this.drawValidFirstCard();
                if (!firstCard) {
                    io.emit('notification', 'Σφάλμα εκκίνησης γύρου: δεν βρέθηκε αρχικό φύλλο.');
                    this.gameStarted = false;
                    return;
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
        this.clearTurnTimer();

        const historyEntry = {};

        this.playerOrder.forEach((id) => {
            if (!this.players[id]) return;

            if (id === winnerId) {
                historyEntry[id] = 'WC';
            } else {
                let pts = this.calculateHandScore(this.players[id].hand);
                if (closedWithAce) pts += 50;
                this.players[id].totalScore += pts;
                historyEntry[id] = this.players[id].totalScore;
            }
        });

        this.roundHistory.push(historyEntry);

        io.emit('revealHands', this.playerOrder.map((id) => this.players[id]).filter(Boolean));
        io.emit('updateScoreboard', {
            history: this.roundHistory,
            players: this.playerOrder.map((id) => this.players[id]).filter(Boolean)
        });

        const losers = this.playerOrder.filter(
            (id) => this.players[id] && this.players[id].totalScore >= 500
        );

        if (losers.length === 1 && this.playerOrder.length > 1) {
            const winner = this.players[winnerId];
            io.emit('gameOver', `Ο γύρος τελείωσε! Νικητής: ${winner ? winner.name : 'Άγνωστος'}`);
            this.gameStarted = false;
            this.starting = false;
            return;
        }

        const target = losers.length > 0
            ? Math.max(...losers.map((id) => this.players[id].totalScore))
            : 0;

        this.playerOrder.forEach((id) => {
            if (this.players[id] && this.players[id].totalScore >= 500) {
                this.players[id].hats++;
                this.players[id].totalScore = target;
            }
        });

        setTimeout(() => this.startNewRound(false), 4000);
    }

    advanceTurn(steps) {
        if (this.playerOrder.length === 0) return;

        if (this.getConnectedCount() === 0) {
            this.clearTurnTimer();
            return;
        }

        this.moveTurnToNextConnected(Math.max(steps, 1));

        this.playerOrder.forEach((id) => {
            if (this.players[id]) {
                this.players[id].hasDrawn = false;
                this.players[id].hasAtePenalty = false;
            }
        });

        this.resetTurnTimer();
    }

    broadcastUpdate() {
        if (this.playerOrder.length === 0) return;

        const currentId = this.playerOrder[this.turnIndex];
        const cp = this.players[currentId];

        const publicPlayers = this.playerOrder
            .map((pid) => {
                const p = this.players[pid];
                if (!p) return null;
                return {
                    id: pid,
                    name: p.name,
                    handCount: p.hand.length,
                    hats: p.hats,
                    totalScore: p.totalScore,
                    connected: p.connected
                };
            })
            .filter(Boolean);

        this.playerOrder.forEach((id) => {
            const p = this.players[id];
            if (!p) return;

            io.to(id).emit('updateUI', {
                players: publicPlayers,
                topCard: this.discardPile[this.discardPile.length - 1] || null,
                penalty: this.penaltyStack,
                direction: this.direction,
                currentPlayerName: cp ? cp.name : '...',
                currentPlayerId: currentId,
                activeSuit: this.activeSuit,
                deckCount: this.deck.length,
                myHand: p.hand,
                isMyTurn: id === currentId
            });
        });
    }

    disconnectPlayer(socketId) {
        if (!this.players[socketId]) return;

        this.players[socketId].connected = false;

        if (!this.gameStarted) {
            this.playerOrder = this.playerOrder.filter((id) => id !== socketId);
            delete this.players[socketId];
            io.emit('playerCountUpdate', this.playerOrder.length);

            if (this.playerOrder.length === 0) {
                this.startLobbyTimer();
            }
            return;
        }

        if (this.getConnectedCount() === 0) {
            this.gameStarted = false;
            this.starting = false;
            this.clearTurnTimer();
            this.startLobbyTimer();
            return;
        }

        if (this.playerOrder[this.turnIndex] === socketId) {
            this.advanceTurn(1);
        }

        this.broadcastUpdate();
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
            game.clearLobbyTimer();
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
