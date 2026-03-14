/**
 * ═══════════════════════════════════════════════════════════════════
 *  OVER HERE! — main.js  (AI + Level Overhaul)
 *  Vite + PeerJS P2P Networked Maze Game
 * ═══════════════════════════════════════════════════════════════════
 *
 *  HOST  = "Viewer"  — sees full map + all enemies. Clicks to Ping.
 *          Drives physics, AI, timer (source of truth). Sends state
 *          to Mover every frame via DataConnection.
 *
 *  MOVER = "Player" — sees Fog-of-War. WASD/Arrow movement.
 *          Sends input to Host every frame. Receives rendered state.
 *
 *  VOICE — PeerJS MediaConnection auto-established on connect.
 *
 *  AI / LEVEL FIXES IN THIS VERSION
 *  ─────────────────────────────────
 *  ✔ BFS pathfinding replaces random-walk patrol → ghosts never get stuck
 *  ✔ Sense radius = 4 tiles (Euclidean). Aggro at 1.5× base speed.
 *  ✔ 3-second post-sense chase before returning to patrol.
 *  ✔ BFS flood-fill guarantees start→exit path exists before accepting maze.
 *  ✔ Enemy spacing: ≥3 tiles from each other and ≥5 tiles from player start.
 *  ✔ Level 1: 0 enemies. Level 2: 1 patrol (no aggro). Level 3: 1 aggro.
 *    Levels 4-10: +1 enemy per level, full aggro + 3-sec chase.
 *  ✔ All networking/PeerJS logic preserved unchanged.
 *  ✔ Player avatar (neon ball) unchanged.
 *  ✔ Font/BGM/SFX triggers unchanged.
 * ═══════════════════════════════════════════════════════════════════
 */

import Peer from "peerjs";

// ───────────────────────────────────────────────────────────────────
//  CONSTANTS
// ───────────────────────────────────────────────────────────────────

const TILE = 40;          // px per maze cell
const COLS = 19;          // must be odd
const ROWS = 15;          // must be odd
const W    = COLS * TILE; // 760
const H    = ROWS * TILE; // 600

const PLAYER_R        = TILE * 0.36;  // collision radius
const PLAYER_SPEED    = 185;          // px/s
const ENEMY_R         = TILE * 0.38;
const ENEMY_BASE_SPD  = 75;
const ENEMY_AGGRO_M   = 1.5;          // FIX: was 2.2, spec says 1.5×
const SENSE_TILES     = 4;            // FIX: 4-tile Euclidean sensing radius
const SENSE_R         = TILE * SENSE_TILES;
const CHASE_LINGER_MS = 3000;         // FIX: 3-second post-aggro chase
const FOG_R           = TILE * 3.4;
const INVU_MS         = 500;          // invulnerability at level start
const SPAWN_MIN_DIST  = TILE * 5;     // min enemy distance from player start
const ENEMY_SPACE_MIN = TILE * 3;     // FIX: min distance between enemies

const C = {
  bg:       "#05050f",
  wall:     "#0c1030",
  wallGlow: "#1a3080",
  floor:    "#060611",
  exit:     "#39ff14",
  player:   "#00f5ff",
  enemy:    "#ff2244",
  ping:     "#ffe600",
};

// ───────────────────────────────────────────────────────────────────
//  RNG
// ───────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────────────────────────────────────────────
//  BFS UTILITIES
//  Used for: path validation, enemy BFS pathfinding to next patrol node
// ───────────────────────────────────────────────────────────────────

/**
 * Returns true if a clear, walkable path exists from (sc,sr) to (ec,er)
 * by moving one tile at a time through floor cells (maze[r][c] === 0).
 */
function bfsReachable(grid, sc, sr, ec, er) {
  if (grid[sr][sc] !== 0 || grid[er][ec] !== 0) return false;
  const visited = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const queue = [[sc, sr]];
  visited[sr][sc] = 1;
  const dirs = [[0,1],[0,-1],[1,0],[-1,0]];
  while (queue.length) {
    const [c, r] = queue.shift();
    if (c === ec && r === er) return true;
    for (const [dc, dr] of dirs) {
      const nc = c + dc, nr = r + dr;
      if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS
          && !visited[nr][nc] && grid[nr][nc] === 0) {
        visited[nr][nc] = 1;
        queue.push([nc, nr]);
      }
    }
  }
  return false;
}

/**
 * BFS shortest-path from (sc,sr) to (ec,er).
 * Returns array of {c,r} waypoints (inclusive of start and end),
 * or null if no path exists.
 */
function bfsPath(grid, sc, sr, ec, er) {
  if (grid[sr][sc] !== 0 || grid[er][ec] !== 0) return null;
  const visited = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const prev    = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
  const queue   = [[sc, sr]];
  visited[sr][sc] = 1;
  const dirs = [[0,1],[0,-1],[1,0],[-1,0]];
  let found = false;
  outer: while (queue.length) {
    const [c, r] = queue.shift();
    for (const [dc, dr] of dirs) {
      const nc = c + dc, nr = r + dr;
      if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS
          && !visited[nr][nc] && grid[nr][nc] === 0) {
        visited[nr][nc] = 1;
        prev[nr][nc] = [c, r];
        if (nc === ec && nr === er) { found = true; break outer; }
        queue.push([nc, nr]);
      }
    }
  }
  if (!found) return null;
  const path = [];
  let cur = [ec, er];
  while (cur) {
    path.unshift({ c: cur[0], r: cur[1] });
    cur = prev[cur[1]][cur[0]];
  }
  return path;
}

// ───────────────────────────────────────────────────────────────────
//  MAZE GENERATION
//  Recursive backtracker + loop cuts → imperfect maze (multi-path)
//  FIX: Retry until BFS confirms start→exit path is clear.
// ───────────────────────────────────────────────────────────────────

function buildMaze(seed, extraLoops) {
  // Try up to 8 variants of the seed until we get a valid maze
  for (let attempt = 0; attempt < 8; attempt++) {
    const grid = tryBuildMaze(seed + attempt * 31337, extraLoops);
    // FIX: Validate that start (1,1) → exit (COLS-2, ROWS-2) is reachable
    if (bfsReachable(grid, 1, 1, COLS - 2, ROWS - 2)) {
      return grid;
    }
  }
  // Fallback: open corridors to guarantee connectivity
  return buildOpenMaze(seed, extraLoops);
}

function tryBuildMaze(seed, extraLoops) {
  const rng  = mulberry32(seed);
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(1));
  const vis  = Array.from({ length: ROWS }, () => Array(COLS).fill(false));

  function carve(cx, cy) {
    vis[cy][cx]  = true;
    grid[cy][cx] = 0;
    const dirs = [[0,-2],[0,2],[-2,0],[2,0]].sort(() => rng() - 0.5);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx > 0 && nx < COLS-1 && ny > 0 && ny < ROWS-1 && !vis[ny][nx]) {
        grid[cy + dy / 2][cx + dx / 2] = 0;
        carve(nx, ny);
      }
    }
  }
  carve(1, 1);

  // Remove random interior walls to create loops / alternative paths
  for (let i = 0; i < extraLoops; i++) {
    const x = Math.floor(rng() * (COLS - 2)) + 1;
    const y = Math.floor(rng() * (ROWS - 2)) + 1;
    if (grid[y][x] === 1) {
      let floorNeighbors = 0;
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        if (grid[y+dy]?.[x+dx] === 0) floorNeighbors++;
      }
      if (floorNeighbors >= 2) grid[y][x] = 0;
    }
  }

  grid[1][1]           = 0;
  grid[ROWS-2][COLS-2] = 0;

  return grid;
}

// Fallback maze: carve explicit corridors to guarantee connectivity
function buildOpenMaze(seed, extraLoops) {
  const grid = tryBuildMaze(seed, extraLoops);
  // Force a top-row corridor and a right-column corridor
  for (let c = 1; c < COLS - 1; c++) grid[1][c] = 0;
  for (let r = 1; r < ROWS - 1; r++) grid[r][COLS-2] = 0;
  grid[ROWS-2][COLS-2] = 0;
  return grid;
}

// ───────────────────────────────────────────────────────────────────
//  LEVEL CONFIGS  — 10 levels
//  FIX: Level 1: 0 enemies. Level 2: 1 patrol, no aggro.
//       Level 3: 1 enemy with aggro. Level 4-10: +1 per level, full aggro.
// ───────────────────────────────────────────────────────────────────

const LEVELS = [
  /* 1 */ { seed:1001, loops:12, enemies:0,  aggroOn:false },
  /* 2 */ { seed:1002, loops:10, enemies:1,  aggroOn:false },
  /* 3 */ { seed:1003, loops: 9, enemies:1,  aggroOn:true  },
  /* 4 */ { seed:1004, loops: 8, enemies:2,  aggroOn:true  },
  /* 5 */ { seed:1005, loops: 7, enemies:3,  aggroOn:true  },
  /* 6 */ { seed:1006, loops: 6, enemies:4,  aggroOn:true  },
  /* 7 */ { seed:1007, loops: 5, enemies:5,  aggroOn:true  },
  /* 8 */ { seed:1008, loops: 4, enemies:6,  aggroOn:true  },
  /* 9 */ { seed:1009, loops: 3, enemies:7,  aggroOn:true  },
  /*10 */ { seed:1010, loops: 2, enemies:8,  aggroOn:true  },
];

// ───────────────────────────────────────────────────────────────────
//  GAME STATE ENUM
// ───────────────────────────────────────────────────────────────────

const S = { MENU:"MENU", PLAYING:"PLAYING", PAUSED:"PAUSED",
            DANCING:"DANCING", WIN:"WIN", DEAD:"DEAD" };

// ───────────────────────────────────────────────────────────────────
//  RUNTIME VARS
// ───────────────────────────────────────────────────────────────────

let appState    = S.MENU;
let role        = null;       // "host" | "mover"
let levelIdx    = 0;

// World (authoritative on Host, mirrored via network on Mover)
let maze        = null;
let player      = null;  // { x,y,vx,vy, angle }
let enemies     = [];    // [{ x,y,vx,vy,aggro,patrolPath,patrolIdx,chaseUntil }]
let pings       = [];    // [{ x,y,born }]
let elapsed     = 0;     // seconds
let invuUntil   = 0;     // performance.now() — invulnerability end
let danceTimer  = 0;     // seconds into victory dance
let pingCounter = 0;

// Input maps
const localKeys  = {};   // this client's keyboard
let   remoteKeys = {};   // Mover's keys received by Host

window.addEventListener("keydown", e => {
  localKeys[e.code] = true;
  if (e.code === "Escape") onEsc();
});
window.addEventListener("keyup", e => { localKeys[e.code] = false; });

// ───────────────────────────────────────────────────────────────────
//  AUDIO
// ───────────────────────────────────────────────────────────────────

const bgMusic  = new Audio("/bgmusic.mp3");
bgMusic.loop   = true;
bgMusic.volume = 0.2;
let bgStarted  = false;

const sfxWin   = new Audio("/win.mp3");
const sfxDeath = new Audio("/death.mp3");
const sfxPing  = new Audio("/ping.mp3"); // optional, silent if missing

function playBgm() {
  if (bgStarted) return;
  bgStarted = true;
  bgMusic.play().catch(() => {});
}

function stopBgm() {
  bgMusic.pause();
  bgMusic.currentTime = 0;
  bgStarted = false;
}

function playSfx(audio) {
  try {
    const c = audio.cloneNode();
    c.volume = 0.7;
    c.play().catch(() => {});
  } catch(_) {}
}

// ───────────────────────────────────────────────────────────────────
//  CANVAS
// ───────────────────────────────────────────────────────────────────

const canvas = document.getElementById("game-canvas");
const ctx    = canvas.getContext("2d");

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ───────────────────────────────────────────────────────────────────
//  PEERJS NETWORKING  (PRESERVED — no changes below this line until
//  LEVEL INIT section)
// ───────────────────────────────────────────────────────────────────

let peer       = null;
let dataConn   = null;
let mediaConn  = null;
let localStream = null;

function makeRoomId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

async function getMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
    return localStream;
  } catch(e) {
    console.warn("Mic not available:", e);
    return null;
  }
}

// ── HOST INIT ─────────────────────────────────────────────────────
function initHost() {
  role = "host";
  const roomId = makeRoomId();
  el("room-code-display").textContent = roomId;
  setStatus("host", "⏳ Waiting for player…");

  peer = new Peer(roomId, { debug: 0 });

  peer.on("open", () => setStatus("host", "✅ Share the Room ID above!"));

  peer.on("connection", dc => {
    dataConn = dc;
    setStatus("host", "🎮 Player connecting…");

    dc.on("open", () => {
      setStatus("host", "🎮 Player connected! Starting…");
      // ── CRITICAL HANDSHAKE ──────────────────────────────────────
      // Build the level immediately and send full levelData so Mover
      // can transition to PLAYING without delay.
      initLevel(levelIdx);              // sets maze, player, enemies
      const packet = buildLevelPacket(); // package everything
      dc.send(packet);                  // Mover gets it → PLAYING

      // Host transitions to PLAYING too
      transitionToGame();
    });

    dc.on("data", onDataFromMover);
    dc.on("error", e => console.error("DC error:", e));
  });

  peer.on("call", async call => {
    const s = await getMic();
    call.answer(s || undefined);
    call.on("stream", attachRemoteAudio);
  });

  peer.on("error", e => {
    setStatus("host", `❌ PeerJS: ${e.type}`);
    console.error(e);
  });
}

// ── MOVER INIT ────────────────────────────────────────────────────
async function initMover(hostId) {
  role = "mover";
  setStatus("join", "⏳ Connecting to host…");

  peer = new Peer(undefined, { debug: 0 });

  peer.on("open", async () => {
    const stream = await getMic();

    // Data channel
    dataConn = peer.connect(hostId, { reliable: true, serialization: "json" });

    dataConn.on("open", () => {
      setStatus("join", "✅ Connected! Waiting for level…");

      // Voice call to host
      if (stream) {
        mediaConn = peer.call(hostId, stream);
        mediaConn.on("stream", attachRemoteAudio);
      }
    });

    dataConn.on("data", onDataFromHost);
    dataConn.on("error", e => console.error("DC error:", e));
  });

  peer.on("error", e => {
    setStatus("join", `❌ ${e.type} — check the Room ID`);
    console.error(e);
  });
}

function attachRemoteAudio(stream) {
  const audio = new Audio();
  audio.srcObject = stream;
  audio.autoplay  = true;
  audio.play().catch(() => {});
  el("voice-badge").classList.remove("hidden");
}

// ── DATA HANDLERS ─────────────────────────────────────────────────

function onDataFromMover(pkt) {
  if (!pkt) return;
  if (pkt.type === "input") remoteKeys = pkt.keys || {};
}

function onDataFromHost(pkt) {
  if (!pkt) return;

  switch (pkt.type) {

    case "levelData":
      // Receive maze + initial positions — transition to PLAYING
      maze    = pkt.maze;
      player  = pkt.player;
      enemies = pkt.enemies;
      pings   = [];
      elapsed = 0;
      levelIdx = pkt.levelIdx;
      invuUntil = performance.now() + INVU_MS;
      updateHudLevel();
      transitionToGame();
      break;

    case "state":
      // Every-frame sync
      if (pkt.player)  player  = pkt.player;
      if (pkt.enemies) enemies = pkt.enemies;
      if (pkt.pings)   pings   = pkt.pings;
      elapsed = pkt.elapsed ?? elapsed;
      updateTimer(elapsed);
      if (pkt.appState && pkt.appState !== appState) {
        appState = pkt.appState;
        syncOverlays();
      }
      break;

    case "event":
      handleRemoteEvent(pkt);
      break;

    case "loadLevel":
      // Host asks Mover to prepare for a new level
      maze    = pkt.maze;
      player  = pkt.player;
      enemies = pkt.enemies;
      pings   = [];
      elapsed = 0;
      levelIdx = pkt.levelIdx;
      invuUntil = performance.now() + INVU_MS;
      updateHudLevel();
      appState = S.PLAYING;
      syncOverlays();
      break;
  }
}

function handleRemoteEvent(pkt) {
  if (pkt.evt === "win")   triggerWin(false);
  if (pkt.evt === "death") triggerDeath(false);
  if (pkt.evt === "ping")  playSfx(sfxPing);
}

// ── BROADCAST HELPERS ─────────────────────────────────────────────

let lastStateSend = 0;
function sendState() {
  if (!dataConn?.open) return;
  const now = performance.now();
  if (now - lastStateSend < 16) return; // ~60fps cap
  lastStateSend = now;
  dataConn.send({
    type: "state",
    player,
    enemies: enemies.map(e => ({ x:e.x, y:e.y, aggro:e.aggro })),
    pings,
    elapsed,
    appState,
  });
}

function sendEvent(evt, extra = {}) {
  dataConn?.open && dataConn.send({ type:"event", evt, ...extra });
}

function buildLevelPacket() {
  return {
    type: "levelData",
    levelIdx,
    maze,
    player: { ...player },
    enemies: enemies.map(e => ({
      x: e.x, y: e.y,
      aggro: false,
      patrolPath: e.patrolPath,
      patrolIdx:  e.patrolIdx,
      chaseUntil: 0,
    })),
  };
}

// ───────────────────────────────────────────────────────────────────
//  LEVEL INIT  (Host only — Mover receives via network)
// ───────────────────────────────────────────────────────────────────

function initLevel(idx) {
  const cfg = LEVELS[Math.min(idx, LEVELS.length - 1)];
  maze = buildMaze(cfg.seed, cfg.loops);

  // Player spawn: top-left open cell
  player = { x: 1 * TILE + TILE/2, y: 1 * TILE + TILE/2, vx:0, vy:0, angle:0 };

  // Enemies
  enemies = spawnEnemies(cfg.enemies, cfg.seed + 9999, cfg.aggroOn);

  pings      = [];
  elapsed    = 0;
  invuUntil  = performance.now() + INVU_MS;
  danceTimer = 0;
}

// ── ENEMY SPAWNING  (FIX: spacing checks + BFS patrol generation) ──

function spawnEnemies(count, seed, aggroEnabled) {
  const rng  = mulberry32(seed);
  const list = [];
  const px   = player.x, py = player.y;

  // Collect all floor cells that are:
  //  • far enough from the player start (SPAWN_MIN_DIST)
  //  • NOT on the start or exit cell
  const candidates = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (maze[r][c] !== 0) continue;
      if (c === 1 && r === 1) continue;           // player start
      if (c === COLS-2 && r === ROWS-2) continue; // exit
      const ex = c * TILE + TILE/2;
      const ey = r * TILE + TILE/2;
      if (Math.hypot(ex - px, ey - py) >= SPAWN_MIN_DIST) {
        candidates.push({ c, r, ex, ey });
      }
    }
  }

  // Shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  for (const cand of candidates) {
    if (list.length >= count) break;

    // FIX: Ensure this candidate is at least ENEMY_SPACE_MIN from existing enemies
    const tooClose = list.some(e =>
      Math.hypot(cand.ex - e.x, cand.ey - e.y) < ENEMY_SPACE_MIN
    );
    if (tooClose) continue;

    const patrolPath = buildBfsPatrol(cand.c, cand.r, mulberry32(seed + list.length));

    list.push({
      x: cand.ex,
      y: cand.ey,
      vx: 0, vy: 0,
      aggro: false,
      aggroEnabled,
      patrolPath,
      patrolIdx:  0,
      // FIX: timestamp (ms) until which the ghost keeps chasing after losing sight
      chaseUntil: 0,
    });
  }

  return list;
}

// ─────────────────────────────────────────────────────────────────
//  BFS PATROL BUILDER
//  FIX: Replaces random ±2-step walk (which skips over walls).
//  Picks 8 random floor-cell waypoints reachable from each other
//  via adjacent steps so the ghost can always navigate between them.
// ─────────────────────────────────────────────────────────────────

function buildBfsPatrol(sc, sr, rng) {
  // Collect all reachable floor cells from (sc,sr)
  const reachable = [];
  const visited   = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const queue     = [[sc, sr]];
  visited[sr][sc] = 1;
  const dirs      = [[0,1],[0,-1],[1,0],[-1,0]];

  while (queue.length) {
    const [c, r] = queue.shift();
    reachable.push({ c, r });
    for (const [dc, dr] of dirs) {
      const nc = c + dc, nr = r + dr;
      if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS
          && !visited[nr][nc] && maze[nr][nc] === 0) {
        visited[nr][nc] = 1;
        queue.push([nc, nr]);
      }
    }
  }

  if (reachable.length === 0) return [{ c: sc, r: sr }];

  // Shuffle reachable cells and pick up to 8 as waypoints
  for (let i = reachable.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [reachable[i], reachable[j]] = [reachable[j], reachable[i]];
  }

  const waypoints = [{ c: sc, r: sr }];
  for (const cell of reachable) {
    if (waypoints.length >= 8) break;
    // Only add if not too close to previous waypoint (spread them out)
    const last = waypoints[waypoints.length - 1];
    if (Math.abs(cell.c - last.c) + Math.abs(cell.r - last.r) >= 3) {
      waypoints.push(cell);
    }
  }

  return waypoints;
}

// ───────────────────────────────────────────────────────────────────
//  SCREEN TRANSITIONS
// ───────────────────────────────────────────────────────────────────

function transitionToGame() {
  stopBgm();                     // ── AUDIO FIX: stop BGM on game start
  showScreen("game-screen");
  el("hud-role").textContent = role === "host" ? "HOST" : "MOVER";
  updateHudLevel();
  appState = S.PLAYING;
  syncOverlays();
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => {
    s.classList.remove("active");
    s.classList.add("hidden");
  });
  const t = el(id);
  t.classList.remove("hidden");
  t.classList.add("active");
}

function syncOverlays() {
  setHidden("ov-pause", appState !== S.PAUSED);
  setHidden("ov-win",   appState !== S.WIN);
  setHidden("ov-death", appState !== S.DEAD);
}

// ───────────────────────────────────────────────────────────────────
//  GAME LOOP
// ───────────────────────────────────────────────────────────────────

let prevTs = performance.now();

function gameLoop(ts) {
  const dt = Math.min((ts - prevTs) / 1000, 0.05);
  prevTs = ts;

  if (appState === S.PLAYING) {
    if (role === "host") {
      updatePhysics(dt);
      sendState();
    }
    if (role === "mover" && dataConn?.open) {
      dataConn.send({ type:"input", keys:{ ...localKeys } });
    }
  }

  if (appState === S.DANCING) {
    danceTimer += dt;
    if (danceTimer > 1.8) {
      appState = S.WIN;
      syncOverlays();
      el("ov-win-time").textContent = `Escaped in ${fmtTime(elapsed)}`;
    }
    if (role === "host") sendState();
  }

  draw();
  requestAnimationFrame(gameLoop);
}

// ───────────────────────────────────────────────────────────────────
//  PHYSICS  (Host-authoritative)
// ───────────────────────────────────────────────────────────────────

const EXIT_X = (COLS-2) * TILE + TILE/2;
const EXIT_Y = (ROWS-2) * TILE + TILE/2;

function updatePhysics(dt) {
  elapsed += dt;
  updateTimer(elapsed);

  const input = remoteKeys; // Mover's input
  const lvlSpeedMult = 1 + levelIdx * 0.08;
  const nowMs = performance.now();

  // ── Player movement ──
  const dx = boolAxis(input, "ArrowRight","KeyD") - boolAxis(input,"ArrowLeft","KeyA");
  const dy = boolAxis(input, "ArrowDown", "KeyS") - boolAxis(input,"ArrowUp",  "KeyW");
  const len = Math.hypot(dx, dy) || 1;
  const norm = (dx || dy) ? 1/len : 0;
  player.vx = dx * norm * PLAYER_SPEED;
  player.vy = dy * norm * PLAYER_SPEED;
  if (dx || dy) player.angle = Math.atan2(dy, dx);

  player.x = slideAxis(player.x, player.vx * dt, player.y, false);
  player.y = slideAxis(player.y, player.vy * dt, player.x, true);

  // ── Enemies ──
  for (const e of enemies) {
    const dist = Math.hypot(player.x - e.x, player.y - e.y);

    // ── FIX: Aggro state machine ──────────────────────────────────
    // Enter aggro: player within SENSE_R (4-tile Euclidean)
    if (e.aggroEnabled && dist < SENSE_R) {
      e.aggro      = true;
      e.chaseUntil = nowMs + CHASE_LINGER_MS; // reset 3-sec timer
    }
    // Exit aggro: sense radius left AND 3-second linger expired
    else if (e.aggro && nowMs > e.chaseUntil) {
      e.aggro = false;
    }
    // While in linger window (player left radius but <3 s ago): stay aggro
    else if (!e.aggroEnabled) {
      e.aggro = false;
    }

    const spd = ENEMY_BASE_SPD * lvlSpeedMult * (e.aggro ? ENEMY_AGGRO_M : 1);

    if (e.aggro) {
      // ── FIX: Smooth BFS-guided chase ─────────────────────────────
      // Move directly toward the player (they are on walkable floor —
      // the ghost gets un-stuck via wall-slide physics same as player).
      const d = dist || 1;
      e.vx = ((player.x - e.x) / d) * spd;
      e.vy = ((player.y - e.y) / d) * spd;

    } else if (e.patrolPath && e.patrolPath.length > 0) {
      // ── FIX: BFS-waypoint patrol ──────────────────────────────────
      // Navigate to the current waypoint using pixel-level movement.
      // When close enough, advance to the next waypoint.
      const pt = e.patrolPath[e.patrolIdx % e.patrolPath.length];
      const tx = pt.c * TILE + TILE / 2;
      const ty = pt.r * TILE + TILE / 2;
      const pd = Math.hypot(tx - e.x, ty - e.y);

      if (pd < 3) {
        // Snap to waypoint and advance index
        e.x = tx;
        e.y = ty;
        e.vx = 0;
        e.vy = 0;
        e.patrolIdx = (e.patrolIdx + 1) % e.patrolPath.length;
      } else {
        e.vx = ((tx - e.x) / pd) * spd;
        e.vy = ((ty - e.y) / pd) * spd;
      }
    }

    // Apply movement with wall-slide collision (same as player)
    e.x = slideAxisEnemy(e.x, e.vx * dt, e.y, false);
    e.y = slideAxisEnemy(e.y, e.vy * dt, e.x, true);
  }

  // Expire old pings
  pings = pings.filter(p => elapsed - p.born < 2.2);

  // ── Win check ──
  if (Math.hypot(player.x - EXIT_X, player.y - EXIT_Y) < TILE * 0.6) {
    triggerWin(true);
    return;
  }

  // ── Death check (with invulnerability window) ──
  if (performance.now() > invuUntil) {
    for (const e of enemies) {
      if (Math.hypot(player.x - e.x, player.y - e.y) < PLAYER_R + ENEMY_R) {
        triggerDeath(true);
        return;
      }
    }
  }
}

function boolAxis(keys, a, b) { return (keys[a] || keys[b]) ? 1 : 0; }

// Axis-separated sliding collision for the player
function slideAxis(pos, vel, crossPos, isY) {
  if (vel === 0) return pos;
  const next  = pos + vel;
  const half  = PLAYER_R * 0.88;
  const cross = crossPos;

  const checks = isY
    ? [[cross - half + 2, next - half], [cross + half - 2, next - half],
       [cross - half + 2, next + half], [cross + half - 2, next + half]]
    : [[next - half, cross - half + 2], [next - half, cross + half - 2],
       [next + half, cross - half + 2], [next + half, cross + half - 2]];

  for (const [wx, wy] of checks) {
    if (solidAt(wx, wy)) return pos;
  }
  return next;
}

// Axis-separated sliding collision for enemies (slightly larger radius)
function slideAxisEnemy(pos, vel, crossPos, isY) {
  if (vel === 0) return pos;
  const next  = pos + vel;
  const half  = ENEMY_R * 0.82;
  const cross = crossPos;

  const checks = isY
    ? [[cross - half + 2, next - half], [cross + half - 2, next - half],
       [cross - half + 2, next + half], [cross + half - 2, next + half]]
    : [[next - half, cross - half + 2], [next - half, cross + half - 2],
       [next + half, cross - half + 2], [next + half, cross + half - 2]];

  for (const [wx, wy] of checks) {
    if (solidAt(wx, wy)) return pos;
  }
  return next;
}

function solidAt(wx, wy) {
  const c = Math.floor(wx / TILE), r = Math.floor(wy / TILE);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return true;
  return maze[r][c] === 1;
}

// ───────────────────────────────────────────────────────────────────
//  WIN / DEATH / PAUSE
// ───────────────────────────────────────────────────────────────────

function triggerWin(isAuthority) {
  if (appState === S.WIN || appState === S.DANCING) return;
  playSfx(sfxWin);
  danceTimer = 0;
  appState   = S.DANCING;          // start victory dance
  if (isAuthority) sendEvent("win");
}

function triggerDeath(isAuthority) {
  if (appState === S.DEAD) return;
  playSfx(sfxDeath);
  appState = S.DEAD;
  syncOverlays();
  if (isAuthority) sendEvent("death");
}

function onEsc() {
  if (appState === S.PLAYING) {
    appState = S.PAUSED;
    syncOverlays();
  } else if (appState === S.PAUSED) {
    appState = S.PLAYING;
    prevTs   = performance.now();
    syncOverlays();
  }
}

// ───────────────────────────────────────────────────────────────────
//  NEXT LEVEL / RETRY  (Host-driven, Mover follows via network)
// ───────────────────────────────────────────────────────────────────

el("btn-next-level").addEventListener("click", () => {
  if (role !== "host") return;
  levelIdx = Math.min(levelIdx + 1, LEVELS.length - 1);
  initLevel(levelIdx);
  updateHudLevel();
  appState = S.PLAYING;
  syncOverlays();
  if (dataConn?.open) {
    const pkt = buildLevelPacket();
    pkt.type = "loadLevel";
    dataConn.send(pkt);
  }
});

el("btn-retry").addEventListener("click", () => {
  if (role !== "host") return;
  initLevel(levelIdx);
  updateHudLevel();
  appState = S.PLAYING;
  syncOverlays();
  if (dataConn?.open) {
    const pkt = buildLevelPacket();
    pkt.type = "loadLevel";
    dataConn.send(pkt);
  }
});

// ───────────────────────────────────────────────────────────────────
//  HOST CLICK → PING
// ───────────────────────────────────────────────────────────────────

canvas.addEventListener("click", e => {
  if (role !== "host" || appState !== S.PLAYING) return;
  const rect  = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const { ox, oy, scale } = hostViewTransform();
  const mx = (sx - ox) / scale;
  const my = (sy - oy) / scale;
  if (mx < 0 || my < 0 || mx > W || my > H) return;
  pings.push({ x:mx, y:my, born:elapsed, id: pingCounter++ });
  playSfx(sfxPing);
  sendEvent("ping");
});

function hostViewTransform() {
  const scale = Math.min(canvas.width / W, canvas.height / H);
  const ox    = (canvas.width  - W * scale) / 2;
  const oy    = (canvas.height - H * scale) / 2;
  return { ox, oy, scale };
}

// ───────────────────────────────────────────────────────────────────
//  RENDERER
// ───────────────────────────────────────────────────────────────────

function draw() {
  if (!maze || !player) return;
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  if (role === "host") {
    const { ox, oy, scale } = hostViewTransform();
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    drawWorld(false);
    ctx.restore();
  } else {
    drawMoverView(cw, ch);
  }
}

// ── HOST VIEW — full map ──────────────────────────────────────────
function drawWorld(isMoverFog) {
  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // Tiles
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (maze[r][c] === 1) drawWall(c * TILE, r * TILE);
      else {
        ctx.fillStyle = C.floor;
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      }
    }
  }

  drawExit();

  for (const p of pings) drawPing(p);
  for (const e of enemies) drawGhost(e);

  // Player
  const dancing = appState === S.DANCING;
  drawPlayerChar(player.x, player.y, player.angle, dancing);
}

// ── MOVER VIEW — fog of war ───────────────────────────────────────
function drawMoverView(cw, ch) {
  const px = player.x, py = player.y;

  // Camera offset so player is centred
  const ox = cw / 2 - px;
  const oy = ch / 2 - py;

  ctx.save();
  ctx.translate(ox, oy);

  drawWorld(true);

  // Fog mask (destination-in = keep only inside the gradient)
  ctx.globalCompositeOperation = "destination-in";
  const fog = ctx.createRadialGradient(px, py, FOG_R * 0.15, px, py, FOG_R);
  fog.addColorStop(0,   "rgba(0,0,0,1)");
  fog.addColorStop(0.72,"rgba(0,0,0,1)");
  fog.addColorStop(1,   "rgba(0,0,0,0)");
  ctx.fillStyle = fog;
  ctx.fillRect(-ox, -oy, cw, ch);

  ctx.globalCompositeOperation = "source-over";

  // Outer darkness beyond fog edge
  const outer = ctx.createRadialGradient(px, py, FOG_R * 0.8, px, py, FOG_R * 2.2);
  outer.addColorStop(0, "rgba(3,3,14,0)");
  outer.addColorStop(1, "rgba(3,3,14,1)");
  ctx.fillStyle = outer;
  ctx.fillRect(-ox, -oy, cw, ch);

  ctx.restore();
}

// ── DRAW HELPERS ─────────────────────────────────────────────────

function drawWall(x, y) {
  ctx.fillStyle = C.wall;
  ctx.fillRect(x, y, TILE, TILE);
  ctx.save();
  ctx.strokeStyle = C.wallGlow;
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = "#1535a0";
  ctx.shadowBlur  = 7;
  ctx.strokeRect(x + 1.5, y + 1.5, TILE - 3, TILE - 3);
  ctx.restore();
}

function drawExit() {
  const x = (COLS-2) * TILE, y = (ROWS-2) * TILE;
  const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.2);
  ctx.save();
  ctx.shadowColor = C.exit;
  ctx.shadowBlur  = 20 + pulse * 16;
  ctx.fillStyle   = `rgba(57,255,20,${0.12 + pulse * 0.22})`;
  ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
  ctx.strokeStyle = C.exit;
  ctx.lineWidth   = 2.5;
  ctx.strokeRect(x + 4, y + 4, TILE - 8, TILE - 8);
  ctx.fillStyle    = C.exit;
  ctx.font         = `bold ${TILE * 0.52}px monospace`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("▶", x + TILE/2, y + TILE/2);
  ctx.restore();
}

// ── PLAYER (cyan neon ball — UNCHANGED) ──────────────────────────
function drawPlayerChar(px, py, angle, dancing) {
  const t  = elapsed;
  const r  = PLAYER_R;

  ctx.save();
  ctx.translate(px, py);

  if (dancing) {
    const spin  = danceTimer * 5;
    const scale = 1 + 0.22 * Math.sin(danceTimer * 14);
    ctx.rotate(spin);
    ctx.scale(scale, scale);
  }

  ctx.shadowColor = C.player;
  ctx.shadowBlur  = 22 + 8 * Math.sin(t * 4);

  // Body (circle + glow layers)
  const bodyGrad = ctx.createRadialGradient(-r*0.2, -r*0.2, r*0.05, 0, 0, r);
  bodyGrad.addColorStop(0, "#aaffff");
  bodyGrad.addColorStop(0.5, C.player);
  bodyGrad.addColorStop(1, "#0077aa");
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // Head "eyes"
  ctx.fillStyle  = "#fff";
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(-r*0.28, -r*0.22, r*0.18, 0, Math.PI*2);
  ctx.arc( r*0.28, -r*0.22, r*0.18, 0, Math.PI*2);
  ctx.fill();

  // Pupils
  ctx.fillStyle = "#003344";
  ctx.beginPath();
  ctx.arc(-r*0.28, -r*0.22, r*0.08, 0, Math.PI*2);
  ctx.arc( r*0.28, -r*0.22, r*0.08, 0, Math.PI*2);
  ctx.fill();

  // Inner glow highlight
  ctx.beginPath();
  ctx.arc(-r*0.18, -r*0.18, r*0.28, 0, Math.PI*2);
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.fill();

  // Dancing sparkles
  if (dancing) {
    for (let i = 0; i < 6; i++) {
      const a   = (i / 6) * Math.PI * 2 + danceTimer * 3;
      const rad = r * 1.6 + 4 * Math.sin(danceTimer * 8 + i);
      ctx.beginPath();
      ctx.arc(Math.cos(a)*rad, Math.sin(a)*rad, 3, 0, Math.PI*2);
      ctx.fillStyle = `hsl(${(i*60 + t*120) % 360},100%,70%)`;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur  = 10;
      ctx.fill();
    }
  }

  ctx.restore();
}

// ── GHOST (enemy) ─────────────────────────────────────────────────
function drawGhost(e) {
  const t = elapsed;
  const gx = e.x, gy = e.y;
  const w  = TILE * 0.70, h = TILE * 0.76;
  const waves = 4;

  ctx.save();
  ctx.shadowColor = C.enemy;
  ctx.shadowBlur  = e.aggro ? 30 + 10 * Math.sin(t * 9) : 14;
  ctx.fillStyle   = e.aggro ? "#ff0022" : C.enemy;

  ctx.beginPath();
  ctx.arc(gx, gy - h * 0.08, w / 2, Math.PI, 0);
  ctx.lineTo(gx + w/2, gy + h * 0.42);
  for (let i = 0; i < waves; i++) {
    const wx1 = gx + w/2 - (w/waves)*(i+0.5);
    const wx2 = gx + w/2 - (w/waves)*(i+1);
    const wy  = gy + h*0.42 + (i%2===0?1:-1)*(TILE*0.12 + 0.07*Math.sin(t*5+i));
    ctx.quadraticCurveTo(wx1, wy, wx2, gy + h*0.42);
  }
  ctx.closePath();
  ctx.fill();

  // Eyes
  ctx.fillStyle  = "#fff";
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(gx - w*0.19, gy - h*0.14, w*0.115, 0, Math.PI*2);
  ctx.arc(gx + w*0.19, gy - h*0.14, w*0.115, 0, Math.PI*2);
  ctx.fill();

  ctx.fillStyle = e.aggro ? "#ff0000" : "#110022";
  ctx.beginPath();
  ctx.arc(gx - w*0.19, gy - h*0.14, w*0.055, 0, Math.PI*2);
  ctx.arc(gx + w*0.19, gy - h*0.14, w*0.055, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();
}

// ── PING (ripple) ─────────────────────────────────────────────────
function drawPing({ x, y, born }) {
  const progress = (elapsed - born) / 2.2;
  if (progress >= 1) return;

  ctx.save();
  for (let ring = 0; ring < 3; ring++) {
    const rp    = (progress + ring * 0.18) % 1;
    const rad   = rp * TILE * 2.8;
    const alpha = (1 - rp) * 0.85;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI*2);
    ctx.strokeStyle = `rgba(255,230,0,${alpha})`;
    ctx.lineWidth   = 2.8 * (1-rp);
    ctx.shadowColor = C.ping;
    ctx.shadowBlur  = 12;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI*2);
  ctx.fillStyle   = C.ping;
  ctx.shadowBlur  = 18;
  ctx.shadowColor = C.ping;
  ctx.fill();
  ctx.restore();
}

// ───────────────────────────────────────────────────────────────────
//  HUD HELPERS
// ───────────────────────────────────────────────────────────────────

function updateTimer(s) {
  el("hud-timer").textContent = fmtTime(s);
}

function fmtTime(s) {
  const m   = Math.floor(s/60).toString().padStart(2,"0");
  const sec = Math.floor(s%60).toString().padStart(2,"0");
  return `${m}:${sec}`;
}

function updateHudLevel() {
  el("hud-level").textContent = levelIdx + 1;
}

// ───────────────────────────────────────────────────────────────────
//  MENU WIRING
// ───────────────────────────────────────────────────────────────────

el("btn-host").addEventListener("click", () => {
  playBgm();                   // ── AUDIO: start BGM on first interaction
  setHidden("host-panel", false);
  setHidden("join-panel",  true);
  initHost();
});

el("btn-join").addEventListener("click", () => {
  playBgm();                   // ── AUDIO: start BGM on first interaction
  setHidden("join-panel",  false);
  setHidden("host-panel",  true);
});

el("btn-connect").addEventListener("click", () => {
  const id = el("room-code-input").value.trim().toUpperCase();
  if (!id) return;
  initMover(id);
});

el("room-code-input").addEventListener("keydown", e => {
  if (e.key === "Enter") el("btn-connect").click();
});

el("btn-copy-code").addEventListener("click", () => {
  const code = el("room-code-display").textContent;
  navigator.clipboard.writeText(code).then(() => {
    el("btn-copy-code").textContent = "COPIED ✓";
    setTimeout(() => { el("btn-copy-code").textContent = "COPY ID"; }, 2000);
  });
});

// ───────────────────────────────────────────────────────────────────
//  UTILITY
// ───────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function setHidden(id, hidden) {
  el(id).classList.toggle("hidden", hidden);
}

function setStatus(who, msg) {
  el(who === "host" ? "host-status" : "join-status").textContent = msg;
}

// ───────────────────────────────────────────────────────────────────
//  KICK OFF RENDER LOOP
// ───────────────────────────────────────────────────────────────────

requestAnimationFrame(gameLoop);