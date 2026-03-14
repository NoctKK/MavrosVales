const { MAX_CHAT_LEN } = require('../game/constants');

module.exports = function registerSocketHandlers(io, socket, game) {
    if (!game.gameStarted) {
        game.refreshLobbyTimer();
    }

    socket.on('joinGame', (data) => {
        game.joinGame(socket, data);
    });

    socket.on('startGameRequest', () => {
        game.refreshLobbyTimer();

        const activeCount = game.playerOrder.filter(
            id => game.players[id] && game.players[id].connected
        ).length;

        if (!game.gameStarted && !game.starting && activeCount >= 2) {
            game.starting = true;
            game.startNewRound(true);
        }
    });

    socket.on('playCard', (data) => {
        game.playCard(socket, data);
    });

    socket.on('drawCard', () => {
        game.drawCard(socket);
    });

    socket.on('passTurn', () => {
        game.passTurn(socket);
    });

    socket.on('chatMessage', (msg) => {
        game.refreshLobbyTimer();

        const p = game.players[socket.id];
        if (!p) return;

        if (!p.lastChat || Date.now() - p.lastChat > 500) {
            p.lastChat = Date.now();

            io.emit('chatUpdate', {
                name: p.name,
                text: String(msg).replace(/[<>]/g, '').substring(0, MAX_CHAT_LEN)
            });
        }
    });

    socket.on('disconnect', () => {
        game.disconnectPlayer(socket.id);
    });
};
