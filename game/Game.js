const {
    TURN_TIME_MS,
    LOBBY_IDLE_MS,
    ROUND_RESTART_MS,
    DEAL_INTERVAL_MS,
    STARTING_HAND_SIZE,
    MAX_SCORE,
    MAX_NAME_LEN,
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
        this.roundHistory = [];
        this.roundStarterIndex = 0;

        this.timers = { lobby: null, deal: null, turn: null, restart: null };
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
        Object.values(this.timers).forEach(t => {
            if (t) {
                clearTimeout(t);
                clearInterval(t);
            }
        });
        this.timers = { lobby: null, deal: null, turn: null, restart: null };
    }

    resetToLobby() {
        this.clearAllTimers();

        this.deck = [];
        this.discardPile = [];
        this.discardCount = 0;

        this.gameStarted = false;
        this.starting = false;
        this.roundHistory = [];
        this.roundStarterIndex = 0;
        this.resetRoundState();

        this.playerOrder = this.playerOrder.filter(id => this.players[id] && this.players[id].connected);

        Object.keys(this.players).forEach(id => {
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
        return this.shuffle
