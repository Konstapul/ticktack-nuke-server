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

function heartbeat() {
    this.isAlive = true;
}

wss.on("connection", (ws) => {
    ws.isAlive = true;
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
        roomObj.clients.add(ws);

        if (type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
            return;
        }

        if (type === "state") {
            roomObj.gameState = data.state;

            roomObj.clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: "state",
                        room,
                        sender: data.sender,
                        state: roomObj.gameState
                    }));
                }
            });
        }

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
        }
    });

    ws.on("close", () => {
        for (const roomId in rooms) {
            rooms[roomId].clients.delete(ws);
            if (rooms[roomId].clients.size === 0) {
                delete rooms[roomId];
            }
        }
    });
});

// --- heartbeat cleanup ---
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
