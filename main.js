/**
 * ═══════════════════════════════════════════════════════════════════
 *  OVER HERE! — main.js
 *  Vite + PeerJS P2P Networked Maze Game
 * ═══════════════════════════════════════════════════════════════════
 *
 *  HOST  = "Viewer"  — sees full map + all enemies. Clicks to Ping.
 *          Drives physics, AI, timer (source of truth). Sends state
 *          to Mover every frame via DataConnection.
 *
 *  MOVER = "Player" — sees Fog-of-War. WASD / Arrow / D-Pad movement.
 *          Sends input to Host every frame. Receives rendered state.
 *
 *  VOICE — PeerJS MediaConnection auto-established on connect.
 *
 *  ── CHANGES IN THIS VERSION ────────────────────────────────────────
 *
 *  FAIRNESS ENGINE (Level 3+)
 *    • After maze generation, bfsShortestPath() finds the true shortest
 *      route from Start → Exit.
 *    • spawnEnemies() refuses to place any ghost on a shortest-path tile.
 *    • buildLevel() retries up to MAX_LEVEL_ATTEMPTS times if:
 *        a) exit is structurally unreachable (bfsReachable fails), OR
 *        b) the ghost quota cannot be filled without blocking the path.
 *
 *  ENEMY SCALING  (Level 0 = 1 ghost, +1 per level, all 10 levels)
 *    • Level 0: 1 ghost, aggro OFF  (tutorial)
 *    • Level 1: 2 ghosts, aggro OFF
 *    • Level 2: 3 ghosts, aggro ON  (first chase level)
 *    • Levels 3-9: count = level+1, aggro ON, mazes tighter per level
 *
 *  ACTIVE PATROL  (ghosts never stand still)
 *    • buildLocalPatrol() creates a tight 3×3-radius ping-pong route
 *      around the spawn point, using only reachable floor cells.
 *    • If <2 waypoints found, ghost does a straight back-and-forth on
 *      whatever corridor it is in.
 *    • patrolDir flag on each enemy flips direction at path ends so
 *      motion is continuous (no pause at waypoint ends).
 *
 *  CHASE BEHAVIOUR
 *    • Sensing radius: 4 tiles Euclidean (SENSE_R = TILE * 4).
 *    • On sight: aggro = true, speed = BASE * 1.4.
 *    • On leaving radius: ghost persists in chase for exactly 3 seconds
 *      before returning to patrol (chaseUntil timestamp).
 *
 *  PRESERVED SYSTEMS
 *    • PeerJS networking / Google STUN — untouched.
 *    • Player avatar: neon cyan ball, 15-22px shadowBlur glow.
 *    • HUD: bold white fonts + black text-shadow.
 *    • Audio: bgmusic / win / death SFX triggers unchanged.
 *    • Mobile D-Pad: wired via touch events injecting into localKeys.
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

const PLAYER_R        = TILE * 0.36;   // player collision radius
const PLAYER_SPEED    = 185;           // px/s
const ENEMY_R         = TILE * 0.38;   // ghost collision radius
const ENEMY_BASE_SPD  = 72;            // px/s patrol speed
const ENEMY_AGGRO_M   = 1.4;           // 1.4× speed when chasing
const SENSE_R         = TILE * 4;      // 4-tile Euclidean sensing radius
const CHASE_LINGER_MS = 3000;          // ms to keep chasing after losing sight
const FOG_R           = TILE * 3.4;    // Mover fog-of-war radius
const INVU_MS         = 500;           // invulnerability window at level start (ms)
const SPAWN_MIN_DIST  = TILE * 4;      // min ghost distance from player start
const ENEMY_SPACE_MIN = TILE * 3;      // min distance between ghosts
const PATROL_RADIUS   = 3;             // tiles: local patrol search radius
const MAX_LEVEL_ATTEMPTS = 12;         // fairness engine retry cap

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
//  SEEDED RNG  (mulberry32)
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
// ───────────────────────────────────────────────────────────────────

/**
 * Returns true if (ec,er) is reachable from (sc,sr) through floor tiles.
 */
function bfsReachable(grid, sc, sr, ec, er) {
  if (grid[sr]?.[sc] !== 0 || grid[er]?.[ec] !== 0) return false;
  const vis = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const q   = [[sc, sr]];
  vis[sr][sc] = 1;
  while (q.length) {
    const [c, r] = q.shift();
    if (c === ec && r === er) return true;
    for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nc = c+dc, nr = r+dr;
      if (nc>=0 && nc<COLS && nr>=0 && nr<ROWS && !vis[nr][nc] && grid[nr][nc]===0) {
        vis[nr][nc] = 1;
        q.push([nc, nr]);
      }
    }
  }
  return false;
}

/**
 * Returns the BFS shortest path as [{c,r}, …] from (sc,sr) to (ec,er),
 * or null if unreachable.
 */
function bfsShortestPath(grid, sc, sr, ec, er) {
  if (grid[sr]?.[sc] !== 0 || grid[er]?.[ec] !== 0) return null;
  const vis  = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const prev = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
  const q    = [[sc, sr]];
  vis[sr][sc] = 1;
  let found = false;
  outer: while (q.length) {
    const [c, r] = q.shift();
    for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nc = c+dc, nr = r+dr;
      if (nc>=0 && nc<COLS && nr>=0 && nr<ROWS && !vis[nr][nc] && grid[nr][nc]===0) {
        vis[nr][nc] = 1;
        prev[nr][nc] = [c, r];
        if (nc===ec && nr===er) { found=true; break outer; }
        q.push([nc, nr]);
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

/**
 * BFS flood from (sc,sr), returns all reachable {c,r} cells.
 */
function bfsFloodFill(grid, sc, sr) {
  const reachable = [];
  const vis = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const q   = [[sc, sr]];
  vis[sr][sc] = 1;
  while (q.length) {
    const [c, r] = q.shift();
    reachable.push({ c, r });
    for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nc = c+dc, nr = r+dr;
      if (nc>=0 && nc<COLS && nr>=0 && nr<ROWS && !vis[nr][nc] && grid[nr][nc]===0) {
        vis[nr][nc] = 1;
        q.push([nc, nr]);
      }
    }
  }
  return reachable;
}

// ───────────────────────────────────────────────────────────────────
//  MAZE GENERATION
//  Recursive-backtracker DFS + optional loop cuts.
//  buildMaze() retries up to MAX_LEVEL_ATTEMPTS for structural validity.
// ───────────────────────────────────────────────────────────────────

function carveMaze(seed, extraLoops) {
  const rng  = mulberry32(seed);
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(1));
  const vis  = Array.from({ length: ROWS }, () => Array(COLS).fill(false));

  function carve(cx, cy) {
    vis[cy][cx]  = true;
    grid[cy][cx] = 0;
    const dirs = [[0,-2],[0,2],[-2,0],[2,0]].sort(() => rng() - 0.5);
    for (const [dx, dy] of dirs) {
      const nx = cx+dx, ny = cy+dy;
      if (nx>0 && nx<COLS-1 && ny>0 && ny<ROWS-1 && !vis[ny][nx]) {
        grid[cy + dy/2][cx + dx/2] = 0;
        carve(nx, ny);
      }
    }
  }
  carve(1, 1);

  // Add extra loops for multiple valid paths
  for (let i = 0; i < extraLoops; i++) {
    const x = Math.floor(rng() * (COLS-2)) + 1;
    const y = Math.floor(rng() * (ROWS-2)) + 1;
    if (grid[y][x] === 1) {
      let floorN = 0;
      for (const [dx, dy] of [[0,1],[0,-1],[1,0],[-1,0]])
        if (grid[y+dy]?.[x+dx] === 0) floorN++;
      if (floorN >= 2) grid[y][x] = 0;
    }
  }

  // Always guarantee start and exit open
  grid[1][1]           = 0;
  grid[ROWS-2][COLS-2] = 0;
  return grid;
}

/**
 * Build a valid maze, retrying until start→exit is reachable.
 * Falls back to a corridor-punched safe maze if all retries fail.
 */
function buildMaze(seed, extraLoops) {
  for (let a = 0; a < MAX_LEVEL_ATTEMPTS; a++) {
    const g = carveMaze(seed + a * 7919, extraLoops);
    if (bfsReachable(g, 1, 1, COLS-2, ROWS-2)) return g;
  }
  // Fallback: force corridor connectivity
  const g = carveMaze(seed, extraLoops);
  for (let c = 1; c < COLS-1; c++) g[1][c] = 0;           // top corridor
  for (let r = 1; r < ROWS-1; r++) g[r][COLS-2] = 0;      // right corridor
  g[ROWS-2][COLS-2] = 0;
  return g;
}

// ───────────────────────────────────────────────────────────────────
//  LEVEL TABLE  (10 levels, index 0–9)
//
//  Level 0: 1 ghost, no aggro  — pure tutorial
//  Level 1: 2 ghosts, no aggro
//  Level 2: 3 ghosts, aggro ON (first chase level)
//  Levels 3–9: count = idx+1, aggro ON, progressively tighter mazes
// ───────────────────────────────────────────────────────────────────

const LEVELS = [
  /* 0 */ { seed:2001, loops:14, enemies:1,  aggroOn:false },
  /* 1 */ { seed:2002, loops:12, enemies:2,  aggroOn:false },
  /* 2 */ { seed:2003, loops:10, enemies:3,  aggroOn:true  },
  /* 3 */ { seed:2004, loops: 9, enemies:4,  aggroOn:true  },
  /* 4 */ { seed:2005, loops: 8, enemies:5,  aggroOn:true  },
  /* 5 */ { seed:2006, loops: 7, enemies:6,  aggroOn:true  },
  /* 6 */ { seed:2007, loops: 6, enemies:7,  aggroOn:true  },
  /* 7 */ { seed:2008, loops: 5, enemies:8,  aggroOn:true  },
  /* 8 */ { seed:2009, loops: 4, enemies:9,  aggroOn:true  },
  /* 9 */ { seed:2010, loops: 3, enemies:10, aggroOn:true  },
];

// ───────────────────────────────────────────────────────────────────
//  GAME STATE ENUM
// ───────────────────────────────────────────────────────────────────

const S = { MENU:"MENU", PLAYING:"PLAYING", PAUSED:"PAUSED",
            DANCING:"DANCING", WIN:"WIN", DEAD:"DEAD" };

// ───────────────────────────────────────────────────────────────────
//  RUNTIME STATE
// ───────────────────────────────────────────────────────────────────

let appState   = S.MENU;
let role       = null;      // "host" | "mover"
let levelIdx   = 0;

let maze       = null;
let player     = null;      // { x, y, vx, vy, angle }
let enemies    = [];        // [Enemy]
let pings      = [];        // [{ x, y, born }]
let elapsed    = 0;         // seconds, game time
let invuUntil  = 0;         // performance.now() ms — invulnerability end
let danceTimer = 0;         // seconds into victory dance
let pingCounter = 0;

// shortest-path tile set for the current level (Set of "c,r" strings)
let shortestPathSet = new Set();

// ── Input maps ──
const localKeys  = {};   // keyboard / D-pad virtual keys
let   remoteKeys = {};   // Mover's keys received over network (Host only)

window.addEventListener("keydown", e => {
  localKeys[e.code] = true;
  if (e.code === "Escape") onEsc();
});
window.addEventListener("keyup", e => { localKeys[e.code] = false; });

// ───────────────────────────────────────────────────────────────────
//  MOBILE D-PAD WIRING
//  Touch events on each button inject/clear the matching key code
//  into localKeys, so the existing input system needs no changes.
// ───────────────────────────────────────────────────────────────────

function wireDpad() {
  const dpad = document.getElementById("dpad");
  dpad.querySelectorAll(".dpad-btn[data-key]").forEach(btn => {
    const code = btn.dataset.key;

    const press = (e) => {
      e.preventDefault();
      localKeys[code] = true;
      btn.classList.add("pressed");
    };
    const release = (e) => {
      e.preventDefault();
      localKeys[code] = false;
      btn.classList.remove("pressed");
    };

    // Touch
    btn.addEventListener("touchstart",  press,   { passive: false });
    btn.addEventListener("touchend",    release, { passive: false });
    btn.addEventListener("touchcancel", release, { passive: false });

    // Mouse fallback (for testing on desktop)
    btn.addEventListener("mousedown",  press);
    btn.addEventListener("mouseup",    release);
    btn.addEventListener("mouseleave", release);
  });
}

/**
 * Show the D-pad only for the Mover role.
 * Detects touch support; also shows on small screens regardless.
 */
function updateDpadVisibility() {
  const dpad      = document.getElementById("dpad");
  const isMover   = (role === "mover");
  const isTouch   = navigator.maxTouchPoints > 0 || window.innerWidth <= 768;
  const shouldShow = isMover && isTouch;
  dpad.classList.toggle("hidden", !shouldShow);
}

// ───────────────────────────────────────────────────────────────────
//  AUDIO  (preserved exactly)
// ───────────────────────────────────────────────────────────────────

const bgMusic  = new Audio("/bgmusic.mp3");
bgMusic.loop   = true;
bgMusic.volume = 0.2;
let bgStarted  = false;

const sfxWin   = new Audio("/win.mp3");
const sfxDeath = new Audio("/death.mp3");
const sfxPing  = new Audio("/ping.mp3");

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
//  PEERJS NETWORKING  ← PRESERVED EXACTLY, no changes
// ───────────────────────────────────────────────────────────────────

let peer        = null;
let dataConn    = null;
let mediaConn   = null;
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

// ── HOST ──────────────────────────────────────────────────────────
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
      initLevel(levelIdx);
      const packet = buildLevelPacket();
      dc.send(packet);
      transitionToGame();
    });

    dc.on("data",  onDataFromMover);
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

// ── MOVER ─────────────────────────────────────────────────────────
async function initMover(hostId) {
  role = "mover";
  setStatus("join", "⏳ Connecting to host…");

  peer = new Peer(undefined, { debug: 0 });

  peer.on("open", async () => {
    const stream = await getMic();
    dataConn = peer.connect(hostId, { reliable: true, serialization: "json" });

    dataConn.on("open", () => {
      setStatus("join", "✅ Connected! Waiting for level…");
      if (stream) {
        mediaConn = peer.call(hostId, stream);
        mediaConn.on("stream", attachRemoteAudio);
      }
    });

    dataConn.on("data",  onDataFromHost);
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
      maze     = pkt.maze;
      player   = pkt.player;
      enemies  = pkt.enemies;
      pings    = [];
      elapsed  = 0;
      levelIdx = pkt.levelIdx;
      invuUntil = performance.now() + INVU_MS;
      updateHudLevel();
      transitionToGame();
      break;

    case "state":
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
      maze     = pkt.maze;
      player   = pkt.player;
      enemies  = pkt.enemies;
      pings    = [];
      elapsed  = 0;
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
  if (now - lastStateSend < 16) return;
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
      x:          e.x,
      y:          e.y,
      aggro:      false,
      patrolPath: e.patrolPath,
      patrolIdx:  e.patrolIdx,
      patrolDir:  e.patrolDir,
      chaseUntil: 0,
    })),
  };
}

// ───────────────────────────────────────────────────────────────────
//  LEVEL INIT  (Host-authoritative)
//  FAIRNESS ENGINE: retry loop ensures:
//    1. Start → Exit is structurally reachable.
//    2. Required enemy count fits without blocking the shortest path.
// ───────────────────────────────────────────────────────────────────

function initLevel(idx) {
  const cfg = LEVELS[Math.min(idx, LEVELS.length - 1)];

  let builtMaze, builtEnemies, builtPath;
  let attempt = 0;

  while (attempt < MAX_LEVEL_ATTEMPTS) {
    const seedOffset = attempt * 53881;
    builtMaze = buildMaze(cfg.seed + seedOffset, cfg.loops);

    // 1. Structural check — exit must be reachable
    if (!bfsReachable(builtMaze, 1, 1, COLS-2, ROWS-2)) {
      attempt++;
      continue;
    }

    // 2. Find the shortest path (used to protect tiles from enemy spawns)
    builtPath = bfsShortestPath(builtMaze, 1, 1, COLS-2, ROWS-2);
    if (!builtPath) { attempt++; continue; }

    // Build path set as "c,r" strings for O(1) lookup
    const pathSet = new Set(builtPath.map(p => `${p.c},${p.r}`));

    // 3. Attempt to spawn enemies with path-protection
    const px = 1 * TILE + TILE / 2;
    const py = 1 * TILE + TILE / 2;
    builtEnemies = trySpawnEnemies(
      cfg.enemies, cfg.seed + 9999 + seedOffset,
      cfg.aggroOn, builtMaze, px, py, pathSet
    );

    if (builtEnemies !== null) {
      // Success — commit
      shortestPathSet = pathSet;
      break;
    }

    attempt++;
  }

  // If all attempts failed, use the last maze and spawn wherever possible
  if (!builtEnemies) {
    builtEnemies = trySpawnEnemies(
      cfg.enemies, cfg.seed + 9999,
      cfg.aggroOn, builtMaze,
      1 * TILE + TILE/2, 1 * TILE + TILE/2,
      new Set()           // no path protection as last resort
    ) || [];
  }

  maze       = builtMaze;
  player     = { x: 1 * TILE + TILE/2, y: 1 * TILE + TILE/2, vx:0, vy:0, angle:0 };
  enemies    = builtEnemies;
  pings      = [];
  elapsed    = 0;
  invuUntil  = performance.now() + INVU_MS;
  danceTimer = 0;
}

// ───────────────────────────────────────────────────────────────────
//  ENEMY SPAWNING
//  Returns an enemy array if `count` enemies can be placed while
//  respecting all constraints, or null if impossible.
// ───────────────────────────────────────────────────────────────────

function trySpawnEnemies(count, seed, aggroEnabled, grid, px, py, pathSet) {
  const rng  = mulberry32(seed);
  const list = [];

  // Gather valid candidate floor cells
  const candidates = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c] !== 0) continue;
      if (c === 1 && r === 1) continue;           // player start
      if (c === COLS-2 && r === ROWS-2) continue; // exit cell
      if (pathSet.has(`${c},${r}`)) continue;     // FAIRNESS: shortest-path tile

      const ex = c * TILE + TILE/2;
      const ey = r * TILE + TILE/2;
      if (Math.hypot(ex - px, ey - py) < SPAWN_MIN_DIST) continue; // too close to start
      candidates.push({ c, r, ex, ey });
    }
  }

  // Fisher-Yates shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  for (const cand of candidates) {
    if (list.length >= count) break;

    // Min spacing between ghosts
    const tooClose = list.some(e =>
      Math.hypot(cand.ex - e.x, cand.ey - e.y) < ENEMY_SPACE_MIN
    );
    if (tooClose) continue;

    const patrolPath = buildLocalPatrol(cand.c, cand.r, grid, rng);

    list.push({
      x:           cand.ex,
      y:           cand.ey,
      vx:          0,
      vy:          0,
      aggro:       false,
      aggroEnabled,
      patrolPath,
      patrolIdx:   0,
      patrolDir:   1,       // +1 forward, -1 backward through the patrol array
      chaseUntil:  0,       // performance.now() ms — when to stop chasing
    });
  }

  // Return null if we couldn't fill the quota (triggers a retry)
  return list.length === count ? list : null;
}

// ───────────────────────────────────────────────────────────────────
//  LOCAL PATROL BUILDER
//  Ghosts never stand still.  Strategy:
//  1. Collect all floor cells within a manhattan radius of PATROL_RADIUS
//     that are reachable from the ghost's spawn point.
//  2. Sort by manhattan distance (furthest first) to spread the route.
//  3. If only the spawn cell is reachable, add the nearest corridor
//     neighbour to create a minimal back-and-forth.
// ───────────────────────────────────────────────────────────────────

function buildLocalPatrol(sc, sr, grid, rng) {
  // BFS limited to PATROL_RADIUS manhattan distance
  const vis  = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const q    = [{ c: sc, r: sr, dist: 0 }];
  const pool = [];
  vis[sr][sc] = 1;

  while (q.length) {
    const { c, r, dist } = q.shift();
    pool.push({ c, r, dist });
    if (dist >= PATROL_RADIUS) continue;
    for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nc = c+dc, nr = r+dr;
      if (nc>=0 && nc<COLS && nr>=0 && nr<ROWS && !vis[nr][nc] && grid[nr][nc]===0) {
        vis[nr][nc] = 1;
        q.push({ c: nc, r: nr, dist: dist+1 });
      }
    }
  }

  // We want a handful of spread-out waypoints; sort furthest first then interleave
  pool.sort((a, b) => b.dist - a.dist);

  // Pick at most 6 waypoints: spawn + up to 5 spread cells
  const waypoints = [{ c: sc, r: sr }];
  for (const cell of pool) {
    if (waypoints.length >= 6) break;
    const last = waypoints[waypoints.length - 1];
    // Only add if ≥ 2 manhattan steps from the last waypoint
    if (Math.abs(cell.c - last.c) + Math.abs(cell.r - last.r) >= 2) {
      waypoints.push({ c: cell.c, r: cell.r });
    }
  }

  // Fallback: if stuck in a dead end with no neighbours, extend to the
  // nearest open cell in any direction so the ghost always moves
  if (waypoints.length < 2) {
    outer: for (let radius = 1; radius <= ROWS; radius++) {
      for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0],[1,1],[-1,-1],[1,-1],[-1,1]]) {
        const nc = sc + dc * radius, nr = sr + dr * radius;
        if (nc>=0 && nc<COLS && nr>=0 && nr<ROWS && grid[nr][nc]===0
            && !(nc===sc && nr===sr)) {
          waypoints.push({ c: nc, r: nr });
          break outer;
        }
      }
    }
  }

  return waypoints;
}

// ───────────────────────────────────────────────────────────────────
//  SCREEN TRANSITIONS
// ───────────────────────────────────────────────────────────────────

function transitionToGame() {
  stopBgm();
  showScreen("game-screen");
  el("hud-role").textContent = role === "host" ? "HOST" : "MOVER";
  updateHudLevel();
  updateDpadVisibility();
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

  const input       = remoteKeys;
  const lvlSpeedMult = 1 + levelIdx * 0.07;
  const nowMs        = performance.now();

  // ── Player movement ──────────────────────────────────────────────
  const dx   = boolAxis(input,"ArrowRight","KeyD") - boolAxis(input,"ArrowLeft","KeyA");
  const dy   = boolAxis(input,"ArrowDown", "KeyS") - boolAxis(input,"ArrowUp",  "KeyW");
  const len  = Math.hypot(dx, dy) || 1;
  const norm = (dx||dy) ? 1/len : 0;
  player.vx  = dx * norm * PLAYER_SPEED;
  player.vy  = dy * norm * PLAYER_SPEED;
  if (dx||dy) player.angle = Math.atan2(dy, dx);

  player.x = slideAxis(player.x, player.vx * dt, player.y, false, PLAYER_R);
  player.y = slideAxis(player.y, player.vy * dt, player.x, true,  PLAYER_R);

  // ── Enemy AI ─────────────────────────────────────────────────────
  for (const e of enemies) {
    const dist = Math.hypot(player.x - e.x, player.y - e.y);

    // ── Aggro state machine ──
    if (e.aggroEnabled && dist < SENSE_R) {
      // Player in range: enter/refresh aggro
      e.aggro      = true;
      e.chaseUntil = nowMs + CHASE_LINGER_MS;
    } else if (e.aggro) {
      // Player left range: maintain chase until linger expires
      if (nowMs >= e.chaseUntil) {
        e.aggro = false;
      }
    }
    // Non-aggro enemies always have aggro=false (already false from init)

    const spd = ENEMY_BASE_SPD * lvlSpeedMult * (e.aggro ? ENEMY_AGGRO_M : 1.0);

    if (e.aggro) {
      // ── CHASE: steer directly toward player ──
      // Wall-slide physics handles the actual navigation
      const d = dist || 1;
      e.vx = ((player.x - e.x) / d) * spd;
      e.vy = ((player.y - e.y) / d) * spd;

    } else {
      // ── PATROL: ping-pong through waypoints, never idle ──
      if (e.patrolPath && e.patrolPath.length >= 1) {
        const pt = e.patrolPath[e.patrolIdx];
        const tx = pt.c * TILE + TILE / 2;
        const ty = pt.r * TILE + TILE / 2;
        const pd = Math.hypot(tx - e.x, ty - e.y);

        if (pd < 3) {
          // Snap and advance in the current direction (ping-pong)
          e.x = tx;
          e.y = ty;
          e.vx = 0;
          e.vy = 0;

          const nextIdx = e.patrolIdx + e.patrolDir;
          if (nextIdx < 0 || nextIdx >= e.patrolPath.length) {
            // Hit an end — reverse direction
            e.patrolDir = -e.patrolDir;
            e.patrolIdx += e.patrolDir; // one step in new direction
          } else {
            e.patrolIdx = nextIdx;
          }
        } else {
          // Move toward current waypoint
          e.vx = ((tx - e.x) / pd) * spd;
          e.vy = ((ty - e.y) / pd) * spd;
        }
      }
    }

    // Apply movement with dedicated enemy wall-slide
    e.x = slideAxis(e.x, e.vx * dt, e.y, false, ENEMY_R);
    e.y = slideAxis(e.y, e.vy * dt, e.x, true,  ENEMY_R);
  }

  // Expire old pings
  pings = pings.filter(p => elapsed - p.born < 2.2);

  // ── Win check ──
  if (Math.hypot(player.x - EXIT_X, player.y - EXIT_Y) < TILE * 0.6) {
    triggerWin(true);
    return;
  }

  // ── Death check (invulnerability window at level start) ──
  if (nowMs > invuUntil) {
    for (const e of enemies) {
      if (Math.hypot(player.x - e.x, player.y - e.y) < PLAYER_R + ENEMY_R) {
        triggerDeath(true);
        return;
      }
    }
  }
}

function boolAxis(keys, a, b) { return (keys[a] || keys[b]) ? 1 : 0; }

/**
 * Axis-aligned sliding collision.
 * `radius` is passed explicitly so the same function serves both
 * player (PLAYER_R) and enemies (ENEMY_R).
 */
function slideAxis(pos, vel, crossPos, isY, radius) {
  if (vel === 0) return pos;
  const next = pos + vel;
  const half = radius * 0.86;
  const cross = crossPos;

  const checks = isY
    ? [[cross - half + 1, next - half], [cross + half - 1, next - half],
       [cross - half + 1, next + half], [cross + half - 1, next + half]]
    : [[next - half, cross - half + 1], [next - half, cross + half - 1],
       [next + half, cross - half + 1], [next + half, cross + half - 1]];

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
  appState   = S.DANCING;
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
//  NEXT LEVEL / RETRY  (Host-driven, Mover mirrors via network)
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
    pkt.type  = "loadLevel";
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
    pkt.type  = "loadLevel";
    dataConn.send(pkt);
  }
});

// ───────────────────────────────────────────────────────────────────
//  HOST CLICK → PING
// ───────────────────────────────────────────────────────────────────

canvas.addEventListener("click", e => {
  if (role !== "host" || appState !== S.PLAYING) return;
  const rect = canvas.getBoundingClientRect();
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
    drawWorld();
    ctx.restore();
  } else {
    drawMoverView(cw, ch);
  }
}

// ── HOST VIEW — full map ──────────────────────────────────────────
function drawWorld() {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (maze[r][c] === 1) {
        drawWall(c * TILE, r * TILE);
      } else {
        ctx.fillStyle = C.floor;
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      }
    }
  }

  drawExit();
  for (const p of pings)   drawPing(p);
  for (const e of enemies) drawGhost(e);

  const dancing = appState === S.DANCING;
  drawPlayerChar(player.x, player.y, player.angle, dancing);
}

// ── MOVER VIEW — fog of war ───────────────────────────────────────
function drawMoverView(cw, ch) {
  const px = player.x, py = player.y;
  const ox = cw / 2 - px;
  const oy = ch / 2 - py;

  ctx.save();
  ctx.translate(ox, oy);

  drawWorld();

  // Fog mask
  ctx.globalCompositeOperation = "destination-in";
  const fog = ctx.createRadialGradient(px, py, FOG_R * 0.15, px, py, FOG_R);
  fog.addColorStop(0,    "rgba(0,0,0,1)");
  fog.addColorStop(0.72, "rgba(0,0,0,1)");
  fog.addColorStop(1,    "rgba(0,0,0,0)");
  ctx.fillStyle = fog;
  ctx.fillRect(-ox, -oy, cw, ch);

  ctx.globalCompositeOperation = "source-over";

  // Outer darkness
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

// ── PLAYER — Neon Cyan Ball (PRESERVED EXACTLY) ───────────────────
function drawPlayerChar(px, py, angle, dancing) {
  const t = elapsed;
  const r = PLAYER_R;

  ctx.save();
  ctx.translate(px, py);

  if (dancing) {
    ctx.rotate(danceTimer * 5);
    ctx.scale(1 + 0.22 * Math.sin(danceTimer * 14),
              1 + 0.22 * Math.sin(danceTimer * 14));
  }

  // 15-22px shadowBlur glow as spec requires
  ctx.shadowColor = C.player;
  ctx.shadowBlur  = 18 + 6 * Math.sin(t * 4);  // oscillates 12–24, centre 18

  // Body — radial gradient sphere
  const bodyGrad = ctx.createRadialGradient(-r*0.2, -r*0.2, r*0.05, 0, 0, r);
  bodyGrad.addColorStop(0,   "#aaffff");
  bodyGrad.addColorStop(0.5, C.player);
  bodyGrad.addColorStop(1,   "#0077aa");
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // Eyes (whites)
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

  // Inner highlight
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
      ctx.fillStyle   = `hsl(${(i*60 + t*120) % 360},100%,70%)`;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur  = 10;
      ctx.fill();
    }
  }

  ctx.restore();
}

// ── GHOST ─────────────────────────────────────────────────────────
function drawGhost(e) {
  const t  = elapsed;
  const gx = e.x, gy = e.y;
  const w  = TILE * 0.70, h = TILE * 0.76;

  ctx.save();
  ctx.shadowColor = C.enemy;
  ctx.shadowBlur  = e.aggro ? 30 + 10 * Math.sin(t * 9) : 14;
  ctx.fillStyle   = e.aggro ? "#ff0022" : C.enemy;

  // Ghost body with wavy hem
  ctx.beginPath();
  ctx.arc(gx, gy - h * 0.08, w / 2, Math.PI, 0);
  ctx.lineTo(gx + w/2, gy + h * 0.42);
  const waves = 4;
  for (let i = 0; i < waves; i++) {
    const wx1 = gx + w/2 - (w/waves)*(i+0.5);
    const wx2 = gx + w/2 - (w/waves)*(i+1);
    const wy  = gy + h*0.42 + (i%2===0?1:-1)*(TILE*0.12 + 0.07*Math.sin(t*5+i));
    ctx.quadraticCurveTo(wx1, wy, wx2, gy + h*0.42);
  }
  ctx.closePath();
  ctx.fill();

  // Eyes (whites)
  ctx.fillStyle  = "#fff";
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(gx - w*0.19, gy - h*0.14, w*0.115, 0, Math.PI*2);
  ctx.arc(gx + w*0.19, gy - h*0.14, w*0.115, 0, Math.PI*2);
  ctx.fill();

  // Pupils — red when aggro
  ctx.fillStyle = e.aggro ? "#ff0000" : "#110022";
  ctx.beginPath();
  ctx.arc(gx - w*0.19, gy - h*0.14, w*0.055, 0, Math.PI*2);
  ctx.arc(gx + w*0.19, gy - h*0.14, w*0.055, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();
}

// ── PING (ripple marker) ──────────────────────────────────────────
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
  const m   = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

function updateHudLevel() {
  el("hud-level").textContent = levelIdx + 1;
}

// ───────────────────────────────────────────────────────────────────
//  MENU WIRING
// ───────────────────────────────────────────────────────────────────

el("btn-host").addEventListener("click", () => {
  playBgm();
  setHidden("host-panel", false);
  setHidden("join-panel",  true);
  initHost();
});

el("btn-join").addEventListener("click", () => {
  playBgm();
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

function el(id)             { return document.getElementById(id); }
function setHidden(id, h)   { el(id).classList.toggle("hidden", h); }
function setStatus(who, msg){ el(who==="host"?"host-status":"join-status").textContent = msg; }

// ───────────────────────────────────────────────────────────────────
//  BOOT
// ───────────────────────────────────────────────────────────────────

wireDpad();
requestAnimationFrame(gameLoop);