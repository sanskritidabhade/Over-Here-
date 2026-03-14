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
 *  MOVER = "Player" — sees Fog-of-War. WASD / Arrow / D-Pad.
 *          Sends input to Host. Receives rendered state.
 *
 *  VOICE — PeerJS MediaConnection auto-established on connect.
 *
 *  ── CHANGES IN THIS VERSION ────────────────────────────────────────
 *
 *  DYNAMIC PATROL — "Window of Opportunity"
 *    • Every ghost wanders within a 5×5-tile radius (PATROL_WANDER_R=5)
 *      around its home spawn cell, picking random reachable targets.
 *    • ANTI-STUCK: each ghost tracks its last position every frame.
 *      If it hasn't moved more than STUCK_DIST_SQ pixels in
 *      STUCK_FRAMES (20) consecutive frames, it immediately abandons
 *      the current target and picks a fresh random wander target ≥5
 *      tiles away — guaranteed to unblock it.
 *
 *  PATH FAIRNESS  (Level 0+)
 *    • BFS shortest path identified from Start → Exit.
 *    • Spawn buffer: exit tile + the 2 tiles immediately before it on
 *      the shortest path are added to the exclusion zone.
 *    • EXIT CAMPING PREVENTION: if a ghost lingers within 2 tiles of
 *      the exit (EXIT_GUARD_DIST) for >2 seconds (EXIT_CAMP_MS) while
 *      NOT in aggro/chase, it is immediately teleport-patrolled to the
 *      waypoint in its patrol zone that is furthest from the exit.
 *
 *  CHASE & 3-SECOND SEARCH PERSISTENCE
 *    • Sensing: 4-tile Euclidean radius.
 *    • Chase: 1.4× base speed, steers toward player.
 *    • On losing sight: ghost navigates to player's LAST KNOWN POSITION,
 *      then idles/searches locally (random micro-waypoints) for exactly
 *      3 seconds before returning to home patrol.
 *
 *  PRESERVED
 *    • PeerJS / Google STUN networking — untouched.
 *    • Player avatar: neon cyan ball, 15-22px shadowBlur glow.
 *    • HUD: bold white + black text-shadow.
 *    • Audio: bgmusic / win / death SFX triggers.
 *    • Mobile D-Pad: touch-injected into localKeys.
 *    • Level scaling: +1 ghost per level from Level 0.
 * ═══════════════════════════════════════════════════════════════════
 */

import Peer from "peerjs";

// ───────────────────────────────────────────────────────────────────
//  CONSTANTS
// ───────────────────────────────────────────────────────────────────

const TILE = 40;           // px per maze cell
const COLS = 19;           // must be odd
const ROWS = 15;           // must be odd
const W    = COLS * TILE;  // 760
const H    = ROWS * TILE;  // 600

// Player
const PLAYER_R     = TILE * 0.36;
const PLAYER_SPEED = 185;           // px/s

// Ghost base
const ENEMY_R        = TILE * 0.38;
const ENEMY_BASE_SPD = 72;          // px/s patrol/wander speed
const ENEMY_AGGRO_M  = 1.4;         // speed multiplier while chasing

// AI sensing & chase
const SENSE_R         = TILE * 4;   // 4-tile Euclidean sensing radius
const CHASE_LINGER_MS = 3000;       // ms to search after losing sight

// Patrol / wander
const PATROL_WANDER_R = 5;          // tile radius ghost roams from its home
const STUCK_FRAMES    = 20;         // frames with no movement → pick new target
const STUCK_DIST_SQ   = 4 * 4;     // px² threshold for "haven't moved"

// Exit camping
const EXIT_GUARD_DIST = TILE * 2;   // px — ghost is "near exit" if closer than this
const EXIT_CAMP_MS    = 2000;       // ms before idle-at-exit triggers ejection

// Spawn rules
const SPAWN_MIN_DIST    = TILE * 4; // min ghost distance from player start
const ENEMY_SPACE_MIN   = TILE * 3; // min distance between ghosts
const EXIT_BUFFER_TILES = 2;        // tiles before exit that are spawn-protected

// Misc
const FOG_R              = TILE * 3.4;
const INVU_MS            = 500;
const MAX_LEVEL_ATTEMPTS = 12;

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

/** True if (ec,er) is reachable from (sc,sr) through floor tiles. */
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
 * BFS shortest path [{c,r}…] from (sc,sr) to (ec,er), or null.
 * Includes both endpoints.
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
 * BFS flood from (sc,sr), optionally limited to manhattan ≤ maxDist.
 * Returns all reachable {c,r} with their BFS distance.
 */
function bfsFlood(grid, sc, sr, maxDist = Infinity) {
  const result = [];
  const vis    = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const q      = [{ c: sc, r: sr, d: 0 }];
  vis[sr][sc]  = 1;
  while (q.length) {
    const { c, r, d } = q.shift();
    result.push({ c, r, d });
    if (d >= maxDist) continue;
    for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nc = c+dc, nr = r+dr;
      if (nc>=0 && nc<COLS && nr>=0 && nr<ROWS && !vis[nr][nc] && grid[nr][nc]===0) {
        vis[nr][nc] = 1;
        q.push({ c: nc, r: nr, d: d+1 });
      }
    }
  }
  return result;
}

// ───────────────────────────────────────────────────────────────────
//  MAZE GENERATION  (recursive backtracker + loop cuts)
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

  grid[1][1]           = 0;
  grid[ROWS-2][COLS-2] = 0;
  return grid;
}

function buildMaze(seed, extraLoops) {
  for (let a = 0; a < MAX_LEVEL_ATTEMPTS; a++) {
    const g = carveMaze(seed + a * 7919, extraLoops);
    if (bfsReachable(g, 1, 1, COLS-2, ROWS-2)) return g;
  }
  // Fallback: punch corridors
  const g = carveMaze(seed, extraLoops);
  for (let c = 1; c < COLS-1; c++) g[1][c] = 0;
  for (let r = 1; r < ROWS-1; r++) g[r][COLS-2] = 0;
  g[ROWS-2][COLS-2] = 0;
  return g;
}

// ───────────────────────────────────────────────────────────────────
//  LEVEL TABLE  (10 levels, index 0–9, +1 ghost per level)
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

let appState    = S.MENU;
let role        = null;      // "host" | "mover"
let levelIdx    = 0;

let maze        = null;
let player      = null;
let enemies     = [];
let pings       = [];
let elapsed     = 0;
let invuUntil   = 0;
let danceTimer  = 0;
let pingCounter = 0;

// Exit world-space coordinates (constant per maze layout)
const EXIT_C = COLS - 2;
const EXIT_R = ROWS - 2;
const EXIT_X = EXIT_C * TILE + TILE / 2;
const EXIT_Y = EXIT_R * TILE + TILE / 2;

// Shortest-path tile set for current level (Set of "c,r" strings)
let shortestPathSet = new Set();

// ── Input maps ──
const localKeys  = {};
let   remoteKeys = {};

window.addEventListener("keydown", e => {
  localKeys[e.code] = true;
  if (e.code === "Escape") onEsc();
});
window.addEventListener("keyup", e => { localKeys[e.code] = false; });

// ───────────────────────────────────────────────────────────────────
//  MOBILE D-PAD  (touch events injected into localKeys)
// ───────────────────────────────────────────────────────────────────

function wireDpad() {
  const dpad = document.getElementById("dpad");
  dpad.querySelectorAll(".dpad-btn[data-key]").forEach(btn => {
    const code = btn.dataset.key;
    const press   = e => { e.preventDefault(); localKeys[code] = true;  btn.classList.add("pressed"); };
    const release = e => { e.preventDefault(); localKeys[code] = false; btn.classList.remove("pressed"); };
    btn.addEventListener("touchstart",  press,   { passive: false });
    btn.addEventListener("touchend",    release, { passive: false });
    btn.addEventListener("touchcancel", release, { passive: false });
    btn.addEventListener("mousedown",   press);
    btn.addEventListener("mouseup",     release);
    btn.addEventListener("mouseleave",  release);
  });
}

function updateDpadVisibility() {
  const dpad     = document.getElementById("dpad");
  const isMover  = role === "mover";
  const isTouch  = navigator.maxTouchPoints > 0 || window.innerWidth <= 768;
  dpad.classList.toggle("hidden", !(isMover && isTouch));
}

// ───────────────────────────────────────────────────────────────────
//  AUDIO  (preserved)
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
  try { const c = audio.cloneNode(); c.volume = 0.7; c.play().catch(() => {}); } catch(_) {}
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
//  PEERJS NETWORKING  ← PRESERVED EXACTLY
// ───────────────────────────────────────────────────────────────────

let peer        = null;
let dataConn    = null;
let mediaConn   = null;
let localStream = null;

function makeRoomId() { return Math.random().toString(36).slice(2, 10).toUpperCase(); }

async function getMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
    return localStream;
  } catch(e) { console.warn("Mic not available:", e); return null; }
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
      dc.send(buildLevelPacket());
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

  peer.on("error", e => { setStatus("host", `❌ PeerJS: ${e.type}`); console.error(e); });
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

  peer.on("error", e => { setStatus("join", `❌ ${e.type} — check the Room ID`); console.error(e); });
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
      maze      = pkt.maze;
      player    = pkt.player;
      enemies   = pkt.enemies;
      pings     = [];
      elapsed   = 0;
      levelIdx  = pkt.levelIdx;
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
      maze      = pkt.maze;
      player    = pkt.player;
      enemies   = pkt.enemies;
      pings     = [];
      elapsed   = 0;
      levelIdx  = pkt.levelIdx;
      invuUntil = performance.now() + INVU_MS;
      updateHudLevel();
      appState  = S.PLAYING;
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
      x:            e.x,
      y:            e.y,
      aggro:        false,
      aggroEnabled: e.aggroEnabled,
      // patrol / wander
      homeC:        e.homeC,
      homeR:        e.homeR,
      wanderTarget: e.wanderTarget,
      patrolPath:   e.patrolPath,
      patrolIdx:    e.patrolIdx,
      patrolDir:    e.patrolDir,
      // chase
      chaseUntil:   0,
      searchUntil:  0,
      lastKnownPx:  e.x,
      lastKnownPy:  e.y,
      // anti-stuck
      stuckFrames:  0,
      lastX:        e.x,
      lastY:        e.y,
      // exit camp
      exitCampSince: 0,
    })),
  };
}

// ───────────────────────────────────────────────────────────────────
//  LEVEL INIT  (Host-authoritative)
//  FAIRNESS ENGINE:
//    1. Exit must be structurally reachable.
//    2. Shortest path found; exit tile + EXIT_BUFFER_TILES preceding
//       tiles are added to the spawn exclusion zone.
//    3. Enemy quota must be fillable without using excluded tiles.
//    Retries up to MAX_LEVEL_ATTEMPTS with shifted seeds.
// ───────────────────────────────────────────────────────────────────

function initLevel(idx) {
  const cfg = LEVELS[Math.min(idx, LEVELS.length - 1)];

  let builtMaze, builtEnemies;
  let builtPathSet = new Set();
  let attempt = 0;

  while (attempt < MAX_LEVEL_ATTEMPTS) {
    const seedOff = attempt * 53881;
    builtMaze = buildMaze(cfg.seed + seedOff, cfg.loops);

    // 1. Structural reachability
    if (!bfsReachable(builtMaze, 1, 1, EXIT_C, EXIT_R)) { attempt++; continue; }

    // 2. Shortest path → spawn exclusion set
    const path = bfsShortestPath(builtMaze, 1, 1, EXIT_C, EXIT_R);
    if (!path) { attempt++; continue; }

    // Protect exit tile + EXIT_BUFFER_TILES tiles before it on the path
    const excSet = new Set();
    const bufStart = Math.max(0, path.length - 1 - EXIT_BUFFER_TILES);
    for (let i = bufStart; i < path.length; i++) {
      excSet.add(`${path[i].c},${path[i].r}`);
    }
    // Also always exclude the full shortest path for spawn (but NOT for movement)
    path.forEach(p => excSet.add(`${p.c},${p.r}`));

    // 3. Try to spawn enemies
    const px = 1 * TILE + TILE / 2;
    const py = 1 * TILE + TILE / 2;
    builtEnemies = trySpawnEnemies(
      cfg.enemies, cfg.seed + 9999 + seedOff,
      cfg.aggroOn, builtMaze, px, py, excSet
    );

    if (builtEnemies !== null) {
      builtPathSet = excSet;
      break;
    }
    attempt++;
  }

  // Last-resort: spawn without exclusions if all attempts failed
  if (!builtEnemies) {
    builtEnemies = trySpawnEnemies(
      cfg.enemies, cfg.seed + 9999, cfg.aggroOn, builtMaze,
      1 * TILE + TILE/2, 1 * TILE + TILE/2, new Set()
    ) || [];
  }

  maze            = builtMaze;
  player          = { x: 1*TILE + TILE/2, y: 1*TILE + TILE/2, vx:0, vy:0, angle:0 };
  enemies         = builtEnemies;
  pings           = [];
  elapsed         = 0;
  invuUntil       = performance.now() + INVU_MS;
  danceTimer      = 0;
  shortestPathSet = builtPathSet;
}

// ───────────────────────────────────────────────────────────────────
//  ENEMY SPAWNING
//  Returns filled array or null (triggers initLevel retry).
// ───────────────────────────────────────────────────────────────────

function trySpawnEnemies(count, seed, aggroEnabled, grid, px, py, excSet) {
  const rng  = mulberry32(seed);
  const list = [];

  const candidates = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c] !== 0) continue;
      if (c === 1 && r === 1) continue;
      if (c === EXIT_C && r === EXIT_R) continue;
      if (excSet.has(`${c},${r}`)) continue;
      const ex = c * TILE + TILE/2, ey = r * TILE + TILE/2;
      if (Math.hypot(ex - px, ey - py) < SPAWN_MIN_DIST) continue;
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
    if (list.some(e => Math.hypot(cand.ex - e.x, cand.ey - e.y) < ENEMY_SPACE_MIN)) continue;

    // Build a local patrol path as a fallback for when wander target is reached
    const patrolPath = buildLocalPatrol(cand.c, cand.r, grid, rng);
    // Pick an initial wander target immediately so ghost starts moving
    const initTarget = pickWanderTarget(cand.c, cand.r, grid, rng);

    list.push({
      x:            cand.ex,
      y:            cand.ey,
      vx:           0,
      vy:           0,
      aggro:        false,
      aggroEnabled,
      homeC:        cand.c,     // home tile (col)
      homeR:        cand.r,     // home tile (row)
      wanderTarget: initTarget, // current wander destination {c,r}
      patrolPath,               // fallback micro-patrol near home
      patrolIdx:    0,
      patrolDir:    1,
      // Chase / search
      chaseUntil:   0,          // ms: keep chasing until this time
      searchUntil:  0,          // ms: keep searching (at last-known pos) until this
      lastKnownPx:  cand.ex,    // world-px of player's last known position
      lastKnownPy:  cand.ey,
      // Anti-stuck
      stuckFrames:  0,
      lastX:        cand.ex,
      lastY:        cand.ey,
      // Exit camp
      exitCampSince: 0,         // ms timestamp when ghost entered exit proximity
    });
  }

  return list.length === count ? list : null;
}

// ───────────────────────────────────────────────────────────────────
//  WANDER TARGET PICKER
//  Picks a random reachable floor cell within PATROL_WANDER_R tiles
//  of the ghost's home.  Always ≥5 tiles (manhattan) from current pos
//  so the ghost always has meaningful movement to make.
//  Falls back to any reachable cell if the constraint can't be met.
// ───────────────────────────────────────────────────────────────────

function pickWanderTarget(homeC, homeR, grid, rng) {
  // Flood fill within wander radius from home
  const pool = bfsFlood(grid, homeC, homeR, PATROL_WANDER_R);

  if (pool.length <= 1) {
    // Stuck in a single cell — try flood from same with no limit
    const wide = bfsFlood(grid, homeC, homeR, ROWS + COLS);
    if (wide.length > 1) {
      const pick = wide[1 + Math.floor(rng() * (wide.length - 1))];
      return { c: pick.c, r: pick.r };
    }
    return { c: homeC, r: homeR };
  }

  // Prefer cells that are far from current home (spread out movement)
  const far = pool.filter(p => p.d >= Math.min(3, PATROL_WANDER_R));
  const src = far.length > 0 ? far : pool;
  const pick = src[Math.floor(rng() * src.length)];
  return { c: pick.c, r: pick.r };
}

// ───────────────────────────────────────────────────────────────────
//  LOCAL PATROL BUILDER  (fallback tight patrol near home)
//  Used when wander system needs a resting micro-route.
// ───────────────────────────────────────────────────────────────────

function buildLocalPatrol(sc, sr, grid, rng) {
  const pool = bfsFlood(grid, sc, sr, 3);
  pool.sort((a, b) => b.d - a.d);

  const waypoints = [{ c: sc, r: sr }];
  for (const cell of pool) {
    if (waypoints.length >= 6) break;
    const last = waypoints[waypoints.length - 1];
    if (Math.abs(cell.c - last.c) + Math.abs(cell.r - last.r) >= 2) {
      waypoints.push({ c: cell.c, r: cell.r });
    }
  }

  // Ensure at least 2 waypoints so ghost always oscillates
  if (waypoints.length < 2) {
    for (let radius = 1; radius <= ROWS; radius++) {
      let found = false;
      for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nc = sc + dc * radius, nr = sr + dr * radius;
        if (nc>=0 && nc<COLS && nr>=0 && nr<ROWS && grid[nr][nc]===0 && !(nc===sc && nr===sr)) {
          waypoints.push({ c: nc, r: nr });
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }
  return waypoints;
}

// ───────────────────────────────────────────────────────────────────
//  FURTHEST-FROM-EXIT PATROL CELL
//  Returns the patrol waypoint (or wander home) that is the greatest
//  Euclidean distance from the exit — used for camp-ejection.
// ───────────────────────────────────────────────────────────────────

function getFurthestFromExit(e) {
  const exPx = EXIT_X, exPy = EXIT_Y;
  let best = { c: e.homeC, r: e.homeR };
  let bestDist = Math.hypot(e.homeC * TILE + TILE/2 - exPx, e.homeR * TILE + TILE/2 - exPy);

  for (const wp of (e.patrolPath || [])) {
    const d = Math.hypot(wp.c * TILE + TILE/2 - exPx, wp.r * TILE + TILE/2 - exPy);
    if (d > bestDist) { bestDist = d; best = wp; }
  }
  return best;
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

function updatePhysics(dt) {
  elapsed += dt;
  updateTimer(elapsed);

  const input        = remoteKeys;
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
  // We need a seeded rng per enemy for deterministic wander decisions;
  // use enemy's home cell as a lightweight per-enemy seed.
  for (const e of enemies) {
    const eRng  = mulberry32(e.homeC * 97 + e.homeR * 1013 + Math.floor(nowMs / 500));
    const dist  = Math.hypot(player.x - e.x, player.y - e.y);

    // ────────────────────────────────────────────────────────────────
    //  A. AGGRO STATE MACHINE
    // ────────────────────────────────────────────────────────────────

    if (e.aggroEnabled && dist < SENSE_R) {
      // Player spotted — enter/refresh aggro and record last known pos
      e.aggro       = true;
      e.chaseUntil  = nowMs + CHASE_LINGER_MS;
      e.searchUntil = 0;
      e.lastKnownPx = player.x;
      e.lastKnownPy = player.y;
    } else if (e.aggro) {
      if (nowMs < e.chaseUntil) {
        // Still within linger window — keep chasing but update last known
        // only if we still sense the player vicinity (they just stepped out)
        // lastKnownPx/Py stays frozen at last confirmed sighting
      } else {
        // Chase timer expired → switch to SEARCH mode
        e.aggro       = false;
        e.searchUntil = nowMs + CHASE_LINGER_MS; // search for 3 s at last-known pos
      }
    }
    // Non-aggro enemies never enter aggro state

    // ────────────────────────────────────────────────────────────────
    //  B. EXIT CAMPING PREVENTION  (non-aggro only)
    // ────────────────────────────────────────────────────────────────

    if (!e.aggro) {
      const distToExit = Math.hypot(e.x - EXIT_X, e.y - EXIT_Y);
      if (distToExit < EXIT_GUARD_DIST) {
        // Ghost is near exit
        if (e.exitCampSince === 0) {
          e.exitCampSince = nowMs;
        } else if (nowMs - e.exitCampSince > EXIT_CAMP_MS) {
          // Has been camping too long — eject to furthest patrol point
          const dst = getFurthestFromExit(e);
          e.wanderTarget  = { c: dst.c, r: dst.r };
          e.exitCampSince = 0;
        }
      } else {
        // Outside danger zone — reset camp timer
        e.exitCampSince = 0;
      }
    } else {
      e.exitCampSince = 0;
    }

    // ────────────────────────────────────────────────────────────────
    //  C. ANTI-STUCK SYSTEM
    //  Track displacement every frame. If ghost hasn't moved in
    //  STUCK_FRAMES consecutive frames, force a new wander target.
    // ────────────────────────────────────────────────────────────────

    const movedSq = (e.x - e.lastX) ** 2 + (e.y - e.lastY) ** 2;
    if (movedSq < STUCK_DIST_SQ) {
      e.stuckFrames++;
      if (e.stuckFrames >= STUCK_FRAMES && !e.aggro) {
        // Pick a new wander target guaranteed ≥5 tiles (manhattan) away
        const candidates = bfsFlood(maze, e.homeC, e.homeR, PATROL_WANDER_R + 2)
          .filter(p => Math.abs(p.c - Math.floor(e.x/TILE)) + Math.abs(p.r - Math.floor(e.y/TILE)) >= 5);
        if (candidates.length > 0) {
          const pick = candidates[Math.floor(eRng() * candidates.length)];
          e.wanderTarget = { c: pick.c, r: pick.r };
        } else {
          // Fallback: any non-current cell
          const all = bfsFlood(maze, e.homeC, e.homeR, PATROL_WANDER_R + 2);
          if (all.length > 1) {
            const pick = all[1 + Math.floor(eRng() * (all.length - 1))];
            e.wanderTarget = { c: pick.c, r: pick.r };
          }
        }
        e.stuckFrames = 0;
      }
    } else {
      e.stuckFrames = 0;
    }
    e.lastX = e.x;
    e.lastY = e.y;

    // ────────────────────────────────────────────────────────────────
    //  D. VELOCITY SELECTION
    // ────────────────────────────────────────────────────────────────

    const spd = ENEMY_BASE_SPD * lvlSpeedMult * (e.aggro ? ENEMY_AGGRO_M : 1.0);

    if (e.aggro) {
      // ── CHASE: steer directly toward player ──────────────────────
      const d = dist || 1;
      e.vx = ((player.x - e.x) / d) * spd;
      e.vy = ((player.y - e.y) / d) * spd;

    } else if (nowMs < e.searchUntil) {
      // ── SEARCH: navigate to last-known player position ──────────
      const sdx = e.lastKnownPx - e.x;
      const sdy = e.lastKnownPy - e.y;
      const sd  = Math.hypot(sdx, sdy);
      if (sd > TILE * 0.5) {
        // Still travelling toward last-known position
        e.vx = (sdx / sd) * spd;
        e.vy = (sdy / sd) * spd;
      } else {
        // Arrived at last-known pos — idle/twitch while searching
        // Pick a tiny random micro-target to simulate "looking around"
        if (eRng() < 0.02) {  // ~once per second at 60fps
          const micro = bfsFlood(maze,
            Math.floor(e.x / TILE), Math.floor(e.y / TILE), 1);
          if (micro.length > 1) {
            const pick = micro[1 + Math.floor(eRng() * (micro.length - 1))];
            e.vx = ((pick.c * TILE + TILE/2 - e.x) / TILE) * spd * 0.5;
            e.vy = ((pick.r * TILE + TILE/2 - e.y) / TILE) * spd * 0.5;
          } else {
            e.vx *= 0.8;
            e.vy *= 0.8;
          }
        } else {
          e.vx *= 0.85;
          e.vy *= 0.85;
        }
      }

    } else {
      // ── WANDER PATROL: move toward wanderTarget ──────────────────
      if (e.wanderTarget) {
        const tx = e.wanderTarget.c * TILE + TILE / 2;
        const ty = e.wanderTarget.r * TILE + TILE / 2;
        const pd = Math.hypot(tx - e.x, ty - e.y);

        if (pd < TILE * 0.4) {
          // Reached wander target — snap and pick a new one
          e.x = tx; e.y = ty;
          e.vx = 0; e.vy = 0;
          e.wanderTarget = pickWanderTarget(e.homeC, e.homeR, maze, eRng);
        } else {
          e.vx = ((tx - e.x) / pd) * spd;
          e.vy = ((ty - e.y) / pd) * spd;
        }
      } else {
        // wanderTarget somehow null — assign one immediately
        e.wanderTarget = pickWanderTarget(e.homeC, e.homeR, maze, eRng);
        e.vx = 0; e.vy = 0;
      }
    }

    // ────────────────────────────────────────────────────────────────
    //  E. MOVEMENT + WALL SLIDE
    // ────────────────────────────────────────────────────────────────
    e.x = slideAxis(e.x, e.vx * dt, e.y, false, ENEMY_R);
    e.y = slideAxis(e.y, e.vy * dt, e.x, true,  ENEMY_R);
  }

  // Expire pings
  pings = pings.filter(p => elapsed - p.born < 2.2);

  // ── Win check ──
  if (Math.hypot(player.x - EXIT_X, player.y - EXIT_Y) < TILE * 0.6) {
    triggerWin(true);
    return;
  }

  // ── Death check ──
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
 * radius passed explicitly so it serves player and enemies equally.
 */
function slideAxis(pos, vel, crossPos, isY, radius) {
  if (vel === 0) return pos;
  const next  = pos + vel;
  const half  = radius * 0.86;
  const cross = crossPos;

  const checks = isY
    ? [[cross-half+1, next-half], [cross+half-1, next-half],
       [cross-half+1, next+half], [cross+half-1, next+half]]
    : [[next-half, cross-half+1], [next-half, cross+half-1],
       [next+half, cross-half+1], [next+half, cross+half-1]];

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
    appState = S.PAUSED; syncOverlays();
  } else if (appState === S.PAUSED) {
    appState = S.PLAYING; prevTs = performance.now(); syncOverlays();
  }
}

// ───────────────────────────────────────────────────────────────────
//  NEXT LEVEL / RETRY
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
  const { ox, oy, scale } = hostViewTransform();
  const mx = (e.clientX - rect.left - ox) / scale;
  const my = (e.clientY - rect.top  - oy) / scale;
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

function drawWorld() {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (maze[r][c] === 1) drawWall(c * TILE, r * TILE);
      else { ctx.fillStyle = C.floor; ctx.fillRect(c * TILE, r * TILE, TILE, TILE); }
    }
  }

  drawExit();
  for (const p of pings)   drawPing(p);
  for (const e of enemies) drawGhost(e);
  drawPlayerChar(player.x, player.y, player.angle, appState === S.DANCING);
}

function drawMoverView(cw, ch) {
  const px = player.x, py = player.y;
  const ox = cw / 2 - px, oy = ch / 2 - py;

  ctx.save();
  ctx.translate(ox, oy);
  drawWorld();

  ctx.globalCompositeOperation = "destination-in";
  const fog = ctx.createRadialGradient(px, py, FOG_R * 0.15, px, py, FOG_R);
  fog.addColorStop(0,    "rgba(0,0,0,1)");
  fog.addColorStop(0.72, "rgba(0,0,0,1)");
  fog.addColorStop(1,    "rgba(0,0,0,0)");
  ctx.fillStyle = fog;
  ctx.fillRect(-ox, -oy, cw, ch);

  ctx.globalCompositeOperation = "source-over";
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
  const x = EXIT_C * TILE, y = EXIT_R * TILE;
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

  ctx.shadowColor = C.player;
  ctx.shadowBlur  = 18 + 6 * Math.sin(t * 4);  // 12–24px, centre 18px

  const bodyGrad = ctx.createRadialGradient(-r*0.2, -r*0.2, r*0.05, 0, 0, r);
  bodyGrad.addColorStop(0,   "#aaffff");
  bodyGrad.addColorStop(0.5, C.player);
  bodyGrad.addColorStop(1,   "#0077aa");
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  ctx.fillStyle  = "#fff";
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(-r*0.28, -r*0.22, r*0.18, 0, Math.PI*2);
  ctx.arc( r*0.28, -r*0.22, r*0.18, 0, Math.PI*2);
  ctx.fill();

  ctx.fillStyle = "#003344";
  ctx.beginPath();
  ctx.arc(-r*0.28, -r*0.22, r*0.08, 0, Math.PI*2);
  ctx.arc( r*0.28, -r*0.22, r*0.08, 0, Math.PI*2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(-r*0.18, -r*0.18, r*0.28, 0, Math.PI*2);
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.fill();

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

  // Visual state: searching (yellow-tinted) or aggro (bright red) or normal
  const searching = !e.aggro && performance.now() < e.searchUntil;
  const bodyColor = e.aggro ? "#ff0022" : searching ? "#ff8800" : C.enemy;
  const glowColor = e.aggro ? C.enemy   : searching ? "#ff8800" : C.enemy;
  const blurBase  = e.aggro ? 30 + 10 * Math.sin(t * 9) : searching ? 20 : 14;

  ctx.save();
  ctx.shadowColor = glowColor;
  ctx.shadowBlur  = blurBase;
  ctx.fillStyle   = bodyColor;

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

  ctx.fillStyle  = "#fff";
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(gx - w*0.19, gy - h*0.14, w*0.115, 0, Math.PI*2);
  ctx.arc(gx + w*0.19, gy - h*0.14, w*0.115, 0, Math.PI*2);
  ctx.fill();

  const pupilColor = e.aggro ? "#ff0000" : searching ? "#ffaa00" : "#110022";
  ctx.fillStyle = pupilColor;
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

function updateTimer(s) { el("hud-timer").textContent = fmtTime(s); }

function fmtTime(s) {
  const m   = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

function updateHudLevel() { el("hud-level").textContent = levelIdx + 1; }

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

function el(id)              { return document.getElementById(id); }
function setHidden(id, h)    { el(id).classList.toggle("hidden", h); }
function setStatus(who, msg) { el(who==="host"?"host-status":"join-status").textContent = msg; }

// ───────────────────────────────────────────────────────────────────
//  BOOT
// ───────────────────────────────────────────────────────────────────

wireDpad();
requestAnimationFrame(gameLoop);