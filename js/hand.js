function renderHand(hand) {
    const container = $("my-hand-container");
    if (!container) return;

    container.className = hand.length > 15 ? 'hand-compact' : 'hand-normal';

    const frag = document.createDocumentFragment();
    const overlap = (hand.length > 15) ? "-25px" : (hand.length > 8 ? "-60px" : "-55px");

    hand.forEach((c, i) => {
        if (!c) return;

        const div = document.createElement("div");
        const isRed = isRedSuit(c.suit);

        div.className = `card-base hand-card card-${i} ${isRed ? 'red' : ''}`;
        div.style.marginLeft = i === 0 ? "0px" : overlap;
        div.style.zIndex = i;

        div.setAttribute('data-index', i);
        div.setAttribute('data-value', c.value);
        div.setAttribute('data-suit', c.suit);

        div.innerHTML = `
            <div class="card-corner">${c.value}<div>${c.suit}</div></div>
            <div class="card-center">${c.suit}</div>
            <div class="card-corner bottom">${c.value}<div>${c.suit}</div></div>`;

        frag.appendChild(div);
    });

    container.innerHTML = "";
    container.appendChild(frag);
}

function playCardLogic(index, value, suit) {
    const handCont = $("my-hand-container");
    if (handCont && handCont.classList.contains('not-my-turn')) return;
    if (actionLocked || Date.now() - lastClick < CLICK_DELAY) return;

    if (value === 'A') {
        const topCard = window.currentTopCard;
        const effectiveSuit = window.currentActiveSuit || (topCard ? topCard.suit : null);

        if (topCard && topCard.value === 'A' && suit === effectiveSuit) {
            executePlayCard(index, null);
            return;
        }

        selectedAceIndex = index;
        $("ace-modal").style.display = 'flex';
        return;
    }

    executePlayCard(index, null);
}

function confirmAce(chosenSuit) {
    if (selectedAceIndex === null) return;
    executePlayCard(selectedAceIndex, chosenSuit);
    $("ace-modal").style.display = 'none';
    selectedAceIndex = null;
}

function cancelAce() {
    selectedAceIndex = null;
    $("ace-modal").style.display = 'none';
    actionLocked = false;
}

function executePlayCard(index, declaredSuit) {
    const cardElement = document.querySelector(`.card-${index}`);
    if (cardElement) animateThrow(cardElement);

    actionLocked = true;
    lastClick = Date.now();
    socket.emit('playCard', { index, declaredSuit });
}
