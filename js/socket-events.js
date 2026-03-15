function showNextMsg() {
    const o = $("msg-overlay");
    if (!o) return;

    if (msgQueue.length === 0) {
        isMsgShowing = false;
        o.style.display = "none";
        return;
    }

    isMsgShowing = true;
    o.innerText = msgQueue.shift();
    o.style.display = "block";
    o.style.animation = "none";
    o.offsetHeight;
    o.style.animation = "popMsg 0.18s forwards";

    setTimeout(() => {
        o.style.display = "none";
        setTimeout(showNextMsg, 40);
    }, 900);
}

function startHeartbeat() {
    if (heartbeatIntervalId) return;

    heartbeatIntervalId = setInterval(() => {
        if (socket && socket.connected) {
            socket.emit("heartbeat");
        }
    }, HEARTBEAT_MS);
}

function stopHeartbeat() {
    if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = null;
    }
}

socket.on("connect", () => {
    const reconnectBtn = $("reconnect-btn");
    if (reconnectBtn) reconnectBtn.style.display = "none";

    myId = socket.id;
    startHeartbeat();

    const name = sessionStorage.getItem("mv_username");
    const session = sessionStorage.getItem("mv_session");

    if (name && session) {
        socket.emit("joinGame", { username: name, sessionId: session });
    } else {
        hasJoinedLobby = false;

        const loginArea = $("login-area");
        const waitingArea = $("waiting-area");

        if (loginArea) loginArea.style.display = "flex";
        if (waitingArea) waitingArea.style.display = "none";
    }
});

socket.on("connect_error", () => {
    const btn = $("login-btn");
    if (btn) {
        btn.disabled = false;
        btn.innerText = "ΕΙΣΟΔΟΣ";
    }
});

socket.on("disconnect", () => {
    actionLocked = false;
    selectedAceIndex = null;
    stopHeartbeat();

    const reconnectBtn = $("reconnect-btn");
    if (reconnectBtn) reconnectBtn.style.display = "flex";
});

socket.on("joinedLobby", () => {
    hasJoinedLobby = true;

    const waitingArea = $("waiting-area");
    const loginArea = $("login-area");
    const loginBtn = $("login-btn");

    if (loginArea) loginArea.style.display = "none";
    if (waitingArea) waitingArea.style.display = "block";

    if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.innerText = "ΕΙΣΟΔΟΣ";
    }
});

socket.on("chatUpdate", (data) => {
    const m = $("chat-messages");
    if (!m) return;

    const div = document.createElement("div");
    const b = document.createElement("b");
    b.style.color = "var(--gold)";
    b.textContent = data.name + ": ";
    div.appendChild(b);
    div.appendChild(document.createTextNode(data.text));

    m.appendChild(div);
    m.scrollTop = m.scrollHeight;

    if (m.children.length > 50) {
        m.removeChild(m.firstChild);
    }
});

socket.on("playerCountUpdate", (count) => {
    const waitingMsg = $("waiting-msg");
    const startBtn = $("start-btn");

    if (waitingMsg) {
        waitingMsg.innerText = `Συνδεδεμένοι παίκτες: ${count}`;
    }

    if (startBtn) {
        startBtn.style.display = count >= 2 ? "inline-block" : "none";
    }

    if (!hasJoinedLobby) {
        const loginArea = $("login-area");
        const waitingArea = $("waiting-area");

        if (loginArea) loginArea.style.display = "flex";
        if (waitingArea) waitingArea.style.display = "none";
    }
});

socket.on("gameReady", () => {
    const startScreen = $("start-screen");
    const scoreboard = $("scoreboard");
    const pileContainer = $("pile-container");

    if (startScreen) startScreen.style.display = "none";
    if (scoreboard) scoreboard.style.display = "block";
    if (pileContainer) pileContainer.innerHTML = "";

    lastDiscardCount = 0;
});

socket.on("gameInterrupted", (payload) => {
    clearGameTimer();
    actionLocked = false;
    lastPlayerId = null;
    selectedAceIndex = null;

    const aceModal = $("ace-modal");
    const victoryScreen = $("victory-screen");
    const gameWrapper = $("game-wrapper");
    const pileContainer = $("pile-container");
    const scoreboard = $("scoreboard");
    const startScreen = $("start-screen");
    const loginArea = $("login-area");
    const waitingArea = $("waiting-area");

    if (aceModal) aceModal.style.display = "none";
    if (victoryScreen) victoryScreen.style.display = "none";
    if (gameWrapper) gameWrapper.style.filter = "";
    if (pileContainer) pileContainer.innerHTML = "";
    if (scoreboard) scoreboard.style.display = "none";
    if (startScreen) startScreen.style.display = "flex";

    hasJoinedLobby = false;

    if (loginArea) loginArea.style.display = "flex";
    if (waitingArea) waitingArea.style.display = "none";

    lastDiscardCount = 0;

    if (payload && payload.message) {
        msgQueue.push(payload.message);

        if (msgQueue.length > 3) {
            msgQueue = msgQueue.slice(-3);
        }

        if (!isMsgShowing) showNextMsg();
    }
});

socket.on("notification", (m) => {
    if (m === "Το παιχνίδι έχει ήδη ξεκινήσει!") {
        const btn = $("login-btn");
        if (btn) {
            btn.disabled = false;
            btn.innerText = "ΕΙΣΟΔΟΣ";
        }
    }

    msgQueue.push(m);

    if (msgQueue.length > 3) {
        msgQueue = msgQueue.slice(-3);
    }

    if (!isMsgShowing) showNextMsg();
});

socket.on("actionRejected", () => {
    actionLocked = false;
});

socket.on("invalidMove", () => {
    actionLocked = false;
    msgQueue.push("⚠️ Άκυρη Κίνηση!");

    if (msgQueue.length > 3) {
        msgQueue = msgQueue.slice(-3);
    }

    if (!isMsgShowing) showNextMsg();

    document.querySelectorAll(".hand-card").forEach((c) => c.classList.add("shake"));
    setTimeout(() => {
        document.querySelectorAll(".hand-card").forEach((c) => c.classList.remove("shake"));
    }, 180);
});

socket.on("updateUI", (data) => {
    actionLocked = false;
    window.currentScoreData = data;
    window.currentTopCard = data.topCard;
    window.currentActiveSuit = data.activeSuit;

    const deckCount = $("deck-count");
    if (deckCount) deckCount.innerText = data.deckCount;

    if (data.currentPlayerId && data.currentPlayerId !== lastPlayerId) {
        lastPlayerId = data.currentPlayerId;
        startTimer(60);
    }

    if (data.topCard && data.discardCount !== undefined && data.discardCount > lastDiscardCount) {
        addCardToPile(data.topCard);
        lastDiscardCount = data.discardCount;
    }

    const suitDisplay = $("active-suit-display");
    if (suitDisplay) {
        if (data.activeSuit) {
            suitDisplay.innerText = data.activeSuit;
            suitDisplay.style.color = isRedSuit(data.activeSuit) ? "#ff4444" : "#222";
            suitDisplay.style.display = "block";
            suitDisplay.style.textShadow = "0 0 10px white, 0 0 20px white";
        } else {
            suitDisplay.style.display = "none";
        }
    }

    const ind = $("turn-indicator");
    const handCont = $("my-hand-container");

    if (ind && handCont) {
        if (data.isMyTurn) {
            ind.innerText = data.penalty > 0 ? `⚠️ ΦΑΕ ${data.penalty}!` : "ΔΙΚΗ ΣΟΥ ΣΕΙΡΑ";
            ind.style.borderColor = "#4f4";
            ind.style.color = "#4f4";
            handCont.classList.remove("not-my-turn");
        } else {
            ind.innerText = `ΠΑΙΖΕΙ: ${data.currentPlayerName}`;
            ind.style.borderColor = "#ff4444";
            ind.style.color = "#ffdddd";
            handCont.classList.add("not-my-turn");
        }
    }

    renderHand(data.myHand);
    distributePlayers(data.players, data.currentPlayerName, data.isMyTurn);
    updateDirectionIndicator(data.players, data.direction);
});

socket.on("revealHands", (playersData) => {
    clearGameTimer();
    lastPlayerId = null;

    const pileContainer = $("pile-container");
    if (pileContainer) pileContainer.innerHTML = "";

    lastDiscardCount = 0;

    const others = playersData.filter((p) => p.id !== myId);
    const slots = ["slot-left", "slot-top", "slot-right"];

    others.forEach((p, i) => {
        const container = $(slots[i]);
        if (!container || !p.hand) return;

        let cardsHtml = "";
        p.hand.forEach((c, idx) => {
            if (!c) return;
            const color = c.color === "red" ? "#d00" : "black";
            cardsHtml += `<div class="card" style="color:${color}; z-index:${idx};">${c.value}<div style="font-size:18px; line-height:1;">${c.suit}</div></div>`;
        });

        container.innerHTML = `
            <div class="panel player-info" style="opacity:1; z-index:2000;">
                <div class="player-name" style="font-weight:bold; font-size:18px;">${p.name}</div>
                <div style="font-size:12px; color:#4f4; margin-top:3px;">Σκορ: ${p.totalScore}</div>
            </div>
            <div class="player-cards" style="margin-top:10px;">${cardsHtml}</div>
            <div class="card-count-box" style="opacity:1">${p.hand.length} φύλλα</div>`;
    });
});

socket.on("gameOver", (msg) => {
    clearGameTimer();

    const gameWrapper = $("game-wrapper");
    const victoryMsg = $("victory-msg");
    const victoryScreen = $("victory-screen");

    if (gameWrapper) gameWrapper.style.filter = "blur(10px)";
    if (victoryMsg) victoryMsg.innerText = msg;
    if (victoryScreen) victoryScreen.style.display = "flex";
});

socket.on("rejoinSuccess", (data) => {
    hasJoinedLobby = true;

    const loginArea = $("login-area");
    const waitingArea = $("waiting-area");
    const startScreen = $("start-screen");
    const scoreboard = $("scoreboard");

    if (loginArea) loginArea.style.display = "none";

    if (data.gameStarted) {
        if (startScreen) startScreen.style.display = "none";
        fullScoreHistory = data.history || [];
        isScoreboardExpanded = false;
        renderScoreboard();
        if (scoreboard) scoreboard.style.display = "block";
    } else {
        if (waitingArea) waitingArea.style.display = "block";
        if (startScreen) startScreen.style.display = "flex";
    }
});

socket.on("updateScoreboard", (data) => {
    fullScoreHistory = data.history || [];
    isScoreboardExpanded = false;
    renderScoreboard();

    const scoreboard = $("scoreboard");
    if (scoreboard) scoreboard.style.display = "block";
});
