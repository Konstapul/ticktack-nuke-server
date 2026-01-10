const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

console.log(`[WAR ROOM] Server initialized on port ${PORT}`);

// --- GAME CONSTANTS ---
const MAP_SIZE = 15;
const WINNING_SCORE = 5; // Updated to match typical Connect-5 saturation

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
        this.clients = { 1: null, 2: null }; 
        this.spectators = new Set();
        
        // Game State
        this.grid = Array(MAP_SIZE).fill().map(() => Array(MAP_SIZE).fill(STATE.EMPTY));
        this.turn = 1; 
        this.scores = { 1: 0, 2: 0 };
        this.nukes = { 1: 0, 2: 0 };
        this.boosters = { 1: 0, 2: 0 };
        this.bunkers = { 1: 0, 2: 0 };
        
        this.bonusTurn = false;
        this.gameActive = true;
        this.winner = null;
        
        // Track used patterns to prevent infinite bonus loops
        this.usedPatterns = new Set(); 
    }

    addClient(ws, playerId) {
        if (playerId === 1 || playerId === 2) {
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

    handleAction(playerId, action) {
        if (!this.gameActive) return;
        if (playerId !== this.turn && !this.bonusTurn) return;

        try {
            switch (action.type) {
                case 'PLACE':
                    this.handlePlace(playerId, action.r, action.c);
                    break;
                case 'NUKE':
                    this.handleNuke(playerId, action.r, action.c, action.boostLevel || 0);
                    break;
                case 'CRAFT':
                    this.handleCraft(playerId);
                    break;
                case 'RESET': // Feature request: Reset
                     this.resetGame();
                     break;
            }
        } catch (e) {
            console.error(`Error processing move: ${e.message}`);
        }
    }

    resetGame() {
        this.grid = Array(MAP_SIZE).fill().map(() => Array(MAP_SIZE).fill(STATE.EMPTY));
        this.turn = 1;
        this.scores = { 1: 0, 2: 0 };
        this.nukes = { 1: 0, 2: 0 };
        this.boosters = { 1: 0, 2: 0 };
        this.bunkers = { 1: 0, 2: 0 };
        this.bonusTurn = false;
        this.gameActive = true;
        this.winner = null;
        this.usedPatterns = new Set();
        this.broadcastState();
    }

    handlePlace(p, r, c) {
        if (!this.isValid(r, c)) return;
        if (this.grid[r][c] !== STATE.EMPTY && this.grid[r][c] !== STATE.CRATER) return;

        // Execute Move
        this.grid[r][c] = (p === 1) ? STATE.P1 : STATE.P2;
        
        let earnedBonus = false;

        // Check Win (5-in-a-row)
        const scored = this.checkWinCondition(p); 
        if (scored) {
            this.scores[p]++;
            // Every score gives a nuke (simplified rule from previous iteration)
            this.nukes[p]++; 
        }

        // Check Patterns (Only checking around the NEW piece to prevent loops)
        if (this.gameActive) {
            const patternBonus = this.scanForPatterns(p, r, c);
            if (patternBonus) earnedBonus = true;
        }

        // Turn Switching Logic
        if (earnedBonus) {
            this.bonusTurn = true; 
        } else {
            this.bonusTurn = false;
            this.turn = (this.turn === 1) ? 2 : 1;
        }

        this.broadcastState();
    }

    handleNuke(p, r, c, boostLevel) {
        if (this.nukes[p] <= 0) return;
        if (boostLevel > this.boosters[p]) return; // Cheat check

        // Rule: Unboosted nukes (level 0) must target own pieces
        if (boostLevel === 0) {
            const target = this.grid[r][c];
            const isMine = (p === 1 && (target === STATE.P1 || target === STATE.P1_BUNKER || target === STATE.P1_SCORED)) ||
                           (p === 2 && (target === STATE.P2 || target === STATE.P2_BUNKER || target === STATE.P2_SCORED));
            
            if (!isMine && target !== STATE.EMPTY && target !== STATE.CRATER) {
                // Allow empty/crater targeting, but prevent hitting ENEMY on lvl 0? 
                // User said: "only be able to be detonated on your own pieces".
                // We'll enforce strictly: Must trigger on OWN piece.
                if (!isMine) {
                    this.sendError(p, "LVL 0 NUKE: MUST TARGET SELF");
                    return;
                }
            }
        }

        // Consume Resources
        this.nukes[p]--;
        this.boosters[p] -= boostLevel;

        // Calculate Blast Area (Manhattan Distance)
        // Base radius (Lvl 0) = 1 (Center + 1 NSEW) -> Manhattan <= 1
        // Lvl 1 = Manhattan <= 2
        const maxDist = 1 + boostLevel;

        for (let dy = -maxDist; dy <= maxDist; dy++) {
            for (let dx = -maxDist; dx <= maxDist; dx++) {
                // Manhattan Distance Check
                if (Math.abs(dx) + Math.abs(dy) <= maxDist) {
                    const nr = r + dy;
                    const nc = c + dx;
                    
                    if (this.isValid(nr, nc)) {
                        const cell = this.grid[nr][nc];
                        
                        // Bunker Logic: Bunkers survive if blast is NOT boosted enough?
                        // Usually bunkers survive normal nukes. 
                        // Let's say Boost Level 0 cannot kill bunkers. Boost >= 1 kills bunkers.
                        const isBunker = [STATE.P1_BUNKER, STATE.P2_BUNKER, STATE.P1_BUNKER_SCORED, STATE.P2_BUNKER_SCORED].includes(cell);
                        
                        if (isBunker && boostLevel < 1) continue;

                        // Count destroyed bunkers
                        if (isBunker) {
                            const owner = [STATE.P1_BUNKER, STATE.P1_BUNKER_SCORED].includes(cell) ? 1 : 2;
                            this.bunkers[owner] = Math.max(0, this.bunkers[owner] - 1);
                        }

                        this.grid[nr][nc] = STATE.CRATER;
                    }
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

    checkWinCondition(p) {
        let scored = false;
        const directions = [[0,1], [1,0], [1,1], [1,-1]];
        
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
                        // Check if line belongs to player (Normal or Bunker or Scored)
                        const pVal = p === 1 ? [1,5,3,7] : [2,6,4,8];
                        // Only count unscored pieces for new score
                        const isPlayerLine = line.every(cell => pVal.includes(cell.val));
                        const hasUnscored = line.some(cell => 
                            (p === 1 ? [1,5] : [2,6]).includes(cell.val)
                        );
                        
                        if (isPlayerLine && hasUnscored) {
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

    // Scan for patterns only involving the newly placed piece (r,c)
    scanForPatterns(p, r, c) {
        let earnedTurn = false;
        
        // 1. Check 2x2 Squares (Bonus Turn)
        // A piece at (r,c) can be in 4 possible 2x2 squares: top-left, top-right, bot-left, bot-right relative to itself.
        const squareOffsets = [
            [[0,0], [0,1], [1,0], [1,1]], // (r,c) is Top-Left
            [[0,-1], [0,0], [1,-1], [1,0]], // (r,c) is Top-Right
            [[-1,0], [-1,1], [0,0], [0,1]], // (r,c) is Bot-Left
            [[-1,-1], [-1,0], [0,-1], [0,0]] // (r,c) is Bot-Right
        ];

        for (let offsets of squareOffsets) {
            let coords = [];
            let valid = true;
            for (let [dr, dc] of offsets) {
                const nr = r + dr, nc = c + dc;
                if (!this.isValid(nr, nc)) { valid = false; break; }
                const val = this.grid[nr][nc];
                const isOwner = (p === 1 ? [1,3,5,7] : [2,4,6,8]).includes(val);
                if (!isOwner) { valid = false; break; }
                coords.push(`${nr},${nc}`);
            }

            if (valid) {
                // Identify square by its top-left coord
                coords.sort(); 
                const squareId = `SQ:${coords.join('|')}`;
                if (!this.usedPatterns.has(squareId)) {
                    this.usedPatterns.add(squareId);
                    earnedTurn = true;
                }
            }
        }

        // 2. Check Plus Patterns (Bunker)
        // Center piece must be the new piece (r,c) OR new piece completes an arm.
        // Simplified: Check if (r,c) is center, or if (r,c) is an arm of a neighbor center.
        
        const checkPlus = (cx, cy) => {
            if (!this.isValid(cx, cy)) return false;
            const centerVal = this.grid[cx][cy];
            const isOwner = (p === 1 ? [1,3,5,7] : [2,4,6,8]).includes(centerVal);
            if (!isOwner) return false;

            const arms = [[-1,0], [1,0], [0,-1], [0,1]];
            let armCoords = [];
            for (let [dr, dc] of arms) {
                const nr = cx + dr, nc = cy + dc;
                if (!this.isValid(nr, nc)) return false;
                const val = this.grid[nr][nc];
                const isArmOwner = (p === 1 ? [1,3,5,7] : [2,4,6,8]).includes(val);
                if (!isArmOwner) return false;
                armCoords.push({r:nr, c:nc});
            }
            
            // It's a valid Plus!
            const plusId = `PLUS:${cx},${cy}`;
            if (!this.usedPatterns.has(plusId)) {
                this.usedPatterns.add(plusId);
                
                // Convert ALL 5 to Bunkers
                [ {r:cx, c:cy}, ...armCoords ].forEach(cell => {
                    const v = this.grid[cell.r][cell.c];
                    // Upgrade standard pieces to bunkers. Preserve Scored status.
                    if (v === STATE.P1) this.grid[cell.r][cell.c] = STATE.P1_BUNKER;
                    if (v === STATE.P2) this.grid[cell.r][cell.c] = STATE.P2_BUNKER;
                    if (v === STATE.P1_SCORED) this.grid[cell.r][cell.c] = STATE.P1_BUNKER_SCORED;
                    if (v === STATE.P2_SCORED) this.grid[cell.r][cell.c] = STATE.P2_BUNKER_SCORED;
                });
                
                this.bunkers[p] += 5; // Track count roughly
                this.boosters[p]++;
                return true;
            }
            return false;
        };

        // Check (r,c) as center
        checkPlus(r, c);
        // Check neighbors as center
        checkPlus(r-1, c);
        checkPlus(r+1, c);
        checkPlus(r, c-1);
        checkPlus(r, c+1);

        return earnedTurn;
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

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.roomId = null;
    ws.on("pong", () => ws.isAlive = true);

    ws.on("message", (raw) => {
        try {
            const data = JSON.parse(raw);
            
            if (data.type === "join") {
                const roomId = data.room || "default";
                if (!rooms[roomId]) rooms[roomId] = new GameSession(roomId);
                const game = rooms[roomId];
                
                let role = null;
                if (!game.clients[1]) role = 1;
                else if (!game.clients[2]) role = 2;
                else role = "spectator";

                ws.roomId = roomId;
                ws.role = role;
                game.addClient(ws, role);
                ws.send(JSON.stringify({ type: "WELCOME", role: role }));
                return;
            }

            if (ws.roomId && rooms[ws.roomId]) {
                const game = rooms[ws.roomId];
                if (data.type === "chat") {
                    const chatMsg = JSON.stringify({ type: "chat", msg: data.msg, role: ws.role });
                    [game.clients[1], game.clients[2], ...game.spectators].forEach(c => {
                        if (c && c.readyState === WebSocket.OPEN) c.send(chatMsg);
                    });
                } else if (ws.role === 1 || ws.role === 2) {
                    game.handleAction(ws.role, data);
                }
            }
        } catch (e) {
            console.error("Msg Error:", e);
        }
    });

    ws.on("close", () => {
        if (ws.roomId && rooms[ws.roomId]) {
            rooms[ws.roomId].removeClient(ws);
        }
    });
});

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
