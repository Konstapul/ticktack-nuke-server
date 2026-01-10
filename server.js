const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

console.log(`[WAR ROOM] Server initialized on port ${PORT}`);

// --- GAME CONSTANTS ---
const MAP_SIZE = 15;
const WINNING_SCORE = 3;

const STATE = {
    EMPTY: 0,
    P1: 1, P2: 2,
    P1_SCORED: 3, P2_SCORED: 4,
    P1_BUNKER: 5, P2_BUNKER: 6,
    P1_BUNKER_SCORED: 7, P2_BUNKER_SCORED: 8,
    CRATER: 9
};

// --- GAME LOGIC ENGINE ---
class GameSession {
    constructor(roomId) {
        this.roomId = roomId;
        this.clients = { 1: null, 2: null }; // WebSocket connections
        this.spectators = new Set();
        
        // Game State
        this.grid = Array(MAP_SIZE).fill().map(() => Array(MAP_SIZE).fill(STATE.EMPTY));
        this.turn = 1; // 1 or 2
        this.scores = { 1: 0, 2: 0 };
        this.nukes = { 1: 0, 2: 0 };
        this.boosters = { 1: 0, 2: 0 };
        this.bunkers = { 1: 0, 2: 0 };
        
        // Special Turn States
        this.bonusTurn = false;
        this.ignoreIsolation = false; // Granted by 2x2 sometimes? (Simulating your logic)
        this.gameActive = true;
        this.winner = null;
    }

    addClient(ws, playerId) {
        if (playerId === 1 || playerId === 2) {
            // Reconnect logic: If a player is already there, close old connection
            if (this.clients[playerId] && this.clients[playerId].readyState === WebSocket.OPEN) {
                this.clients[playerId].close();
            }
            this.clients[playerId] = ws;
        } else {
            this.spectators.add(ws);
        }
        this.broadcastState();
    }

    removeClient(ws) {
        if (this.clients[1] === ws) this.clients[1] = null;
        else if (this.clients[2] === ws) this.clients[2] = null;
        else this.spectators.delete(ws);
    }

    // Process an action from a player
    handleAction(playerId, action) {
        if (!this.gameActive) return;
        if (playerId !== this.turn && !this.bonusTurn) return; // Strict turn enforcement

        try {
            switch (action.type) {
                case 'PLACE':
                    this.handlePlace(playerId, action.r, action.c);
                    break;
                case 'NUKE':
                    this.handleNuke(playerId, action.r, action.c, action.boosted);
                    break;
                case 'CRAFT':
                    this.handleCraft(playerId);
                    break;
            }
        } catch (e) {
            console.error(`Error processing move: ${e.message}`);
        }
    }

    handlePlace(p, r, c) {
        // 1. Validation
        if (!this.isValid(r, c)) return;
        if (this.grid[r][c] !== STATE.EMPTY && this.grid[r][c] !== STATE.CRATER) return; // Occupied
        
        // Isolation Rule (if bonus turn is active)
        if (this.bonusTurn && !this.ignoreIsolation) {
            if (!this.isIsolated(r, c)) {
                this.sendError(p, "MUST PLACE ISOLATED UNIT");
                return;
            }
        }

        // 2. Execute Move
        this.grid[r][c] = (p === 1) ? STATE.P1 : STATE.P2;
        
        // 3. Post-Move Checks
        let earnedBonus = false;

        // Check Win (5-in-a-row)
        const scored = this.checkWinCondition(p); 
        if (scored) {
            // Scoring logic from your snippet
            this.scores[p]++;
            if (this.scores[p] === 1) this.nukes[p]++;
            else if (this.scores[p] === 2) this.nukes[p === 1 ? 2 : 1]++; // Catch-up mechanic
            
            if (this.scores[p] >= WINNING_SCORE) {
                this.gameActive = false;
                this.winner = p;
            }
        }

        // Check Patterns (only if game still active)
        if (this.gameActive) {
            const patternBonus = this.scanForPatterns(p);
            if (patternBonus.turn) earnedBonus = true;
            // patternBonus.bunker handled inside scanForPatterns
        }

        // 4. Turn Switching
        if (earnedBonus) {
            this.bonusTurn = true;
            // logic for isolation requirement on next turn
            this.ignoreIsolation = false; 
        } else {
            this.bonusTurn = false;
            this.turn = (this.turn === 1) ? 2 : 1;
        }

        this.broadcastState();
    }

    handleNuke(p, r, c, boosted) {
        // Validation
        if (this.nukes[p] <= 0) return;
        if (boosted && this.boosters[p] <= 0) return;

        // Consume Resources
        this.nukes[p]--;
        if (boosted) this.boosters[p]--;

        // Calculate Blast Area
        // Standard: 3x3. Boosted: 5x5 (example logic)
        const radius = boosted ? 2 : 1; 

        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const nr = r + dy;
                const nc = c + dx;
                if (this.isValid(nr, nc)) {
                    const cell = this.grid[nr][nc];
                    const isBunker = [STATE.P1_BUNKER, STATE.P2_BUNKER, STATE.P1_BUNKER_SCORED, STATE.P2_BUNKER_SCORED].includes(cell);
                    
                    // Bunkers survive normal nukes, die to boosted nukes
                    if (isBunker && !boosted) continue;
                    
                    // Destroy bunker count if destroyed
                    if (isBunker) {
                        const owner = [STATE.P1_BUNKER, STATE.P1_BUNKER_SCORED].includes(cell) ? 1 : 2;
                        this.bunkers[owner] = Math.max(0, this.bunkers[owner] - 1);
                    }

                    this.grid[nr][nc] = STATE.CRATER;
                }
            }
        }

        this.turn = (this.turn === 1) ? 2 : 1;
        this.bonusTurn = false;
        this.broadcastState();
    }

    handleCraft(p) {
        if (this.boosters[p] >= 3) {
            this.boosters[p] -= 3;
            this.nukes[p]++;
            this.broadcastState();
        }
    }

    // --- HELPER LOGIC ---
    isValid(r, c) { return r >= 0 && r < MAP_SIZE && c >= 0 && c < MAP_SIZE; }

    isIsolated(r, c) {
        // Check 8 neighbors
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                if (this.isValid(r+dr, c+dc)) {
                    const cell = this.grid[r+dr][c+dc];
                    if (cell !== STATE.EMPTY && cell !== STATE.CRATER) return false;
                }
            }
        }
        return true;
    }

    checkWinCondition(p) {
        let scored = false;
        // Directions: Horizontal, Vertical, Diagonal, Anti-Diagonal
        const directions = [[0,1], [1,0], [1,1], [1,-1]];
        
        // Scan entire grid (Inefficient but robust for turn-based)
        // Optimization: In a real deploy, only check lines passing through last move.
        // For simplicity here, we scan grid.
        for (let r = 0; r < MAP_SIZE; r++) {
            for (let c = 0; c < MAP_SIZE; c++) {
                directions.forEach(([dr, dc]) => {
                    let line = [];
                    for (let i = 0; i < 5; i++) {
                        const nr = r + dr*i, nc = c + dc*i;
                        if (this.isValid(nr, nc)) {
                            line.push({r: nr, c: nc, val: this.grid[nr][nc]});
                        }
                    }
                    
                    if (line.length === 5) {
                        const isPlayerLine = line.every(cell => 
                            (p === 1 ? [1,5] : [2,6]).includes(cell.val) // 1 or 5 (P1 normal/bunker)
                        );
                        
                        if (isPlayerLine) {
                            // Convert to scored state
                            line.forEach(cell => {
                                const current = this.grid[cell.r][cell.c];
                                if (current === STATE.P1) this.grid[cell.r][cell.c] = STATE.P1_SCORED;
                                if (current === STATE.P2) this.grid[cell.r][cell.c] = STATE.P2_SCORED;
                                if (current === STATE.P1_BUNKER) this.grid[cell.r][cell.c] = STATE.P1_BUNKER_SCORED;
                                if (current === STATE.P2_BUNKER) this.grid[cell.r][cell.c] = STATE.P2_BUNKER_SCORED;
                            });
                            scored = true;
                        }
                    }
                });
            }
        }
        return scored;
    }

    scanForPatterns(p) {
        let result = { turn: false, bunker: false };
        
        // 2x2 Pattern Check
        for (let r = 0; r < MAP_SIZE-1; r++) {
            for (let c = 0; c < MAP_SIZE-1; c++) {
                const block = [
                    this.grid[r][c], this.grid[r][c+1],
                    this.grid[r+1][c], this.grid[r+1][c+1]
                ];
                // Check if all belong to player and are NOT scored/bunkers yet (simplified)
                if (block.every(val => val === (p===1?1:2))) {
                    // In a real implementation, we need to track if this 2x2 was ALREADY used.
                    // For this simple version, we assume detection triggers the bonus.
                    result.turn = true;
                }
            }
        }

        // Plus Pattern (+) Check
        for (let r = 1; r < MAP_SIZE-1; r++) {
            for (let c = 1; c < MAP_SIZE-1; c++) {
                const center = this.grid[r][c];
                const arms = [
                    this.grid[r-1][c], this.grid[r+1][c],
                    this.grid[r][c-1], this.grid[r][c+1]
                ];
                
                if (center === (p===1?1:2) && arms.every(val => val === center)) {
                    // Upgrade center to Bunker
                    this.grid[r][c] = (p===1 ? STATE.P1_BUNKER : STATE.P2_BUNKER);
                    this.bunkers[p]++;
                    this.boosters[p]++; // Give booster
                }
            }
        }
        
        return result;
    }

    // --- NETWORKING ---
    broadcastState() {
        const payload = JSON.stringify({
            type: 'STATE_UPDATE',
            state: {
                grid: this.grid,
                scores: this.scores,
                nukes: this.nukes,
                boosters: this.boosters,
                bunkers: this.bunkers,
                currentPlayer: this.turn,
                bonusTurn: this.bonusTurn,
                gameActive: this.gameActive,
                winner: this.winner
            }
        });

        [this.clients[1], this.clients[2], ...this.spectators].forEach(client => {
            if (client && client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }

    sendError(playerId, msg) {
        const client = this.clients[playerId];
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'ERROR', msg }));
        }
    }
}

// --- GLOBAL ROOM MANAGER ---
const rooms = {};

// Handle new connections
wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.roomId = null;
    
    ws.on("pong", () => ws.isAlive = true);

    ws.on("message", (raw) => {
        try {
            const data = JSON.parse(raw);
            
            // 1. JOIN LOGIC
            if (data.type === "join") {
                const roomId = data.room || "default";
                
                if (!rooms[roomId]) {
                    rooms[roomId] = new GameSession(roomId);
                    console.log(`Created Room: ${roomId}`);
                }
                
                const game = rooms[roomId];
                
                // Assign Player Role
                let role = null;
                if (!game.clients[1]) role = 1;
                else if (!game.clients[2]) role = 2;
                else role = "spectator"; // Room full

                ws.roomId = roomId;
                ws.role = role; // Store role on the socket
                
                game.addClient(ws, role);
                
                // Tell the client who they are
                ws.send(JSON.stringify({ type: "WELCOME", role: role }));
                return;
            }

            // 2. GAME ACTION LOGIC
            if (ws.roomId && rooms[ws.roomId]) {
                const game = rooms[ws.roomId];
                
                if (data.type === "chat") {
                    // Broadcast chat to all in room
                    const chatMsg = JSON.stringify({ type: "chat", msg: data.msg, role: ws.role });
                    [game.clients[1], game.clients[2], ...game.spectators].forEach(c => {
                        if (c && c.readyState === WebSocket.OPEN) c.send(chatMsg);
                    });
                } else {
                    // Pass game moves to the engine
                    if (ws.role === 1 || ws.role === 2) {
                        game.handleAction(ws.role, data);
                    }
                }
            }

        } catch (e) {
            console.error("Msg Error:", e);
        }
    });

    ws.on("close", () => {
        if (ws.roomId && rooms[ws.roomId]) {
            const game = rooms[ws.roomId];
            game.removeClient(ws);
            // Optional: Destroy empty rooms after timeout
            // if (!game.clients[1] && !game.clients[2]) delete rooms[ws.roomId];
        }
    });
});

// Heartbeat interval
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
