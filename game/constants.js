const TURN_TIME_MS = 60000;
const LOBBY_IDLE_MS = 120000;
const ROUND_RESTART_MS = 4000;
const DEAL_INTERVAL_MS = 50;
const STARTING_HAND_SIZE = 11;
const MAX_SCORE = 500;
const MAX_NAME_LEN = 15;
const MAX_CHAT_LEN = 80;
const DISCONNECT_GRACE_MS = 90000;

const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

module.exports = {
    TURN_TIME_MS,
    LOBBY_IDLE_MS,
    ROUND_RESTART_MS,
    DEAL_INTERVAL_MS,
    STARTING_HAND_SIZE,
    MAX_SCORE,
    MAX_NAME_LEN,
    MAX_CHAT_LEN,
    DISCONNECT_GRACE_MS,
    SUITS,
    VALUES
};
