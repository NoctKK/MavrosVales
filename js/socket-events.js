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

socket.on('connect', () => {
    $("reconnect-btn").style.display = 'none';
    myId = socket.id;

    const name = sessionStorage.getItem('mv_username');
    const session = sessionStorage.getItem('mv_session');
    if (name && session) {
        socket.emit('joinGame', { username: name, sessionId: session });
    }
});

socket.on('connect_error', () => {
    const btn = $("login-btn");
    if (btn) {
        btn.disabled = false;
        btn.innerText = 'ΕΙΣΟΔΟΣ';
    }
});

socket.on('disconnect', () => {
    actionLocked = false;
    selectedAceIndex = null;
    $("reconnect-btn").style.display = 'flex';
});

socket.on('joinedLobby', () => {
    const waitingArea = $("waiting-area");
    const loginArea = $("login-area");
    const loginBtn = $("login-btn");

    if (loginArea) loginArea.style.display = 'none';
    if (waitingArea) waitingArea.style.display = 'block';

    if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.innerText = 'ΕΙΣΟΔΟΣ';
    }
});

socket.on('chatUpdate', data => {
    const m = $("chat-messages");
    if (!m) return;

    const div = document.createElement('div');
    const b = document.createElement('b');
    b.style.color = 'var(--gold)';
    b.textContent = data.name + ': ';
    div.appendChild(b);
    div.appendChild(document.createTextNode(data.text));

    m.appendChild(div);
    m.scrollTop = m.scrollHeight;
    if (m.children.length > 50) m.removeChild(m.firstChild);
});

socket.on('playerCountUpdate', count => {
    const waitingMsg = $("waiting-msg");
    const startBtn = $("start-btn");

    if (waitingMsg) {
        waitingMsg.innerText = `Συνδεδεμένοι παίκτες: ${count}`;
    }

    if (startBtn) {
        startBtn.style.display = count >= 2 ? 'inline-block' : 'none';
    }
});

socket.on('gameReady', () => {
    $("start-screen").style.display = 'none';
    $("scoreboard").style.display = 'block';
    $("pile-container").innerHTML = '';
    lastDiscardCount = 0;
});

socket.on('gameInterrupted', payload => {
    clearGameTimer();
    actionLocked = false;
    lastPlayerId = null;
    selectedAceIndex = null;

    $("ace-modal").style.display = 'none';
    $("victory-screen").style.display = 'none';
    $("game-wrapper").style.filter = '';
    $("pile-container").innerHTML = '';
    $("scoreboard").style.display = 'none';
    $("start-screen").style.display = 'flex';

    const loginArea = $("login-area");
    const waitingArea = $("waiting-area");
    if (loginArea) loginArea.style.display = 'flex';
    if (waitingArea) waitingArea.style.display = 'none';

    lastDiscardCount = 0;

    if (payload && payload.message) {
        msgQueue.push(payload.message);

        if (msgQueue.length > 3) {
            msgQueue = msgQueue.slice(-3);
        }

        if (!isMsgShowing) showNextMsg();
    }
});

socket.on('notification', m => {
    if (m === 'Το παιχνίδι έχει ήδη ξεκινήσει!') {
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

socket.on('actionRejected', () => {
    actionLocked = false;
});

socket.on('invalidMove', () => {
    actionLocked = false;
    msgQueue.push("⚠️ Άκυρη Κίνηση!");

    if (msgQueue.length > 3) {
        msgQueue = msgQueue.slice(-3);
    }

    if (!isMsgShowing) showNextMsg();

    document.querySelectorAll('.hand-card').forEach(c => c.classList.add('shake'));
    setTimeout(() => {
        document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('shake'));
    }, 180);
});

socket.on('updateUI', data => {
    actionLocked = false;
    window.currentScoreData = data;
    $("deck-count").innerText = data.deckCount;
    window.currentTopCard = data.topCard;
    window.currentActiveSuit = data.activeSuit;

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
            suitDisplay.style.color = isRedSuit(data.activeSuit) ? '#ff4444' : '#222';
            suitDisplay.style.display = 'block';
            suitDisplay.style.textShadow = "0 0 10px white, 0 0 20px white";
        } else {
            suitDisplay.style.display = 'none';
        }
    }

    const ind = $("turn-indicator");
    const handCont = $("my-hand-container");
    if (ind && handCont) {
        if (data.isMyTurn) {
            ind.innerText = data.penalty > 0 ? `⚠️ ΦΑΕ ${data.penalty}!` : "ΔΙΚΗ ΣΟΥ ΣΕΙΡΑ";
            ind.style.borderColor = "#4f4";
            ind.style.color = "#4f4";
            handCont.classList.remove('not-my-turn');
        } else {
            ind.innerText = `ΠΑΙΖΕΙ: ${data.currentPlayerName}`;
            ind.style.borderColor = "#ff4444";
            ind.style.color = "#ffdddd";
            handCont.classList.add('not-my-turn');
        }
    }

    renderHand(data.myHand);
    distributePlayers(data.players, data.currentPlayerName, data.isMyTurn);
    updateDirectionIndicator(data.players, data.direction);
});

socket.on('revealHands', playersData => {
    clearGameTimer();
    lastPlayerId = null;
    $("pile-container").innerHTML = '';
    lastDiscardCount = 0;

    const others = playersData.filter(p => p.id !== myId);
    const slots = ['slot-left', 'slot-top', 'slot-right'];

    others.forEach((p, i) => {
        const container = $(slots[i]);
        if (container && p.hand) {
            let cardsHtml = '';
            p.hand.forEach((c, idx) => {
                if (!c) return;
                const color = c.color === 'red' ? '#d00' : 'black';
                cardsHtml += `<div class="card" style="color:${color}; z-index:${idx};">${c.value}<div style="font-size:18px; line-height:1;">${c.suit}</div></div>`;
            });

            container.innerHTML = `
                <div class="panel player-info" style="opacity:1; z-index:2000;">
                    <div class="player-name" style="font-weight:bold; font-size:18px;">${p.name}</div>
                    <div style="font-size:12px; color:#4f4; margin-top:3px;">Σκορ: ${p.totalScore}</div>
                </div>
                <div class="player-cards" style="margin-top:10px;">${cardsHtml}</div>
                <div class="card-count-box" style="opacity:1">${p.hand.length} φύλλα</div>`;
        }
    });
});

socket.on('gameOver', msg => {
    clearGameTimer();
    $("game-wrapper").style.filter = "blur(10px)";
    $("victory-msg").innerText = msg;
    $("victory-screen").style.display = 'flex';
});

socket.on('rejoinSuccess', data => {
    $("login-area").style.display = 'none';

    if (data.gameStarted) {
        $("start-screen").style.display = 'none';
        fullScoreHistory = data.history || [];
        renderScoreboard();
        $("scoreboard").style.display = 'block';
    } else {
        $("waiting-area").style.display = 'block';
        $("start-screen").style.display = 'flex';
    }
});

socket.on('updateScoreboard', data => {
    fullScoreHistory = data.history;
    renderScoreboard();
    $("scoreboard").style.display = 'block';
});
