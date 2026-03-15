const socket = io();

let myId = null;
let lastClick = 0;
const CLICK_DELAY = 220;
let actionLocked = false;
let gameScale = 1;
let selectedAceIndex = null;
let lastPlayerId = null;
let timerEnd = 0;
let animationFrameId = null;
let fullScoreHistory = [];
let isScoreboardExpanded = false;
let msgQueue = [];
let isMsgShowing = false;
let lastDiscardCount = 0;
let hasJoinedLobby = false;
