const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log("WebSocket server running on port", PORT);

/**
 * rooms = {
 *   ROOM_ID: {
 *     clients: Set<WebSocket>,
 *     gameState: Object | null
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
    ws.currentRoom = null;
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

        // Create room if missing
        if (!rooms[room]) {
            rooms[room] = {
                clients: new Set(),
                gameState: null
            };
        }

        const roomObj = rooms[room];

        // ---- JOIN ROOM (first message defines room) ----
        if (!ws.currentRoom) {
            ws.currentRoom = room;
            roomObj.clients.add(ws);

            console.log(`Client joined room ${room}`);

            // 🔑 CRITICAL FIX:
            // Always send authoritative state immediately on join
            if (roomObj.gameState) {
                ws.send(JSON.stringify({
                    type: "state",
                    room,
                    state: roomObj.gameState
                }));
            }
        }

        // ---- STATE UPDATE (authoritative) ----
        if (type === "state") {
            roomObj.gameState = data.state;

            roomObj.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: "state",
                        room,
                        sender: data.sender,
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
                        room,
                        msg: data.msg,
                        role: data.role
                    }));
                }
            });
            return;
        }
    });

    ws.on("close", () => {
        const room = ws.currentRoom;
        if (!room || !rooms[room]) return;

        rooms[room].clients.delete(ws);
        console.log(`Client left room ${room}`);

        if (rooms[room].clients.size === 0) {
            delete rooms[room];
            console.log(`Room ${room} destroyed`);
        }
    });
});

// ---------------- HEARTBEAT CLEANUP ----------------
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
            console.log("Terminating dead connection");
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
