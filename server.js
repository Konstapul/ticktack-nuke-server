const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

console.log("WebSocket server running on port", PORT);

/**
 * rooms = {
 *   ROOM_ID: {
 *     clients: Set<WebSocket>,
 *     players: { 1: ws|null, 2: ws|null },
 *     gameState: Object|null
 *   }
 * }
 */
const rooms = {};

// ---------------- HEARTBEAT ----------------
function heartbeat() {
    this.isAlive = true;
}

// ---------------- CONNECTION ----------------
wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.room = null;
    ws.playerId = null;

    ws.on("pong", heartbeat);

    ws.on("message", (raw) => {
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }

        const { type, room } = data;
        if (!room) return;

        // ---------- CREATE ROOM ----------
        if (!rooms[room]) {
            rooms[room] = {
                clients: new Set(),
                players: { 1: null, 2: null },
                gameState: null
            };
        }

        const roomObj = rooms[room];

        // ---------- JOIN ROOM ----------
        if (!ws.room) {
            ws.room = room;
            roomObj.clients.add(ws);

            // Assign player slots
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

            // Send authoritative state if exists
            if (roomObj.gameState) {
                ws.send(JSON.stringify({
                    type: "state",
                    state: roomObj.gameState
                }));
            }

            console.log(`Client joined ${room} as P${ws.playerId}`);
            return;
        }

        // ---------- STATE UPDATE ----------
        // Client-authoritative: server accepts state,
        // but enforces turn ownership.
        if (type === "state") {
            const incoming = data.state;
            if (!incoming || typeof incoming.currentPlayer !== "number") return;

            // Enforce turn
            if (ws.playerId !== incoming.lastMover) {
                ws.send(JSON.stringify({
                    type: "error",
                    msg: "Not your turn"
                }));
                return;
            }

            // Accept authoritative state
            roomObj.gameState = incoming;

            // Broadcast to ALL clients (including sender)
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

        // ---------- CHAT ----------
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
