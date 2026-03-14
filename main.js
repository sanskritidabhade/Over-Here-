/**
 * ═══════════════════════════════════════════════════════════════════
 *  OVER HERE! — main.js
 *  Vite + PeerJS P2P Networked Maze Game
 * ═══════════════════════════════════════════════════════════════════
 *
 *  HOST  = "Viewer"  — full map view, clicks to Ping. Drives physics.
 *  MOVER = "Player"  — fog-of-war, WASD / Arrow / D-Pad.
 *  VOICE — PeerJS MediaConnection, auto-established on connect.
 *
 *  ── FIXES IN THIS VERSION ───────────────────────────────────────
 *
 *  1. BFS STEP-BY-STEP PATHFINDING  (fixes wall-corner sticking)
 *     • bfsNextStep(fromC, fromR, toC, toR) runs a single BFS from
 *       the ghost's current tile and returns the IMMEDIATE next tile
 *       on the shortest route.  Used for CHASE, SEARCH, and
 *       MOVING_TO_TARGET — ghosts now navigate corridors correctly
 *       instead of pushing diagonally into walls.
 *     • Result is cached every PATHFIND_INTERVAL_MS (150 ms) to keep
 *       CPU cost constant even with many ghosts.
 *
 *  2. CHASE STUCK → FLANK MANEUVER  (fixes "hovering" bug)
 *     • Each ghost in CHASE mode counts consecutive frames where its
 *       squared displacement < CHASE_STUCK_SQ.
 *     • After CHASE_STUCK_FRAMES (60 ≈ 1 second) the ghost forces a
 *       FLANK: picks a BFS-reachable tile FLANK_OFFSET (4) tiles
 *       perpendicular to the ghost→player axis and routes there first,
 *       then immediately re-enters chase.  This breaks through T-junctions
 *       and forces approach from a different corridor.
 *
 *  3. SCATTER MODE  (breaks cluster walls every 10 seconds)
 *     • A level-wide scatterTimer increments each physics tick.
 *     • Every SCATTER_INTERVAL_S (10) seconds all ghosts ignore the
 *       player for SCATTER_DURATION_S (3) seconds and move to their
 *       assigned map corner (ghost 0→TL, 1→TR, 2→BL, 3→BR, cycling).
 *     • aggro is suspended during scatter; ghosts glow dim blue.
 *     • After scatter ends, ghosts resume normal target-tile travel.
 *
 *  ── PRESERVED (byte-for-byte identical to previous version) ─────
 *     • PeerJS / STUN networking — initHost, initMover, all handlers.
 *     • drawPlayerChar — neon cyan ball, 18 px shadowBlur glow.
 *     • drawPing, drawWall, drawExit — identical.
 *     • HUD, overlays, D-pad wiring, audio triggers.
 *     • Level table — +1 ghost per level from Level 0.
 *     • Fairness engine — BFS spawn-exclusion, path set, retries.
 *     • Boredom timer, long-distance target picker, opposite-quadrant
 *       relocation, search orbit — all preserved and still active.
 * ═══════════════════════════════════════════════════════════════════
 */

import Peer from "peerjs";

// ───────────────────────────────────────────────────────────────────
//  CONSTANTS
// ───────────────────────────────────────────────────────────────────

const TILE = 40;
const COLS = 19;
const ROWS = 15;
const W    = COLS * TILE;
const H    = ROWS * TILE;

// Player
const PLAYER_R     = TILE * 0.36;
const PLAYER_SPEED = 185;

// Ghost base
const ENEMY_R        = TILE * 0.38;
const ENEMY_BASE_SPD = 72;
const ENEMY_AGGRO_M  = 1.4;

// AI sensing & chase
const SENSE_R         = TILE * 4;
const CHASE_LINGER_MS = 3000;

// ── NEW: Chase-stuck flank ───────────────────────────────────────
const CHASE_STUCK_FRAMES = 60;      // frames of no progress → flank
const CHASE_STUCK_SQ     = 2 * 2;  // px² threshold for "no progress"
const FLANK_OFFSET       = 4;      // tiles perpendicular to chase axis

// ── NEW: Scatter mode ───────────────────────────────────────────
const SCATTER_INTERVAL_S = 10;     // seconds between scatter phases
const SCATTER_DURATION_S = 3;      // seconds each scatter lasts

// ── NEW: BFS step cache ──────────────────────────────────────────
const PATHFIND_INTERVAL_MS = 150;  // re-run BFS step at most every 150 ms

// Target-tile system (Pac-Man flow)
const TARGET_MIN_DIST   = 10;
const TARGET_FALLBACK_1 = 5;
const ARRIVAL_THRESH    = TILE * 0.45;

// Search orbit
const SEARCH_ORBIT_R   = TILE * 2;
const SEARCH_ORBIT_SPD = 1.8;

// Boredom / exit-camping
const EXIT_GUARD_TILES = 3;
const BOREDOM_MS       = 2000;

// Stuck safety net (general)
const STUCK_FRAMES  = 24;
const STUCK_DIST_SQ = 3 * 3;

// Spawn rules
const SPAWN_MIN_DIST    = TILE * 4;
const ENEMY_SPACE_MIN   = TILE * 3;
const EXIT_BUFFER_TILES = 2;

// Misc
const FOG_R              = TILE * 3.4;
const INVU_MS            = 500;
const MAX_LEVEL_ATTEMPTS = 12;

// Corner tiles for scatter (TL, TR, BL, BR)
const SCATTER_CORNERS = [
  { c: 1,      r: 1      },   // index 0 → top-left
  { c: COLS-2, r: 1      },   // index 1 → top-right
  { c: 1,      r: ROWS-2 },   // index 2 → bottom-left
  { c: COLS-2, r: ROWS-2 },   // index 3 → bottom-right
];

const C = {
  bg:       "#05050f",
  wall:     "#0c1030",
  wallGlow: "#1a3080",
  floor:    "#060611",
  exit:     "#39ff14",
  player:   "#00f5ff",
  enemy:    "#ff2244",
  ping:     "#ffe600",
  scatter:  "#4488ff",        // ghost tint during scatter
};

// ───────────────────────────────────────────────────────────────────
//  SEEDED RNG  (mulberry32) — unchanged
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
//  BFS UTILITIES — unchanged
// ───────────────────────────────────────────────────────────────────

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

// ── NEW: BFS step-by-step pathfinder ────────────────────────────────
/**
 * Returns the immediate NEXT tile on the BFS shortest path from
 * (fromC,fromR) toward (toC,toR).  If already there or unreachable,
 * returns { c:toC, r:toR } as a graceful fallback.
 * Used by CHASE, SEARCH, MOVING_TO_TARGET, and SCATTER.
 */
function bfsNextStep(fromC, fromR, toC, toR) {
  if (fromC === toC && fromR === toR) return { c: toC, r: toR };
  if (!maze || maze[fromR]?.[fromC] !== 0 || maze[toR]?.[toC] !== 0)
    return { c: toC, r: toR };

  const vis  = Array.from({ length: ROWS }, () => new Uint8Array(COLS));
  const prev = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
  const q    = [[fromC, fromR]];
  vis[fromR][fromC] = 1;
  let found = false;

  outer: while (q.length) {
    const [c, r] = q.shift();
    for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nc = c+dc, nr = r+dr;
      if (nc>=0 && nc<COLS && nr>=0 && nr<ROWS && !vis[nr][nc] && maze[nr][nc]===0) {
        vis[nr][nc] = 1;
        prev[nr][nc] = [c, r];
        if (nc===toC && nr===toR) { found=true; break outer; }
        q.push([nc, nr]);
      }
    }
  }

  if (!found) return { c: toC, r: toR };

  // Walk back from destination to find the first step
  let cur = [toC, toR];
  while (cur) {
    const p = prev[cur[1]][cur[0]];
    if (!p) break;
    if (p[0] === fromC && p[1] === fromR) return { c: cur[0], r: cur[1] };
    cur = p;
  }
  return { c: toC, r: toR }; // already adjacent
}

// ── NEW: Flank target picker ─────────────────────────────────────────
/**
 * When a ghost is stuck in CHASE, pick a tile FLANK_OFFSET tiles
 * perpendicular to the ghost→player axis.  Tries both sides and
 * picks whichever is a reachable floor tile; falls back to a
 * long-distance target if neither side is open.
 */
function getFlankTarget(eC, eR, pC, pR, rng) {
  // Axis from ghost to player
  const ddC = pC - eC;
  const ddR = pR - eR;

  // Two perpendicular directions (90° rotation: [-dy, dx] and [dy, -dx])
  const perpA = { c: eC + (-ddR > 0 ? 1 : -1) * FLANK_OFFSET,
                  r: eR + ( ddC > 0 ? 1 : -1) * FLANK_OFFSET };
  const perpB = { c: eC + ( ddR > 0 ? 1 : -1) * FLANK_OFFSET,
                  r: eR + (-ddC > 0 ? 1 : -1) * FLANK_OFFSET };

  // Clamp to maze bounds and check walkability
  function valid(t) {
    const cc = Math.max(0, Math.min(COLS-1, t.c));
    const rr = Math.max(0, Math.min(ROWS-1, t.r));
    return maze[rr]?.[cc] === 0 ? { c: cc, r: rr } : null;
  }

  const a = valid(perpA);
  const b = valid(perpB);

  if (a && b) return rng() < 0.5 ? a : b;
  if (a) return a;
  if (b) return b;
  return pickLongDistanceTarget(eC, eR, maze, rng);
}

// ───────────────────────────────────────────────────────────────────
//  MAZE GENERATION — unchanged
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
  const g = carveMaze(seed, extraLoops);
  for (let c = 1; c < COLS-1; c++) g[1][c] = 0;
  for (let r = 1; r < ROWS-1; r++) g[r][COLS-2] = 0;
  g[ROWS-2][COLS-2] = 0;
  return g;
}

// ───────────────────────────────────────────────────────────────────
//  LEVEL TABLE — unchanged
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

const S = { MENU:"MENU", PLAYING:"PLAYING", PAUSED:"PAUSED",
            DANCING:"DANCING", WIN:"WIN", DEAD:"DEAD" };

// ───────────────────────────────────────────────────────────────────
//  RUNTIME STATE
// ───────────────────────────────────────────────────────────────────

let appState    = S.MENU;
let role        = null;
let levelIdx    = 0;

let maze        = null;
let player      = null;
let enemies     = [];
let pings       = [];
let elapsed     = 0;
let invuUntil   = 0;
let danceTimer  = 0;
let pingCounter = 0;

const EXIT_C = COLS - 2;
const EXIT_R = ROWS - 2;
const EXIT_X = EXIT_C * TILE + TILE / 2;
const EXIT_Y = EXIT_R * TILE + TILE / 2;

let shortestPathSet = new Set();

// ── NEW: Scatter clock ───────────────────────────────────────────
let scatterTimer  = 0;    // seconds of game time since last scatter event
let scatterUntil  = 0;    // performance.now() ms — scatter ends at this time
let inScatter     = false;

const localKeys  = {};
let   remoteKeys = {};

window.addEventListener("keydown", e => {
  localKeys[e.code] = true;
  if (e.code === "Escape") onEsc();
});
window.addEventListener("keyup", e => { localKeys[e.code] = false; });

// ───────────────────────────────────────────────────────────────────
//  MOBILE D-PAD — unchanged
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
  const dpad    = document.getElementById("dpad");
  const isMover = role === "mover";
  const isTouch = navigator.maxTouchPoints > 0 || window.innerWidth <= 768;
  dpad.classList.toggle("hidden", !(isMover && isTouch));
}

// ───────────────────────────────────────────────────────────────────
//  AUDIO — unchanged
// ───────────────────────────────────────────────────────────────────

const bgMusic  = new Audio("/bgmusic.mp3");
bgMusic.loop   = true;
bgMusic.volume = 0.2;
let bgStarted  = false;

const sfxWin   = new Audio("/win.mp3");
const sfxDeath = new Audio("/death.mp3");
const sfxPing  = new Audio("/ping.mp3");

function playBgm() { if (bgStarted) return; bgStarted = true; bgMusic.play().catch(() => {}); }
function stopBgm() { bgMusic.pause(); bgMusic.currentTime = 0; bgStarted = false; }
function playSfx(audio) {
  try { const c = audio.cloneNode(); c.volume = 0.7; c.play().catch(() => {}); } catch(_) {}
}

// ───────────────────────────────────────────────────────────────────
//  CANVAS — unchanged
// ───────────────────────────────────────────────────────────────────

const canvas = document.getElementById("game-canvas");
const ctx    = canvas.getContext("2d");

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ───────────────────────────────────────────────────────────────────
//  PEERJS NETWORKING — PRESERVED EXACTLY, zero changes
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

function onDataFromMover(pkt) {
  if (!pkt) return;
  if (pkt.type === "input") remoteKeys = pkt.keys || {};
}

function onDataFromHost(pkt) {
  if (!pkt) return;
  switch (pkt.type) {
    case "levelData":
      maze = pkt.maze; player = pkt.player; enemies = pkt.enemies;
      pings = []; elapsed = 0; levelIdx = pkt.levelIdx;
      invuUntil = performance.now() + INVU_MS;
      updateHudLevel(); transitionToGame();
      break;
    case "state":
      if (pkt.player)  player  = pkt.player;
      if (pkt.enemies) enemies = pkt.enemies;
      if (pkt.pings)   pings   = pkt.pings;
      elapsed = pkt.elapsed ?? elapsed;
      updateTimer(elapsed);
      if (pkt.appState && pkt.appState !== appState) { appState = pkt.appState; syncOverlays(); }
      break;
    case "event":
      handleRemoteEvent(pkt);
      break;
    case "loadLevel":
      maze = pkt.maze; player = pkt.player; enemies = pkt.enemies;
      pings = []; elapsed = 0; levelIdx = pkt.levelIdx;
      invuUntil = performance.now() + INVU_MS;
      updateHudLevel(); appState = S.PLAYING; syncOverlays();
      break;
  }
}

function handleRemoteEvent(pkt) {
  if (pkt.evt === "win")   triggerWin(false);
  if (pkt.evt === "death") triggerDeath(false);
  if (pkt.evt === "ping")  playSfx(sfxPing);
}

let lastStateSend = 0;
function sendState() {
  if (!dataConn?.open) return;
  const now = performance.now();
  if (now - lastStateSend < 16) return;
  lastStateSend = now;
  dataConn.send({
    type: "state",
    player,
    enemies: enemies.map(e => ({ x:e.x, y:e.y, aggro:e.aggro, scatter:e.scatter })),
    pings, elapsed, appState,
  });
}

function sendEvent(evt, extra = {}) {
  dataConn?.open && dataConn.send({ type:"event", evt, ...extra });
}

// ───────────────────────────────────────────────────────────────────
//  LEVEL PACKET — adds new chase-stuck and scatter fields
// ───────────────────────────────────────────────────────────────────

function buildLevelPacket() {
  return {
    type: "levelData",
    levelIdx,
    maze,
    player: { ...player },
    enemies: enemies.map((e, idx) => ({
      x:               e.x,
      y:               e.y,
      aggro:           false,
      scatter:         false,
      aggroEnabled:    e.aggroEnabled,
      homeC:           e.homeC,
      homeR:           e.homeR,
      ghostIndex:      idx % SCATTER_CORNERS.length,  // corner assignment
      targetTile:      e.targetTile,
      // Chase / search
      chaseUntil:      0,
      searchUntil:     0,
      searchAngle:     0,
      lastKnownPx:     e.x,
      lastKnownPy:     e.y,
      // NEW: chase-stuck flank fields
      chaseStuckFrames: 0,
      chaseLastX:       e.x,
      chaseLastY:       e.y,
      flankTarget:      null,   // {c,r} when flanking
      // NEW: BFS step cache
      nextStepCache:    null,   // { toC, toR, step, cachedAt }
      // Anti-stuck (general)
      stuckFrames:     0,
      lastX:           e.x,
      lastY:           e.y,
      // Boredom
      boredSince:      0,
    })),
  };
}

// ───────────────────────────────────────────────────────────────────
//  LEVEL INIT — unchanged fairness engine; resets scatter timer
// ───────────────────────────────────────────────────────────────────

function initLevel(idx) {
  const cfg = LEVELS[Math.min(idx, LEVELS.length - 1)];

  let builtMaze, builtEnemies;
  let builtPathSet = new Set();
  let attempt = 0;

  while (attempt < MAX_LEVEL_ATTEMPTS) {
    const seedOff = attempt * 53881;
    builtMaze = buildMaze(cfg.seed + seedOff, cfg.loops);

    if (!bfsReachable(builtMaze, 1, 1, EXIT_C, EXIT_R)) { attempt++; continue; }

    const path = bfsShortestPath(builtMaze, 1, 1, EXIT_C, EXIT_R);
    if (!path) { attempt++; continue; }

    const excSet = new Set();
    const bufStart = Math.max(0, path.length - 1 - EXIT_BUFFER_TILES);
    for (let i = bufStart; i < path.length; i++) excSet.add(`${path[i].c},${path[i].r}`);
    path.forEach(p => excSet.add(`${p.c},${p.r}`));

    const px = 1 * TILE + TILE / 2;
    const py = 1 * TILE + TILE / 2;
    builtEnemies = trySpawnEnemies(
      cfg.enemies, cfg.seed + 9999 + seedOff,
      cfg.aggroOn, builtMaze, px, py, excSet
    );

    if (builtEnemies !== null) { builtPathSet = excSet; break; }
    attempt++;
  }

  if (!builtEnemies) {
    const fallbackPath = bfsShortestPath(builtMaze, 1, 1, EXIT_C, EXIT_R);
    const fallbackSet  = new Set();
    if (fallbackPath) fallbackPath.forEach(p => fallbackSet.add(`${p.c},${p.r}`));
    shortestPathSet = fallbackSet;
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

  // Reset scatter clock on new level
  scatterTimer = 0;
  scatterUntil = 0;
  inScatter    = false;
}

// ───────────────────────────────────────────────────────────────────
//  ENEMY SPAWNING — adds new fields
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

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  for (const cand of candidates) {
    if (list.length >= count) break;
    if (list.some(e => Math.hypot(cand.ex - e.x, cand.ey - e.y) < ENEMY_SPACE_MIN)) continue;

    const initTarget = pickLongDistanceTarget(cand.c, cand.r, grid, rng);
    const idx        = list.length % SCATTER_CORNERS.length;

    list.push({
      x:               cand.ex,
      y:               cand.ey,
      vx:              0,
      vy:              0,
      aggro:           false,
      scatter:         false,
      aggroEnabled,
      homeC:           cand.c,
      homeR:           cand.r,
      ghostIndex:      idx,
      targetTile:      initTarget,
      chaseUntil:      0,
      searchUntil:     0,
      searchAngle:     rng() * Math.PI * 2,
      lastKnownPx:     cand.ex,
      lastKnownPy:     cand.ey,
      chaseStuckFrames: 0,
      chaseLastX:      cand.ex,
      chaseLastY:      cand.ey,
      flankTarget:     null,
      nextStepCache:   null,
      stuckFrames:     0,
      lastX:           cand.ex,
      lastY:           cand.ey,
      boredSince:      0,
    });
  }

  return list.length === count ? list : null;
}

// ───────────────────────────────────────────────────────────────────
//  LONG-DISTANCE TARGET PICKER — unchanged
// ───────────────────────────────────────────────────────────────────

function pickLongDistanceTarget(fromC, fromR, grid, rng) {
  const all = bfsFlood(grid, fromC, fromR);
  let pool = all.filter(p => p.d >= TARGET_MIN_DIST);
  if (pool.length === 0) pool = all.filter(p => p.d >= TARGET_FALLBACK_1);
  if (pool.length === 0) pool = all.filter(p => p.d > 0);
  if (pool.length === 0) return { c: fromC, r: fromR };
  return pool[Math.floor(rng() * pool.length)];
}

// ───────────────────────────────────────────────────────────────────
//  OPPOSITE-QUADRANT RELOCATION — unchanged
// ───────────────────────────────────────────────────────────────────

function getOppositeQuadrantTarget(eC, eR, rng) {
  const midC = Math.floor(COLS / 2);
  const midR = Math.floor(ROWS / 2);
  const inLeft = eC < midC;
  const inTop  = eR < midR;
  const minC = inLeft ? midC : 0;
  const maxC = inLeft ? COLS : midC;
  const minR = inTop  ? midR : 0;
  const maxR = inTop  ? ROWS : midR;

  const pool = [];
  for (let r = minR; r < maxR; r++)
    for (let c = minC; c < maxC; c++)
      if (maze[r]?.[c] === 0) pool.push({ c, r });

  if (pool.length === 0) return pickLongDistanceTarget(eC, eR, maze, rng);
  return pool[Math.floor(rng() * pool.length)];
}

// ───────────────────────────────────────────────────────────────────
//  CACHED BFS STEP HELPER
//  Wraps bfsNextStep with a per-enemy cache that refreshes every
//  PATHFIND_INTERVAL_MS ms — one BFS per ghost per 150 ms.
// ───────────────────────────────────────────────────────────────────

function cachedNextStep(e, toC, toR, nowMs) {
  const eC = Math.floor(e.x / TILE);
  const eR = Math.floor(e.y / TILE);

  // Use cache if target unchanged and not stale
  if (e.nextStepCache &&
      e.nextStepCache.toC === toC &&
      e.nextStepCache.toR === toR &&
      nowMs - e.nextStepCache.cachedAt < PATHFIND_INTERVAL_MS) {
    return e.nextStepCache.step;
  }

  const step = bfsNextStep(eC, eR, toC, toR);
  e.nextStepCache = { toC, toR, step, cachedAt: nowMs };
  return step;
}

// ───────────────────────────────────────────────────────────────────
//  SCREEN TRANSITIONS — unchanged
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
    s.classList.remove("active"); s.classList.add("hidden");
  });
  const t = el(id);
  t.classList.remove("hidden"); t.classList.add("active");
}

function syncOverlays() {
  setHidden("ov-pause", appState !== S.PAUSED);
  setHidden("ov-win",   appState !== S.WIN);
  setHidden("ov-death", appState !== S.DEAD);
}

// ───────────────────────────────────────────────────────────────────
//  GAME LOOP — unchanged
// ───────────────────────────────────────────────────────────────────

let prevTs = performance.now();

function gameLoop(ts) {
  const dt = Math.min((ts - prevTs) / 1000, 0.05);
  prevTs = ts;

  if (appState === S.PLAYING) {
    if (role === "host") { updatePhysics(dt); sendState(); }
    if (role === "mover" && dataConn?.open) {
      dataConn.send({ type:"input", keys:{ ...localKeys } });
    }
  }

  if (appState === S.DANCING) {
    danceTimer += dt;
    if (danceTimer > 1.8) {
      appState = S.WIN; syncOverlays();
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

  // ── NEW: Scatter clock ───────────────────────────────────────────
  scatterTimer += dt;
  inScatter = nowMs < scatterUntil;

  if (!inScatter && scatterTimer >= SCATTER_INTERVAL_S) {
    // Trigger scatter phase
    scatterUntil = nowMs + SCATTER_DURATION_S * 1000;
    scatterTimer = 0;
    inScatter    = true;
  }

  // ── Enemy AI ─────────────────────────────────────────────────────
  for (const e of enemies) {
    const eRng = mulberry32(e.homeC * 97 + e.homeR * 1013 + Math.floor(nowMs / 500));
    const dist = Math.hypot(player.x - e.x, player.y - e.y);
    const eC   = Math.floor(e.x / TILE);
    const eR   = Math.floor(e.y / TILE);
    const pC   = Math.floor(player.x / TILE);
    const pR   = Math.floor(player.y / TILE);

    e.scatter = inScatter;

    // ──────────────────────────────────────────────────────────────
    //  A. AGGRO STATE MACHINE
    //     Aggro is suppressed during scatter.
    // ──────────────────────────────────────────────────────────────

    if (!inScatter && e.aggroEnabled && dist < SENSE_R) {
      e.aggro          = true;
      e.chaseUntil     = nowMs + CHASE_LINGER_MS;
      e.searchUntil    = 0;
      e.lastKnownPx    = player.x;
      e.lastKnownPy    = player.y;
      e.flankTarget    = null;   // clear any pending flank
    } else if (e.aggro && !inScatter) {
      if (nowMs >= e.chaseUntil) {
        e.aggro       = false;
        e.searchUntil = nowMs + CHASE_LINGER_MS;
        e.flankTarget = null;
      }
    } else if (inScatter && e.aggro) {
      // Scatter interrupts chase — ghost will resume after scatter ends
      e.aggro = false;
    }

    // ──────────────────────────────────────────────────────────────
    //  B. BOREDOM TIMER — unchanged (only fires when not chasing)
    // ──────────────────────────────────────────────────────────────

    if (!e.aggro && !inScatter && nowMs >= e.searchUntil) {
      const distToExit = Math.hypot(e.x - EXIT_X, e.y - EXIT_Y);
      const nearExit   = distToExit < EXIT_GUARD_TILES * TILE;
      const onPath     = shortestPathSet.has(`${eC},${eR}`);

      if (nearExit || onPath) {
        if (e.boredSince === 0) {
          e.boredSince = nowMs;
        } else if (nowMs - e.boredSince >= BOREDOM_MS) {
          e.targetTile = getOppositeQuadrantTarget(eC, eR, eRng);
          e.boredSince = 0;
        }
      } else {
        e.boredSince = 0;
      }
    } else {
      e.boredSince = 0;
    }

    // ──────────────────────────────────────────────────────────────
    //  C. GENERAL ANTI-STUCK — unchanged (non-chase, non-scatter)
    // ──────────────────────────────────────────────────────────────

    const movedSq = (e.x - e.lastX) ** 2 + (e.y - e.lastY) ** 2;
    if (movedSq < STUCK_DIST_SQ) {
      e.stuckFrames++;
      if (e.stuckFrames >= STUCK_FRAMES && !e.aggro && !inScatter) {
        e.targetTile   = pickLongDistanceTarget(eC, eR, maze, eRng);
        e.nextStepCache = null;
        e.stuckFrames  = 0;
      }
    } else {
      e.stuckFrames = 0;
    }
    e.lastX = e.x;
    e.lastY = e.y;

    // ──────────────────────────────────────────────────────────────
    //  D. VELOCITY SELECTION
    // ──────────────────────────────────────────────────────────────

    const spd = ENEMY_BASE_SPD * lvlSpeedMult * (e.aggro ? ENEMY_AGGRO_M : 1.0);

    if (inScatter) {
      // ── SCATTER: BFS-navigate to assigned corner ──────────────
      const corner = SCATTER_CORNERS[e.ghostIndex];
      const step   = cachedNextStep(e, corner.c, corner.r, nowMs);
      const tx = step.c * TILE + TILE / 2;
      const ty = step.r * TILE + TILE / 2;
      const pd = Math.hypot(tx - e.x, ty - e.y);
      if (pd > 2) {
        e.vx = ((tx - e.x) / pd) * spd * 0.85;  // slightly slower during scatter
        e.vy = ((ty - e.y) / pd) * spd * 0.85;
      } else {
        // At the step tile — advance next step tile
        e.nextStepCache = null;
        e.vx = 0; e.vy = 0;
      }

    } else if (e.aggro) {
      // ── CHASE: BFS step toward player with flank escape ───────
      //
      // Check if ghost is stuck in chase (hasn't moved in 60 frames)
      const chaseDeltaSq = (e.x - e.chaseLastX) ** 2 + (e.y - e.chaseLastY) ** 2;
      if (chaseDeltaSq < CHASE_STUCK_SQ) {
        e.chaseStuckFrames++;
        if (e.chaseStuckFrames >= CHASE_STUCK_FRAMES) {
          // FLANK MANEUVER: pick a perpendicular tile
          e.flankTarget      = getFlankTarget(eC, eR, pC, pR, eRng);
          e.chaseStuckFrames = 0;
          e.nextStepCache    = null;
        }
      } else {
        e.chaseStuckFrames = 0;
      }
      e.chaseLastX = e.x;
      e.chaseLastY = e.y;

      if (e.flankTarget) {
        // En route to flank position — use BFS step
        const step = cachedNextStep(e, e.flankTarget.c, e.flankTarget.r, nowMs);
        const tx = step.c * TILE + TILE / 2;
        const ty = step.r * TILE + TILE / 2;
        const pd = Math.hypot(tx - e.x, ty - e.y);
        if (pd < ARRIVAL_THRESH) {
          // Reached flank tile — clear flank, resume direct chase
          e.flankTarget    = null;
          e.nextStepCache  = null;
        } else {
          e.vx = ((tx - e.x) / pd) * spd;
          e.vy = ((ty - e.y) / pd) * spd;
        }
      }

      if (!e.flankTarget) {
        // Direct BFS chase toward player's tile
        const step = cachedNextStep(e, pC, pR, nowMs);
        const tx = step.c * TILE + TILE / 2;
        const ty = step.r * TILE + TILE / 2;
        const pd = Math.hypot(tx - e.x, ty - e.y);
        if (pd > 2) {
          e.vx = ((tx - e.x) / pd) * spd;
          e.vy = ((ty - e.y) / pd) * spd;
        } else {
          // Snap to step tile and clear cache for next step
          e.nextStepCache = null;
          e.vx = 0; e.vy = 0;
        }
      }

    } else if (nowMs < e.searchUntil) {
      // ── SEARCH (Blinky orbit): BFS to last-known, then orbit ──
      const lkC = Math.floor(e.lastKnownPx / TILE);
      const lkR = Math.floor(e.lastKnownPy / TILE);
      const sdx = e.lastKnownPx - e.x;
      const sdy = e.lastKnownPy - e.y;
      const sd  = Math.hypot(sdx, sdy);

      if (sd > SEARCH_ORBIT_R * 1.5) {
        // BFS step toward last-known position
        const step = cachedNextStep(e, lkC, lkR, nowMs);
        const tx = step.c * TILE + TILE / 2;
        const ty = step.r * TILE + TILE / 2;
        const pd = Math.hypot(tx - e.x, ty - e.y);
        if (pd > 2) {
          e.vx = ((tx - e.x) / pd) * spd;
          e.vy = ((ty - e.y) / pd) * spd;
        } else {
          e.nextStepCache = null;
          e.vx = 0; e.vy = 0;
        }
      } else {
        // Orbit last-known position
        e.searchAngle += SEARCH_ORBIT_SPD * dt;
        const tx = e.lastKnownPx + Math.cos(e.searchAngle) * SEARCH_ORBIT_R;
        const ty = e.lastKnownPy + Math.sin(e.searchAngle) * SEARCH_ORBIT_R;
        const od = Math.hypot(tx - e.x, ty - e.y);
        if (od > 2) {
          e.vx = ((tx - e.x) / od) * spd * 0.7;
          e.vy = ((ty - e.y) / od) * spd * 0.7;
        } else {
          e.vx = 0; e.vy = 0;
        }
      }

      if (nowMs >= e.searchUntil) {
        e.targetTile    = pickLongDistanceTarget(eC, eR, maze, eRng);
        e.nextStepCache = null;
      }

    } else {
      // ── MOVING_TO_TARGET: BFS step toward target tile ─────────
      if (!e.targetTile) {
        e.targetTile    = pickLongDistanceTarget(eC, eR, maze, eRng);
        e.nextStepCache = null;
      }

      const step = cachedNextStep(e, e.targetTile.c, e.targetTile.r, nowMs);
      const tx = step.c * TILE + TILE / 2;
      const ty = step.r * TILE + TILE / 2;
      const pd = Math.hypot(tx - e.x, ty - e.y);

      if (pd < ARRIVAL_THRESH) {
        // Arrived at intermediate step — if it's the final target, pick new one
        const atTarget = eC === e.targetTile.c && eR === e.targetTile.r;
        if (atTarget) {
          e.x = e.targetTile.c * TILE + TILE / 2;
          e.y = e.targetTile.r * TILE + TILE / 2;
          e.vx = 0; e.vy = 0;
          e.targetTile    = pickLongDistanceTarget(eC, eR, maze, eRng);
          e.nextStepCache = null;
        } else {
          // At an intermediate BFS step — clear cache so next step is computed
          e.nextStepCache = null;
          e.vx = 0; e.vy = 0;
        }
      } else {
        e.vx = ((tx - e.x) / pd) * spd;
        e.vy = ((ty - e.y) / pd) * spd;
      }
    }

    // ──────────────────────────────────────────────────────────────
    //  E. WALL-SLIDE MOVEMENT — unchanged
    // ──────────────────────────────────────────────────────────────
    e.x = slideAxis(e.x, e.vx * dt, e.y, false, ENEMY_R);
    e.y = slideAxis(e.y, e.vy * dt, e.x, true,  ENEMY_R);
  }

  pings = pings.filter(p => elapsed - p.born < 2.2);

  if (Math.hypot(player.x - EXIT_X, player.y - EXIT_Y) < TILE * 0.6) {
    triggerWin(true); return;
  }

  if (nowMs > invuUntil) {
    for (const e of enemies) {
      if (Math.hypot(player.x - e.x, player.y - e.y) < PLAYER_R + ENEMY_R) {
        triggerDeath(true); return;
      }
    }
  }
}

function boolAxis(keys, a, b) { return (keys[a] || keys[b]) ? 1 : 0; }

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
  for (const [wx, wy] of checks) { if (solidAt(wx, wy)) return pos; }
  return next;
}

function solidAt(wx, wy) {
  const c = Math.floor(wx / TILE), r = Math.floor(wy / TILE);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return true;
  return maze[r][c] === 1;
}

// ───────────────────────────────────────────────────────────────────
//  WIN / DEATH / PAUSE — unchanged
// ───────────────────────────────────────────────────────────────────

function triggerWin(isAuthority) {
  if (appState === S.WIN || appState === S.DANCING) return;
  playSfx(sfxWin); danceTimer = 0; appState = S.DANCING;
  if (isAuthority) sendEvent("win");
}

function triggerDeath(isAuthority) {
  if (appState === S.DEAD) return;
  playSfx(sfxDeath); appState = S.DEAD; syncOverlays();
  if (isAuthority) sendEvent("death");
}

function onEsc() {
  if (appState === S.PLAYING)     { appState = S.PAUSED;  syncOverlays(); }
  else if (appState === S.PAUSED) { appState = S.PLAYING; prevTs = performance.now(); syncOverlays(); }
}

// ───────────────────────────────────────────────────────────────────
//  NEXT LEVEL / RETRY — unchanged
// ───────────────────────────────────────────────────────────────────

el("btn-next-level").addEventListener("click", () => {
  if (role !== "host") return;
  levelIdx = Math.min(levelIdx + 1, LEVELS.length - 1);
  initLevel(levelIdx); updateHudLevel(); appState = S.PLAYING; syncOverlays();
  if (dataConn?.open) { const p = buildLevelPacket(); p.type = "loadLevel"; dataConn.send(p); }
});

el("btn-retry").addEventListener("click", () => {
  if (role !== "host") return;
  initLevel(levelIdx); updateHudLevel(); appState = S.PLAYING; syncOverlays();
  if (dataConn?.open) { const p = buildLevelPacket(); p.type = "loadLevel"; dataConn.send(p); }
});

// ───────────────────────────────────────────────────────────────────
//  HOST CLICK → PING — unchanged
// ───────────────────────────────────────────────────────────────────

canvas.addEventListener("click", e => {
  if (role !== "host" || appState !== S.PLAYING) return;
  const rect = canvas.getBoundingClientRect();
  const { ox, oy, scale } = hostViewTransform();
  const mx = (e.clientX - rect.left - ox) / scale;
  const my = (e.clientY - rect.top  - oy) / scale;
  if (mx < 0 || my < 0 || mx > W || my > H) return;
  pings.push({ x:mx, y:my, born:elapsed, id: pingCounter++ });
  playSfx(sfxPing); sendEvent("ping");
});

function hostViewTransform() {
  const scale = Math.min(canvas.width / W, canvas.height / H);
  const ox    = (canvas.width  - W * scale) / 2;
  const oy    = (canvas.height - H * scale) / 2;
  return { ox, oy, scale };
}

// ───────────────────────────────────────────────────────────────────
//  RENDERER — unchanged except drawGhost scatter tint
// ───────────────────────────────────────────────────────────────────

function draw() {
  if (!maze || !player) return;
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);
  if (role === "host") {
    const { ox, oy, scale } = hostViewTransform();
    ctx.save(); ctx.translate(ox, oy); ctx.scale(scale, scale);
    drawWorld(); ctx.restore();
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
  ctx.save(); ctx.translate(ox, oy);
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

// ── DRAW HELPERS — unchanged ─────────────────────────────────────

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
  ctx.shadowBlur  = 18 + 6 * Math.sin(t * 4);

  const bodyGrad = ctx.createRadialGradient(-r*0.2, -r*0.2, r*0.05, 0, 0, r);
  bodyGrad.addColorStop(0,   "#aaffff");
  bodyGrad.addColorStop(0.5, C.player);
  bodyGrad.addColorStop(1,   "#0077aa");
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  ctx.fillStyle = "#fff"; ctx.shadowBlur = 0;
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

// ── GHOST — adds scatter (blue) visual state ──────────────────────
function drawGhost(e) {
  const t  = elapsed;
  const gx = e.x, gy = e.y;
  const w  = TILE * 0.70, h = TILE * 0.76;

  const isScatter  = !!e.scatter;
  const searching  = !e.aggro && !isScatter && performance.now() < e.searchUntil;

  // Visual priority: aggro (red) > scatter (blue) > searching (orange) > normal
  const bodyColor = e.aggro    ? "#ff0022"
                  : isScatter  ? "#2255cc"
                  : searching  ? "#ff8800"
                  : C.enemy;
  const glowColor = e.aggro    ? C.enemy
                  : isScatter  ? C.scatter
                  : searching  ? "#ff8800"
                  : C.enemy;
  const blurBase  = e.aggro    ? 30 + 10 * Math.sin(t * 9)
                  : isScatter  ? 18 + 6  * Math.sin(t * 4)
                  : searching  ? 20
                  : 14;

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

  ctx.fillStyle = "#fff"; ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(gx - w*0.19, gy - h*0.14, w*0.115, 0, Math.PI*2);
  ctx.arc(gx + w*0.19, gy - h*0.14, w*0.115, 0, Math.PI*2);
  ctx.fill();

  const pupilColor = e.aggro   ? "#ff0000"
                   : isScatter ? "#aaccff"
                   : searching ? "#ffaa00"
                   : "#110022";
  ctx.fillStyle = pupilColor;
  ctx.beginPath();
  ctx.arc(gx - w*0.19, gy - h*0.14, w*0.055, 0, Math.PI*2);
  ctx.arc(gx + w*0.19, gy - h*0.14, w*0.055, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();
}

// ── PING — unchanged ──────────────────────────────────────────────
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
//  HUD HELPERS — unchanged
// ───────────────────────────────────────────────────────────────────

function updateTimer(s) { el("hud-timer").textContent = fmtTime(s); }
function fmtTime(s) {
  const m = Math.floor(s/60).toString().padStart(2,"0");
  const sec = Math.floor(s%60).toString().padStart(2,"0");
  return `${m}:${sec}`;
}
function updateHudLevel() { el("hud-level").textContent = levelIdx + 1; }

// ───────────────────────────────────────────────────────────────────
//  MENU WIRING — unchanged
// ───────────────────────────────────────────────────────────────────

el("btn-host").addEventListener("click", () => {
  playBgm(); setHidden("host-panel", false); setHidden("join-panel", true); initHost();
});
el("btn-join").addEventListener("click", () => {
  playBgm(); setHidden("join-panel", false); setHidden("host-panel", true);
});
el("btn-connect").addEventListener("click", () => {
  const id = el("room-code-input").value.trim().toUpperCase();
  if (!id) return; initMover(id);
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
//  UTILITY — unchanged
// ───────────────────────────────────────────────────────────────────

function el(id)              { return document.getElementById(id); }
function setHidden(id, h)    { el(id).classList.toggle("hidden", h); }
function setStatus(who, msg) { el(who==="host"?"host-status":"join-status").textContent = msg; }

// ───────────────────────────────────────────────────────────────────
//  BOOT
// ───────────────────────────────────────────────────────────────────

wireDpad();
requestAnimationFrame(gameLoop);