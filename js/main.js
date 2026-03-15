function joinGame() {
    const input = $("username");
    const btn = $("login-btn");
    if (!input || !btn) return;

    const name = input.value.trim();
    if (name === "") {
        alert("Παρακαλώ βάλε ένα όνομα!");
        return;
    }

    btn.disabled = true;
    btn.innerText = "ΣΥΝΔΕΣΗ...";

    const sessionId =
        sessionStorage.getItem("mv_session") ||
        "sess_" + Math.random().toString(36).substr(2, 9);

    sessionStorage.setItem("mv_session", sessionId);
    sessionStorage.setItem("mv_username", name);

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

    socket.emit("joinGame", { username: name, sessionId });
}

function forceReconnect() {
    const sess = sessionStorage.getItem("mv_session");
    const name = sessionStorage.getItem("mv_username");

    if (sess && name) {
        socket.connect();
    } else {
        joinGame();
    }
}

function startGameRequest() {
    if (!socket.connected) {
        alert("Το παιχνίδι αποσυνδέθηκε! Προσπάθεια επανασύνδεσης...");
        socket.connect();
        return;
    }

    socket.emit("startGameRequest");
}

function onHandClick(e) {
    const cardEl = e.target.closest(".hand-card");
    if (!cardEl) return;

    const index = parseInt(cardEl.getAttribute("data-index"), 10);
    const value = cardEl.getAttribute("data-value");
    const suit = cardEl.getAttribute("data-suit");

    playCardLogic(index, value, suit);
}

window.addEventListener("resize", resizeGame);
window.addEventListener("orientationchange", resizeGame);
window.addEventListener("load", resizeGame);

if ($("login-btn")) $("login-btn").addEventListener("click", joinGame);
if ($("start-btn")) $("start-btn").addEventListener("click", startGameRequest);
if ($("reconnect-btn")) $("reconnect-btn").addEventListener("click", forceReconnect);
if ($("chat-toggle")) $("chat-toggle").addEventListener("click", toggleChat);
if ($("score-toggle")) $("score-toggle").addEventListener("click", toggleScoreboard);
if ($("draw-pile")) $("draw-pile").addEventListener("click", triggerDrawAnimation);
if ($("pass-btn")) $("pass-btn").addEventListener("click", () => socket.emit("passTurn"));
if ($("my-hand-container")) $("my-hand-container").addEventListener("click", onHandClick);

if ($("chat-input")) {
    $("chat-input").addEventListener("keypress", (e) => {
        if (e.key === "Enter") sendChat();
    });
}

if ($("ace-backdrop")) {
    $("ace-backdrop").addEventListener("click", cancelAce);
}

if ($("ace-cancel-btn")) {
    $("ace-cancel-btn").addEventListener("click", cancelAce);
}

document.querySelectorAll(".suit-btn").forEach((btn) => {
    btn.addEventListener("click", () => confirmAce(btn.dataset.suit));
});
