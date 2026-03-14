function registerSocketHandlers(io, globalGameInstance) {
    io.on('connection', (socket) => {
        if (!globalGameInstance.gameStarted) {
            globalGameInstance.refreshLobbyTimer();
        }

        socket.on('joinGame', (data) => {
            globalGameInstance.joinGame(socket, data);
        });

        socket.on('startGameRequest', () => {
            globalGameInstance.refreshLobbyTimer();

            const activeCount = globalGameInstance.playerOrder.filter(
                id => globalGameInstance.players[id] && globalGameInstance.players[id].connected
            ).length;

            if (!globalGameInstance.gameStarted && !globalGameInstance.starting && activeCount >= 2) {
                globalGameInstance.starting = true;
                globalGameInstance.startNewRound(true);
            }
        });

        socket.on('playCard', (data) => {
            globalGameInstance.playCard(socket, data);
        });

        socket.on('drawCard', () => {
            globalGameInstance.drawCard(socket);
        });

        socket.on('passTurn', () => {
            globalGameInstance.passTurn(socket);
        });

        socket.on('chatMessage', (msg) => {
            globalGameInstance.refreshLobbyTimer();
            const p = globalGameInstance.players[socket.id];

            if (p && (!p.lastChat || Date.now() - p.lastChat > 500)) {
                p.lastChat = Date.now();
                io.emit('chatUpdate', {
                    name: p.name,
                    text: String(msg).replace(/[<>]/g, '').substring(0, 80)
                });
            }
        });

        socket.on('disconnect', () => {
            globalGameInstance.disconnectPlayer(socket.id);
        });
    });
}

module.exports = registerSocketHandlers;
