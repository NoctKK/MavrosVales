function clearGameTimer() {
    const timerContainer = $("turn-timer");
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    if (timerContainer) timerContainer.style.display = "none";
}

function startTimer(seconds = 60) {
    clearGameTimer();
    if (seconds <= 0) return;

    const bar = document.querySelector(".timer-bar");
    const text = $("timer-text");
    const container = $("turn-timer");
    if (!bar || !text || !container) return;

    container.style.display = "block";
    timerEnd = Date.now() + seconds * 1000;

    const update = () => {
        const remaining = Math.max(0, timerEnd - Date.now());
        const percent = remaining / (seconds * 1000);
        bar.style.strokeDashoffset = 139 * (1 - percent);
        text.innerText = Math.ceil(remaining / 1000);

        if (remaining > 0) {
            animationFrameId = requestAnimationFrame(update);
        } else {
            clearGameTimer();
        }
    };

    update();
}
