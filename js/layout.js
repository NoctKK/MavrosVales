function resizeGame() {
    const wrapper = $("game-wrapper");
    const rotateMsg = $("rotate-msg");

    if (!wrapper) return;

    const isPortrait = window.innerHeight > window.innerWidth;
    const targetWidth = isPortrait ? 720 : 1280;
    const targetHeight = isPortrait ? 1280 : 720;

    gameScale = Math.min(
        window.innerWidth / targetWidth,
        window.innerHeight / targetHeight
    );

    wrapper.style.transformOrigin = "center center";
    wrapper.style.transform = `scale(${gameScale})`;

    if (rotateMsg) {
        rotateMsg.style.display = "none";
    }

    document.body.classList.toggle("portrait-mode", isPortrait);
    document.body.classList.toggle("landscape-mode", !isPortrait);
}

function distributePlayers(players, curName, isMyTurn) {
    if (!Array.isArray(players) || !players.length) return;

    const myIdx = players.findIndex(p => p.id === myId);
    if (myIdx === -1) return;

    const myInfo = $("my-info-container");
    if (myInfo) {
        myInfo.innerHTML = `
            <div class="panel player-info ${isMyTurn ? "active" : ""}" style="z-index:2000;">
                ${isMyTurn ? '<div class="turn-indicator-dot"></div>' : ""}
                <div style="font-weight:bold; font-size:18px;">${players[myIdx].name}</div>
                ${players[myIdx].hats > 0 ? `<div style="margin-top:2px;">${"🎩".repeat(players[myIdx].hats)}</div>` : ""}
            </div>
        `;
    }

    const others = players.slice(myIdx).concat(players.slice(0, myIdx)).slice(1);
    const slotIds = ["slot-left", "slot-top", "slot-right"];

    slotIds.forEach(id => {
        const el = $(id);
        if (el) el.innerHTML = "";
    });

    others.forEach((p, i) => {
        const container = $(slotIds[i]);
        if (!container || !p) return;

        const active = p.name === curName;
        const visibleCards = Math.min(p.handCount || 0, 15);
        const handWidth = visibleCards > 0 ? 30 + (visibleCards - 1) * 8 : 30;

        container.innerHTML = `
            <div class="panel player-info ${active ? "active" : ""}" style="opacity:${p.connected ? 1 : 0.4}; z-index:2000;">
                ${active ? '<div class="turn-indicator-dot"></div>' : ""}
                <div style="font-weight:bold; font-size:18px;">${p.name}${p.connected ? "" : " (Αποσ.)"}</div>
                ${p.hats > 0 ? `<div style="margin-top:2px;">${"🎩".repeat(p.hats)}</div>` : ""}
            </div>

            <div class="opp-hand" style="width:${handWidth}px">
                ${Array(visibleCards).fill(0).map((_, idx) => `
                    <div class="mini-card" style="left:${idx * 8}px; z-index:${idx};"></div>
                `).join("")}
            </div>

            <div class="card-count-box">${p.handCount} φύλλα</div>
        `;
    });
}

function updateDirectionIndicator(playersArray, dir) {
    if (!Array.isArray(playersArray) || !playersArray.length) return;

    const indicator = $("direction-indicator");
    if (!indicator) return;

    const names = playersArray.map(p => ((p?.name || "").replace("❤️", "").trim()));

    let initials = names.map((name, i) => {
        if (!name) return "Π";

        let len = 1;
        let init = name.substring(0, len).toUpperCase();

        while (len <= name.length) {
            let conflict = false;

            for (let j = 0; j < names.length; j++) {
                if (i !== j && names[j] && names[j].toUpperCase().startsWith(init)) {
                    conflict = true;
                    break;
                }
            }

            if (!conflict) break;

            len++;
            init = name.substring(0, len).toUpperCase();
        }

        return init || "Π";
    });

    const counts = {};

    for (let i = 0; i < initials.length; i++) {
        const init = initials[i];

        if (counts[init]) {
            counts[init]++;
            initials[i] = init + counts[init];
        } else {
            counts[init] = 1;
        }
    }

    indicator.innerText = dir === 1
        ? initials.join(" ➔ ")
        : initials.join(" ⬅ ");
}
