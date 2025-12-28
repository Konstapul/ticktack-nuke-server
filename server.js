const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log("WebSocket server running on port", PORT);

let clients = [];
let gameState = null;

/* ---------- HEARTBEAT SETUP ---------- */
function heartbeat() {
    this.isAlive = true;
}

const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log("Terminating dead client");
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 30000); // every 30s
/* ------------------------------------ */

wss.on("connection", (ws) => {
    console.log("Client connected");

    ws.isAlive = true;
    ws.on("pong", heartbeat);

    clients.push(ws);

    // Send current game state to new client
    if (gameState) {
        ws.send(JSON.stringify({ type: "state", state: gameState }));
    }

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);

            if (data.type === "state") {
                gameState = data.state;

                // Broadcast to all other clients
                clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: "state", state: gameState }));
                    }
                });
            }
        } catch (e) {
            console.error("Invalid message:", e);
        }
    });

    ws.on("close", () => {
        clients = clients.filter(c => c !== ws);
        console.log("Client disconnected");
    });
});

wss.on("close", () => {
    clearInterval(interval);
});
