window.onerror = function(msg, url, line) {
    const overlay = $("error-overlay");
    const text = $("error-text");
    if (overlay && text) {
        overlay.style.display = 'flex';
        text.innerText = `Σφάλμα: ${msg}\nΓραμμή: ${line}`;
    }
    return false;
};

function showNextMsg() {
    const o = $("msg-overlay");
    if (!o) return;

    if (msgQueue.length === 0) {
        isMsgShowing = false;
        o.style.display = 'none';
        return;
    }

    isMsgShowing = true;
    o.innerText = msgQueue.shift();
    o.style.display = 'block';
    o.style.animation = 'none';
    o.offsetHeight;
    o.style.animation = 'popMsg 0.25s forwards';

    setTimeout(() => {
        o.style.display = 'none';
        setTimeout(showNextMsg, 100);
    }, 1800);
}

function toggleChat() {
    const b = $("chat-box");
    b.style.display = b.style.display === 'flex' ? 'none' : 'flex';
}

function toggleScoreboard() {
    const s = $("scoreboard");
    s.style.display = s.style.display === 'block' ? 'none' : 'block';
}

function renderScoreboard() {
    const table = $("score-table");
    if (!table || !fullScoreHistory.length) return;

    const pIds = Object.keys(fullScoreHistory[0]);
    const pMap = {};
    (window.currentScoreData?.players || []).forEach(p => pMap[p.id] = p);

    let html = `<tr>${pIds.map(id => `<th>${pMap[id]?.name || 'Π'}${"🎩".repeat(pMap[id]?.hats || 0)}</th>`).join('')}</tr>`;
    const dataToShow = isScoreboardExpanded ? fullScoreHistory : fullScoreHistory.slice(-5);

    dataToShow.forEach(row => {
        html += '<tr>' + pIds.map(id => `<td>${row[id] === "WC" ? '<b style="color:var(--gold)">WC</b>' : row[id]}</td>`).join('') + '</tr>';
    });

    table.innerHTML = html;
}

function sendChat() {
    const i = $("chat-input");
    if (i.value) {
        socket.emit('chatMessage', i.value);
        i.value = '';
    }
}
