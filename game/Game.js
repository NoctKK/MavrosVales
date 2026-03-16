const {
    TURN_TIME_MS,
    LOBBY_IDLE_MS,
    ROUND_RESTART_MS,
    DEAL_INTERVAL_MS,
    STARTING_HAND_SIZE,
    MAX_SCORE,
    MAX_NAME_LEN,
    DISCONNECT_GRACE_MS,
    SUITS,
    VALUES
} = require('./constants');

class Game {
    constructor(io) {
        this.io = io;

        this.deck = [];
        this.discardPile = [];
        this.discardCount = 0;

        this.players = {};
        this.playerOrder = [];

        this.gameStarted = false;
        this.starting = false;
        this.gamePaused = false;
        this.pauseReason = '';
        this.disconnectedPlayerId = null;

        this.roundHistory = [];
        this.roundStarterIndex = 0;

        this.timers = {
            lobby: null,
            deal: null,
            turn: null,
            restart: null,
            disconnectGrace: null
        };

        this.resetRoundState();
    }

    resetRoundState() {
        this.penaltyStack = 0;
        this.penaltyType = null;
        this.activeSuit = null;
        this.consecutiveTwos = 0;
        this.direction = 1;
        this.turnIndex = 0;
    }

    clearAllTimers() {
        Object.values(this.timers).forEach((t) => {
            if (t) {
                clearTimeout(t);
                clearInterval(t);
            }
        });

        this.timers = {
            lobby: null,
            deal: null,
            turn: null,
            restart: null,
            disconnectGrace: null
        };
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
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck;
    }

    calculateHandScore(hand) {
        return hand.reduce((score, card) => {
            if (card.value === 'A') return score + 50;
            if (['K', 'Q', 'J', '10'].includes(card.value)) return score + 10;
            return score + (Number(card.value) || 0);
        }, 0);
    }

    refreshLobbyTimer() {
        if (this.gameStarted) return;

        if (this.timers.lobby) clearTimeout(this.timers.lobby);
        this.timers.lobby = setTimeout(() => this.resetLobby(), LOBBY_IDLE_MS);
    }

    resetLobby() {
        if (this.gameStarted) return;

        this.clearAllTimers();

        this.players = {};
        this.playerOrder = [];
        this.deck = [];
        this.discardPile = [];
        this.discardCount = 0;
        this.roundHistory = [];
        this.roundStarterIndex = 0;
        this.resetRoundState();

        this.gamePaused = false;
        this.pauseReason = '';
        this.disconnectedPlayerId = null;

        this.io.emit('playerCountUpdate', 0);
        this.io.emit('notification', 'Το lobby μηδενίστηκε λόγω αδράνειας.');
    }

    resetToLobby() {
        this.clearAllTimers();

        this.deck = [];
        this.discardPile = [];
        this.discardCount = 0;

        this.gameStarted = false;
        this.starting = false;
        this.gamePaused = false;
        this.pauseReason = '';
        this.disconnectedPlayerId = null;

        this.roundHistory = [];
        this.roundStarterIndex = 0;
        this.resetRoundState();

        this.playerOrder = this.playerOrder.filter((id) => this.players[id] && this.players[id].connected);

        Object.keys(this.players).forEach((id) => {
            const p = this.players[id];

            if (!p || !p.connected) {
                delete this.players[id];
                return;
            }

            p.hand = [];
            p.totalScore = 0;
            p.hats = 0;
            p.hasDrawn = false;
            p.hasAtePenalty = false;
            p.lastChat = 0;
        });

        this.io.emit('playerCountUpdate', this.playerOrder.length);
    }

    forceEmergencyReset() {
        this.resetToLobby();
        this.io.emit('gameInterrupted', { message: '🚨 Σφάλμα διακομιστή. Επαναφορά...' });
        this.io.emit('notification', '🚨 Σφάλμα διακομιστή. Επαναφορά...');
        this.refreshLobbyTimer();
    }

    pauseGameForDisconnect(socketId) {
        this.gamePaused = true;
        this.pauseReason = 'disconnect';
        this.disconnectedPlayerId = socketId;

        if (this.timers.turn) {
            clearTimeout(this.timers.turn);
            this.timers.turn = null;
        }

        this.io.emit('notification', 'Παίκτης αποσυνδέθηκε. Παύση παιχνιδιού, αναμονή για επανασύνδεση...');

        if (this.timers.disconnectGrace) clearTimeout(this.timers.disconnectGrace);

        this.timers.disconnectGrace = setTimeout(() => {
            this.resetToLobby();
            this.io.emit('gameInterrupted', {
                message: 'Ο παίκτης δεν επανήλθε εγκαίρως. Το παιχνίδι διεκόπη.'
            });
            this.io.emit('notification', 'Ο παίκτης δεν επανήλθε εγκαίρως. Το παιχνίδι διεκόπη.');
            this.refreshLobbyTimer();
        }, DISCONNECT_GRACE_MS);
    }

    resumeGameAfterReconnect() {
        this.gamePaused = false;
        this.pauseReason = '';
        this.disconnectedPlayerId = null;

        if (this.timers.disconnectGrace) {
            clearTimeout(this.timers.disconnectGrace);
            this.timers.disconnectGrace = null;
        }

        this.io.emit('notification', 'Ο παίκτης επανασυνδέθηκε. Το παιχνίδι συνεχίζεται!');
        this.resetTurnTimer();
        this.broadcastUpdate();
    }

    safeDraw(player) {
        if (!player) return false;

        if (this.deck.length === 0) {
            if (this.discardPile.length <= 1) return false;

            const topCard = this.discardPile.pop();
            this.deck = this.shuffle([...this.discardPile]);
            this.discardPile = [topCard];

            this.io.emit('notification', '🔄 Ανακάτεμα τράπουλας!');
        }

        if (this.deck.length > 0) {
            player.hand.push(this.deck.pop());
            return true;
        }

        return false;
    }

    resetTurnTimer() {
        if (this.timers.turn) clearTimeout(this.timers.turn);
        if (!this.gameStarted || this.playerOrder.length === 0 || this.gamePaused) return;

        this.timers.turn = setTimeout(() => this.autoPlayTurn(), TURN_TIME_MS);
    }

    getNextActivePlayerIndex(startIndex, steps = 1) {
        const activeCount = this.playerOrder.filter((id) => this.players[id] && this.players[id].connected).length;
        if (activeCount === 0) return 0;

        let idx = startIndex;
        const n = this.playerOrder.length;

        for (let i = 0; i < steps; i++) {
            do {
                idx = (idx + this.direction + n) % n;
            } while (!this.players[this.playerOrder[idx]] || !this.players[this.playerOrder[idx]].connected);
        }

        return idx;
    }

    getPreviousActivePlayerIndex(startIndex, steps = 1) {
        const activeCount = this.playerOrder.filter((id) => this.players[id] && this.players[id].connected).length;
        if (activeCount === 0) return 0;

        let idx = startIndex;
        const n = this.playerOrder.length;

        for (let i = 0; i < steps; i++) {
            do {
                idx = (idx - this.direction + n) % n;
            } while (!this.players[this.playerOrder[idx]] || !this.players[this.playerOrder[idx]].connected);
        }

        return idx;
    }

    advanceTurn(steps) {
        if (this.playerOrder.length === 0) return;

        this.turnIndex = this.getNextActivePlayerIndex(this.turnIndex, steps);

        this.playerOrder.forEach((id) => {
            if (this.players[id]) {
                this.players[id].hasDrawn = false;
                this.players[id].hasAtePenalty = false;
            }
        });

        this.resetTurnTimer();
    }

    autoPlayTurn() {
        if (!this.gameStarted || this.playerOrder.length === 0 || this.gamePaused) return;

        const currentId = this.playerOrder[this.turnIndex];
        const player = this.players[currentId];

        if (!player || !player.connected) {
            this.advanceTurn(1);
            this.broadcastUpdate();
            return;
        }

        this.io.emit('notification', `Ο χρόνος έληξε! Auto-pass: ${player.name}`);

        if (this.penaltyStack > 0) {
            for (let i = 0; i < this.penaltyStack; i++) this.safeDraw(player);
            this.penaltyStack = 0;
            this.penaltyType = null;
            player.hasAtePenalty = true;
        } else if (!player.hasDrawn) {
            this.safeDraw(player);
            player.hasDrawn = true;
        }

        this.advanceTurn(1);
        this.broadcastUpdate();
    }

    joinGame(socket, data) {
        this.refreshLobbyTimer();

        let username = data?.username;
        let sessionId = data?.sessionId;

        if (sessionId != null) {
            sessionId = String(sessionId).trim().slice(0, 100);
            if (!sessionId) sessionId = null;
        } else {
            sessionId = null;
        }

        let cleanName = username
            ? String(username).replace(/[<>]/g, '').trim().substring(0, MAX_NAME_LEN)
            : `Παίκτης ${this.playerOrder.length + 1}`;

        if (!cleanName) cleanName = `Παίκτης ${this.playerOrder.length + 1}`;

        if (['δήμητρα', 'δημητρα', 'δημητρούλα'].includes(cleanName.toLowerCase())) {
            cleanName += ' ❤️';
        }

        const existingId = Object.keys(this.players).find(
            (id) => this.players[id].sessionId === sessionId && sessionId != null
        );

        if (existingId) {
            if (existingId === socket.id) {
                this.players[socket.id].connected = true;

                socket.emit('rejoinSuccess', {
                    gameStarted: this.gameStarted,
                    myHand: this.players[socket.id].hand,
                    history: this.roundHistory
                });

                if (this.gameStarted) {
                    if (this.gamePaused && this.disconnectedPlayerId === socket.id) {
                        this.resumeGameAfterReconnect();
                    } else {
                        this.broadcastUpdate();
                    }
                } else {
                    this.io.emit('playerCountUpdate', this.playerOrder.length);
                }

                return;
            }

            this.players[socket.id] = this.players[existingId];
            this.players[socket.id].id = socket.id;
            this.players[socket.id].connected = true;

            const idx = this.playerOrder.indexOf(existingId);
            if (idx !== -1) this.playerOrder[idx] = socket.id;

            delete this.players[existingId];

            socket.emit('rejoinSuccess', {
                gameStarted: this.gameStarted,
                myHand: this.players[socket.id].hand,
                history: this.roundHistory
            });

            this.io.emit('playerCountUpdate', this.playerOrder.length);

            if (this.gameStarted) {
                if (this.gamePaused && this.disconnectedPlayerId === existingId) {
                    this.disconnectedPlayerId = socket.id;
                    this.resumeGameAfterReconnect();
                } else {
                    this.broadcastUpdate();
                }
            }

            return;
        }

        if (this.gameStarted) {
            socket.emit('notification', 'Το παιχνίδι έχει ήδη ξεκινήσει!');
            return;
        }

        this.players[socket.id] = {
            id: socket.id,
            sessionId,
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

        this.io.emit('playerCountUpdate', this.playerOrder.length);
        socket.emit('joinedLobby');
    }

    playCard(socket, data) {
        this.refreshLobbyTimer();

        if (this.gamePaused) {
            socket.emit('notification', 'Το παιχνίδι είναι προσωρινά σε παύση λόγω αποσύνδεσης παίκτη.');
            return;
        }

        const player = this.players[socket.id];

        if (!data || typeof data !== 'object') {
            socket.emit('actionRejected');
            return;
        }

        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id || !player) {
            socket.emit('actionRejected');
            return;
        }

        if (!Number.isInteger(data.index) || data.index < 0 || data.index >= player.hand.length) {
            socket.emit('actionRejected');
            return;
        }

        if (data.declaredSuit && !SUITS.includes(data.declaredSuit)) {
            socket.emit('actionRejected');
            return;
        }

        const card = player.hand[data.index];
        const topCard = this.discardPile[this.discardPile.length - 1];

        if (!topCard) {
            socket.emit('actionRejected');
            return;
        }

        const top2 = this.discardPile.length >= 2 ? this.discardPile[this.discardPile.length - 2] : null;
        const effectiveSuit = this.activeSuit || topCard.suit;

        let isValid = false;

        if (this.penaltyStack > 0) {
            if (this.penaltyType === '7' && card.value === '7') isValid = true;
            if (this.penaltyType === 'J' && card.value === 'J') isValid = true;
        } else {
            if (card.value === 'A') {
                if (topCard.value !== 'A') {
                    isValid = true;
                } else if (this.activeSuit && card.suit === this.activeSuit && !data.declaredSuit) {
                    isValid = true;
                }
            } else if (card.value === topCard.value || card.suit === effectiveSuit) {
                isValid = true;
            } else if (card.value === 'J' && card.color === 'red' && topCard.value === 'J') {
                isValid = true;
            }
        }

        if (!isValid) {
            socket.emit('invalidMove');
            return;
        }

        const isSpecial = ['A', '2', '3', '7', '8', '9', 'J'].includes(card.value);

        if (!isSpecial) {
            if (card.value === topCard.value && card.suit === topCard.suit) {
                this.io.emit('notification', `${player.name}: Copy paste! 👯`);
            } else if (
                top2 &&
                topCard.value === top2.value &&
                topCard.suit === top2.suit &&
                card.value === topCard.value &&
                card.suit !== topCard.suit
            ) {
                this.io.emit('notification', `${player.name}: Copy erased! ❌`);
            }
        }

        if (card.value === 'A') {
            if (topCard.value === 'A' && this.activeSuit && card.suit === this.activeSuit && !data.declaredSuit) {
                this.activeSuit = null;
                this.io.emit('notification', `${player.name}: Σαν φύλλο!`);
            } else {
                this.activeSuit = data.declaredSuit || card.suit;
            }
        } else {
            this.activeSuit = null;
        }

        player.hand.splice(data.index, 1);
        this.discardPile.push(card);
        this.discardCount++;

        if (player.hand.length === 1) {
            this.io.emit('notification', `${player.name}: Μία μία μία μία! ⚠️`);
        }

        if (player.hand.length === 0) {
            if (card.value === '8') {
                this.safeDraw(player);
                this.io.emit('notification', `${player.name}: Έκλεισα με 8 και τραβάω αναγκαστικά φύλλο! 🃏`);
                this.processCardLogic(card, player);
                this.broadcastUpdate();
                return;
            }

            let isPenaltyHandled = false;
            const nextVictim = this.playerOrder[this.getNextActivePlayerIndex(this.turnIndex, 1)];
            const prevVictim = this.playerOrder[this.getPreviousActivePlayerIndex(this.turnIndex, 1)];

            if (card.value === 'J' && card.color === 'black') {
                const totalPenalty = (this.penaltyType === 'J' ? this.penaltyStack : 0) + 10;

                for (let i = 0; i < totalPenalty; i++) this.safeDraw(this.players[nextVictim]);

                this.io.emit(
                    'notification',
                    `${player.name}: Κλείσιμο με Μαύρο Βαλέ! +${totalPenalty} στον/στην ${this.players[nextVictim].name}!`
                );

                this.penaltyStack = 0;
                this.penaltyType = null;
                isPenaltyHandled = true;
            } else if (card.value === '7') {
                const totalPenalty = (this.penaltyType === '7' ? this.penaltyStack : 0) + 2;

                for (let i = 0; i < totalPenalty; i++) this.safeDraw(this.players[nextVictim]);

                this.io.emit(
                    'notification',
                    `${player.name}: Κλείσιμο με 7! +${totalPenalty} στον/στην ${this.players[nextVictim].name}!`
                );

                this.penaltyStack = 0;
                this.penaltyType = null;
                isPenaltyHandled = true;
            } else if (card.value === '2') {
                this.safeDraw(this.players[prevVictim]);
                this.io.emit(
                    'notification',
                    `${player.name}: Κλείσιμο με 2! +1 στον/στην ${this.players[prevVictim].name}!`
                );
                isPenaltyHandled = true;
            }

            if (this.timers.turn) clearTimeout(this.timers.turn);

            this.broadcastUpdate();

            this.timers.restart = setTimeout(
                () => this.handleRoundEnd(socket.id, card.value === 'A'),
                isPenaltyHandled ? 3000 : 1500
            );

            return;
        }

        this.processCardLogic(card, player);
        this.broadcastUpdate();
    }

    drawCard(socket) {
        this.refreshLobbyTimer();

        if (this.gamePaused) {
            socket.emit('notification', 'Το παιχνίδι είναι προσωρινά σε παύση λόγω αποσύνδεσης παίκτη.');
            return;
        }

        const player = this.players[socket.id];

        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id || !player) {
            socket.emit('actionRejected');
            return;
        }

        if (this.penaltyStack > 0) {
            for (let i = 0; i < this.penaltyStack; i++) this.safeDraw(player);

            this.penaltyStack = 0;
            this.penaltyType = null;
            player.hasAtePenalty = true;

            this.resetTurnTimer();
            this.broadcastUpdate();
            return;
        }

        if (player.hasDrawn) {
            socket.emit('notification', 'Έχεις ήδη τραβήξει φύλλο!');
            return;
        }

        this.safeDraw(player);
        player.hasDrawn = true;

        this.resetTurnTimer();
        this.broadcastUpdate();
    }

    passTurn(socket) {
        this.refreshLobbyTimer();

        if (this.gamePaused) {
            socket.emit('notification', 'Το παιχνίδι είναι προσωρινά σε παύση λόγω αποσύνδεσης παίκτη.');
            return;
        }

        const player = this.players[socket.id];

        if (!this.gameStarted || this.playerOrder[this.turnIndex] !== socket.id || !player) return;

        if (this.penaltyStack > 0) {
            socket.emit('notification', 'Πρέπει να τραβήξεις τις κάρτες ποινής πρώτα!');
            return;
        }

        if (!player.hasDrawn) {
            socket.emit('notification', 'Δεν μπορείς να πας πάσο αν δεν τραβήξεις φύλλο!');
            return;
        }

        this.advanceTurn(1);
        this.broadcastUpdate();
    }

    processCardLogic(card, player) {
        let advance = true;
        let steps = 1;
        const isStart = !player || !player.id;

        if (card.value === '2') {
            this.consecutiveTwos++;

            if (!isStart) {
                let msg = `${player.name}: Πάρε μία! 🃏`;

                if (this.consecutiveTwos >= 3) {
                    msg += '\nΞες πώς πάνε αυτά! 😂';
                    this.consecutiveTwos = 0;
                }

                this.io.emit('notification', msg);

                const victimId = this.playerOrder[this.getPreviousActivePlayerIndex(this.turnIndex, 1)];
                this.safeDraw(this.players[victimId]);
            }
        } else {
            this.consecutiveTwos = 0;
        }

        if (card.value === '8') {
            advance = false;
            if (!isStart) player.hasDrawn = false;
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

            if (!isStart) {
                if (this.playerOrder.length === 2) this.io.emit('notification', `${player.name}: Ξανά παίζω! 🍹`);
                else this.io.emit('notification', `${player.name}: Άραξε 🍹`);
            }
        }

        if (advance) this.advanceTurn(steps);
        else this.resetTurnTimer();
    }

    startNewRound(reset = false) {
        this.gameStarted = true;
        this.starting = false;
        this.gamePaused = false;
        this.pauseReason = '';
        this.disconnectedPlayerId = null;

        this.deck = this.createDeck();
        this.discardPile = [];
        this.discardCount = 0;
        this.resetRoundState();
        this.clearAllTimers();

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
            this.roundStarterIndex = (this.roundStarterIndex + 1) % this.playerOrder.length;
            this.turnIndex = this.roundStarterIndex;

            if (!this.players[this.playerOrder[this.turnIndex]]?.connected) {
                this.turnIndex = this.getNextActivePlayerIndex(this.turnIndex, 1);
            }
        }

        this.playerOrder.forEach((id) => {
            if (this.players[id]) {
                this.players[id].hand = [];
                this.players[id].hasDrawn = false;
                this.players[id].hasAtePenalty = false;
            }
        });

        let dealCount = 0;

        this.timers.deal = setInterval(() => {
            this.playerOrder.forEach((id) => {
                if (this.deck.length > 0 && this.players[id]) {
                    this.players[id].hand.push(this.deck.pop());
                }
            });

            if (++dealCount === STARTING_HAND_SIZE) {
                clearInterval(this.timers.deal);
                this.timers.deal = null;

                let firstCard = this.deck.pop();

                while (firstCard && firstCard.value === 'J' && firstCard.color === 'black') {
                    this.deck.unshift(firstCard);
                    firstCard = this.deck.pop();
                }

                if (!firstCard) return;

                this.discardPile.push(firstCard);
                this.discardCount++;

                this.io.emit('gameReady');
                this.processCardLogic(firstCard, { id: null });
                this.resetTurnTimer();
                this.broadcastUpdate();
            }
        }, DEAL_INTERVAL_MS);
    }

    handleRoundEnd(winnerId, closedWithAce) {
        this.clearAllTimers();

        const historyEntry = {};

        this.playerOrder.forEach((id) => {
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

        const under500 = this.playerOrder.filter((id) => this.players[id] && this.players[id].totalScore < MAX_SCORE);
        const overOrEqual500 = this.playerOrder.filter((id) => this.players[id] && this.players[id].totalScore >= MAX_SCORE);

        let finalWinnerId = null;

        if (this.playerOrder.length === 2) {
            if (overOrEqual500.length >= 1) {
                finalWinnerId = under500.length >= 1 ? under500[0] : this.playerOrder.find((id) => id !== overOrEqual500[0]) || null;
            }
        } else {
            if (under500.length === 1) {
                finalWinnerId = under500[0];
            } else if (under500.length >= 2 && overOrEqual500.length > 0) {
                const rescueScore = Math.max(...under500.map((id) => this.players[id].totalScore));

                overOrEqual500.forEach((id) => {
                    this.players[id].hats++;
                    this.players[id].totalScore = rescueScore;
                });
            }
        }

        this.io.emit('revealHands', this.playerOrder.map((id) => this.players[id]));
        this.io.emit('updateScoreboard', {
            history: this.roundHistory,
            players: this.playerOrder.map((id) => this.players[id])
        });

        if (finalWinnerId) {
            const winner = this.players[finalWinnerId];
            this.gameStarted = false;
            this.io.emit('gameOver', `🏆 Νικητής: ${winner.name}`);
            this.refreshLobbyTimer();
            return;
        }

        this.timers.restart = setTimeout(() => this.startNewRound(false), ROUND_RESTART_MS);
    }

    broadcastUpdate() {
        if (!this.playerOrder.length) return;

        const currentId = this.playerOrder[this.turnIndex];
        const currentPlayer = this.players[currentId];

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

            this.io.to(id).emit('updateUI', {
                players: publicPlayers,
                topCard: this.discardPile[this.discardPile.length - 1] || null,
                discardCount: this.discardCount,
                penalty: this.penaltyStack,
                direction: this.direction,
                currentPlayerName: currentPlayer ? currentPlayer.name : '...',
                currentPlayerId: currentId,
                activeSuit: this.activeSuit,
                deckCount: this.deck.length,
                myHand: p.hand,
                isMyTurn: id === currentId
            });
        });
    }

    disconnectPlayer(socketId) {
        this.refreshLobbyTimer();

        if (!this.players[socketId]) return;

        this.players[socketId].connected = false;

        const activeCount = this.playerOrder.filter((id) => this.players[id] && this.players[id].connected).length;

        if (!this.gameStarted) {
            this.playerOrder = this.playerOrder.filter((id) => id !== socketId);
            delete this.players[socketId];
            this.io.emit('playerCountUpdate', this.playerOrder.length);
            return;
        }

        if (activeCount < 2) {
            this.pauseGameForDisconnect(socketId);
            return;
        }

        if (this.playerOrder[this.turnIndex] === socketId) {
            this.advanceTurn(1);
            this.broadcastUpdate();
        }
    }
}

module.exports = Game;
