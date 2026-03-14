function joinGame() {
    const input = $("username");
    const btn = $("login-btn");
    if (!input || !btn) return;

    const name = input.value.trim();
    if (name === "") return alert("Παρακαλώ βάλε ένα όνομα!");

    btn.disabled = true;
    btn.innerText = "ΣΥΝΔΕΣΗ...";

    const sessionId = sessionStorage.getItem('mv_session') || 'sess_' + Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem('mv_session', sessionId);
    sessionStorage.setItem('mv_username', name);

    if (!socket.connected) {
        socket.connect();
        setTimeout(() => {
            if (!socket.connected) {
                btn.disabled = false;
                btn.innerText = "ΕΙΣΟΔΟΣ";
                alert("Δεν υπάρχει σύνδεση με τον server.");
            }
        }, 3000);
        return;
    }

    socket.emit('joinGame', { username: name, sessionId });
}

function forceReconnect() {
    const sess = sessionStorage.getItem('mv_session');
    const name = sessionStorage.getItem('mv_username');
    if (sess && name) socket.connect();
    else joinGame();
}

function startGameRequest() {
    if (!socket.connected) {
        alert("Το παιχνίδι αποσυνδέθηκε! Προσπάθεια επανασύνδεσης...");
        socket.connect();
        return;
    }
    socket.emit('startGameRequest');
}

function onHandClick(e) {
    const cardEl = e.target.closest('.hand-card');
    if (!cardEl) return;

    const index = parseInt(cardEl.getAttribute('data-index'), 10);
    const value = cardEl.getAttribute('data-value');
    const suit = cardEl.getAttribute('data-suit');

    playCardLogic(index, value, suit);
}

window.addEventListener('resize', resizeGame);
window.onload = resizeGame;

$("login-btn").addEventListener('click', joinGame);
$("start-btn").addEventListener('click', startGameRequest);
$("reconnect-btn").addEventListener('click', forceReconnect);
$("chat-toggle").addEventListener('click', toggleChat);
$("score-toggle").addEventListener('click', toggleScoreboard);
$("draw-pile").addEventListener('click', triggerDrawAnimation);
$("pass-btn").addEventListener('click', () => socket.emit('passTurn'));
$("my-hand-container").addEventListener('click', onHandClick);
$("chat-input").addEventListener('keypress', e => {
    if (e.key === 'Enter') sendChat();
});

$("ace-backdrop").addEventListener('click', cancelAce);
$("ace-cancel-btn").addEventListener('click', cancelAce);

document.querySelectorAll('.suit-btn').forEach(btn => {
    btn.addEventListener('click', () => confirmAce(btn.dataset.suit));
});
