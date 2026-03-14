function triggerDrawAnimation() {
    const handCont = $("my-hand-container");
    if (actionLocked || handCont.classList.contains('not-my-turn')) return;

    actionLocked = true;
    lastClick = Date.now();

    socket.emit('drawCard');

    const deckEl = $("draw-pile");
    const clone = document.createElement('div');
    clone.className = 'flying-card';
    clone.style.width = '77px';
    clone.style.height = '112px';
    clone.style.background = 'linear-gradient(135deg, #a00, #500)';
    clone.style.border = '2px solid white';
    clone.style.borderRadius = '5px';

    const rectDeck = deckEl.getBoundingClientRect();
    clone.style.left = rectDeck.left + 'px';
    clone.style.top = rectDeck.top + 'px';
    clone.style.transform = `scale(${gameScale})`;

    document.body.appendChild(clone);

    const rectHand = handCont.getBoundingClientRect();
    requestAnimationFrame(() => {
        clone.style.left = (rectHand.left + rectHand.width / 2 - 38) + 'px';
        clone.style.top = (rectHand.top - 20) + 'px';
        clone.style.opacity = 0;
        clone.style.transform = `scale(${gameScale}) rotate(180deg)`;
    });

    setTimeout(() => {
        if (document.body.contains(clone)) clone.remove();
    }, 220);
}

function animateThrow(elem) {
    const clone = elem.cloneNode(true);
    clone.className = 'flying-card card-base';

    const rect = elem.getBoundingClientRect();
    clone.style.left = rect.left + 'px';
    clone.style.top = rect.top + 'px';
    clone.style.margin = '0';
    clone.style.transform = `scale(${gameScale})`;

    document.body.appendChild(clone);

    const pileContainer = $("pile-container");
    if (!pileContainer) return;

    const pileRect = pileContainer.getBoundingClientRect();

    requestAnimationFrame(() => {
        clone.style.left = pileRect.left + 'px';
        clone.style.top = pileRect.top + 'px';
        clone.style.transform = `scale(${gameScale}) rotate(${Math.random() * 40 - 20}deg)`;
        clone.style.opacity = 0.5;
    });

    setTimeout(() => {
        if (document.body.contains(clone)) clone.remove();
    }, 220);
}

function addCardToPile(c) {
    const container = $("pile-container");
    if (!container) return;

    const div = document.createElement('div');
    const isRed = isRedSuit(c.suit);
    div.className = `card-base pile-card ${isRed ? 'red' : ''}`;

    const x = Math.random() * 24 - 12;
    const y = Math.random() * 24 - 12;
    const r = Math.random() * 30 - 15;

    div.style.transform = `translate(${x}px, ${y}px) rotate(${r}deg)`;
    div.innerHTML = `
        <div class="card-corner">${c.value}<div>${c.suit}</div></div>
        <div class="card-center">${c.suit}</div>
        <div class="card-corner bottom">${c.value}<div>${c.suit}</div></div>`;

    container.appendChild(div);

    const cards = container.querySelectorAll('.pile-card');
    if (cards.length > 15) {
        cards[0].remove();
    }
}
