const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port: PORT });

console.log("WebSocket server running on port", PORT);

let clients = [];
let gameState = null;

console.log(`WebSocket server running on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
    console.log("Client connected");
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
