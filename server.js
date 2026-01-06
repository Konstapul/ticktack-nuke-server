const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log("WebSocket server running on port", PORT);

/**
 * rooms = {
 *   ROOM_ID: {
 *     clients: Set<WebSocket>,
 *     players: { 1: ws|null, 2: ws|null },
 *     gameState: Object
 *   }
 * }
 */
const rooms = {};

// ---------------- HEARTBEAT ----------------
function heartbeat() {
    this.isAlive = true;
}

// ---------------- GAME REDUCER (STUB) ----------------
// IMPORTANT: real logic still lives client-side for now
// Server enforces TURN ONLY
function applyAction(state, action) {
    return action.nextState;
}

// ---------------- CONNECTION ----------------
wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.room = null;
    ws.playerId = null;
    ws.on("pong", heartbeat);

    ws.on("message", (msg) => {
        let data;
        try {
            data = JSON.parse(msg);
        } catch {
            return;
        }

        const { type, room } = data;
        if (!room) return;

        // ---- CREATE ROOM IF NEEDED ----
        if (!rooms[room]) {
            rooms[room] = {
                clients: new Set(),
                players: { 1: null, 2: null },
                gameState: null
            };
        }

        const roomObj = rooms[room];

        // ---- JOIN ROOM ----
        if (!ws.room) {
            ws.room = room;
            roomObj.clients.add(ws);

            // Assign player slot
            if (!roomObj.players[1]) {
                roomObj.players[1] = ws;
                ws.playerId = 1;
            } else if (!roomObj.players[2]) {
                roomObj.players[2] = ws;
                ws.playerId = 2;
            } else {
                ws.playerId = 0; // spectator
            }

            ws.send(JSON.stringify({
                type: "role",
                playerId: ws.playerId
            }));

            if (roomObj.gameState) {
                ws.send(JSON.stringify({
                    type: "state",
                    state: roomObj.gameState
                }));
            }

            console.log(`Client joined ${room} as P${ws.playerId}`);
            return;
        }

        // ---- ACTION (AUTHORITATIVE TURN CHECK) ----
        if (type === "action") {
            if (!roomObj.gameState) return;

            const current = roomObj.gameState.currentPlayer;

            // Reject illegal turn
            if (ws.playerId !== current) {
                ws.send(JSON.stringify({
                    type: "error",
                    msg: "Not your turn"
                }));
                return;
            }

            // Apply action
            roomObj.gameState = applyAction(
                roomObj.gameState,
                data.action
            );

            // Broadcast authoritative state
            roomObj.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: "state",
                        state: roomObj.gameState
                    }));
                }
            });

            return;
        }

        // ---- CHAT ----
        if (type === "chat") {
            roomObj.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: "chat",
                        msg: data.msg,
                        role: ws.playerId
                    }));
                }
            });
        }
    });

    ws.on("close", () => {
        const room = ws.room;
        if (!room || !rooms[room]) return;

        const roomObj = rooms[room];
        roomObj.clients.delete(ws);

        if (roomObj.players[1] === ws) roomObj.players[1] = null;
        if (roomObj.players[2] === ws) roomObj.players[2] = null;

        if (roomObj.clients.size === 0) {
            delete rooms[room];
            console.log(`Room ${room} destroyed`);
        }
    });
});

// ---------------- HEARTBEAT CLEANUP ----------------
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
