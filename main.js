/**
 * ═══════════════════════════════════════════════════════════════
 *  OVER HERE! — Networked P2P Multiplayer Maze Game
 *  main.js  |  Vite + PeerJS
 * ═══════════════════════════════════════════════════════════════
 *
 *  ROLES
 *  ─────
 *  HOST   → PeerJS server-side peer. Sees full map, enemies, player.
 *           Clicks to place Ping markers. Sends game-state to Mover.
 *
 *  MOVER  → PeerJS client-side peer. Sees only their character +
 *           fog-of-war. Sends input to Host. Receives rendered state.
 *
 *  VOICE  → Both peers call each other via PeerJS MediaConnection.
 *
 *  ARCHITECTURE
 *  ────────────
 *  • Host is the sole source of truth (physics, AI, timer).
 *  • Host sends a full GameState snapshot to Mover every frame.
 *  • Mover sends an InputState packet to Host every frame.
 *  • Canvas is drawn entirely on each client from their perspective.
 * ═══════════════════════════════════════════════════════════════
 */

import Peer from "peerjs";

// ──────────────────────────────────────────────────────────────
//  CONSTANTS
// ──────────────────────────────────────────────────────────────

const TILE    = 40;          // px per maze cell
const COLS    = 19;          // must be odd
const ROWS    = 15;          // must be odd
const W       = COLS * TILE;
const H       = ROWS * TILE;

const PLAYER_SPEED = 180;    // px/s
const ENEMY_BASE_SPEED = 80;
const ENEMY_AGGRO_MULT = 2.1;
const ENEMY_SENSE_RADIUS = TILE * 3.8;

const FOG_RADIUS = TILE * 3.2; // Mover's visibility radius

const COLORS = {
  bg:       "#05050f",
  wall:     "#0d1130",
  wallGlow: "#1a3080",
  floor:    "#070714",
  exit:     "#39ff14",
  player:   "#00f5ff",
  enemy:    "#ff2244",
  ping:     "#ffe600",
  fog:      "#03030e",
};

// ──────────────────────────────────────────────────────────────
//  LEVEL DEFINITIONS  (10 levels — imperfect mazes)
//  Cells: 0=floor, 1=wall, 2=start, 3=exit
//  Maps are COLS×ROWS (19×15)
// ──────────────────────────────────────────────────────────────

function buildMaze(seed, extraLoops) {
  // Recursive backtracker + random loop cuts to make imperfect maze
  const cols = COLS, rows = ROWS;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(1));
  const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
  const rng = mulberry32(seed);

  function carve(cx, cy) {
    visited[cy][cx] = true;
    grid[cy][cx] = 0;
    const dirs = [[0,-2],[0,2],[-2,0],[2,0]].sort(() => rng() - 0.5);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !visited[ny][nx]) {
        grid[cy + dy/2][cx + dx/2] = 0;
        carve(nx, ny);
      }
    }
  }
  carve(1, 1);

  // Add extra loops by removing random interior walls
  for (let i = 0; i < extraLoops; i++) {
    let x, y;
    do {
      x = Math.floor(rng() * (cols - 2)) + 1;
      y = Math.floor(rng() * (rows - 2)) + 1;
    } while (grid[y][x] === 0);
    let neighbors = 0;
    for (const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      if (grid[y+dy]?.[x+dx] === 0) neighbors++;
    }
    if (neighbors >= 2) grid[y][x] = 0;
  }

  // Place start and exit
  grid[1][1] = 0;  // start (floor)
  grid[rows-2][cols-2] = 0; // exit (floor)

  return grid;
}

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const LEVEL_CONFIGS = [
  { seed: 101, loops: 6,  enemies: 2,  timeLimit: 0 }, // 1 Easy
  { seed: 202, loops: 8,  enemies: 3,  timeLimit: 0 }, // 2
  { seed: 303, loops: 5,  enemies: 5,  timeLimit: 0 }, // 3 Hard starts
  { seed: 404, loops: 4,  enemies: 6,  timeLimit: 0 }, // 4
  { seed: 505, loops: 4,  enemies: 7,  timeLimit: 0 }, // 5
  { seed: 606, loops: 3,  enemies: 8,  timeLimit: 0 }, // 6
  { seed: 707, loops: 3,  enemies: 9,  timeLimit: 0 }, // 7
  { seed: 808, loops: 2,  enemies: 10, timeLimit: 0 }, // 8
  { seed: 909, loops: 2,  enemies: 11, timeLimit: 0 }, // 9
  { seed: 1010,loops: 1,  enemies: 13, timeLimit: 0 }, // 10
];

// ──────────────────────────────────────────────────────────────
//  GAME STATE
// ──────────────────────────────────────────────────────────────

const State = {
  MENU:    "MENU",
  PLAYING: "PLAYING",
  PAUSED:  "PAUSED",
  WIN:     "WIN",
  DEAD:    "DEAD",
};

let appState = State.MENU;
let role = null;        // "host" | "mover"
let currentLevel = 0;

// Physics world (owned by Host, mirrored by Mover from network)
let player    = null;  // { x, y, vx, vy }
let enemies   = [];    // [{ x, y, vx, vy, aggro, patrolPath, patrolIdx }]
let maze      = null;  // 2D grid
let pings     = [];    // [{ x, y, born, id }]
let elapsedSec = 0;

// Input (owned by Mover, sent to Host)
const keys = {};
window.addEventListener("keydown", e => { keys[e.code] = true; });
window.addEventListener("keyup",   e => { keys[e.code] = false; });

// Pause
window.addEventListener("keydown", e => {
  if (e.code === "Escape" && (appState === State.PLAYING || appState === State.PAUSED)) {
    togglePause();
  }
});

// ──────────────────────────────────────────────────────────────
//  AUDIO
// ──────────────────────────────────────────────────────────────

const bgMusic = new Audio("/bgmusic.mp3");
bgMusic.loop   = true;
bgMusic.volume = 0.2;

const sfxWin   = new Audio("/win.mp3");
const sfxDeath = new Audio("/death.mp3");
const sfxPing  = new Audio("/ping.mp3");   // optional — silent if missing

function tryPlay(audio) {
  const clone = audio.cloneNode();
  clone.volume = audio.volume || 0.6;
  clone.play().catch(() => {});
}

function startBgMusic()   { bgMusic.play().catch(() => {}); }
function stopBgMusic()    { bgMusic.pause(); bgMusic.currentTime = 0; }

// ──────────────────────────────────────────────────────────────
//  CANVAS & RENDERER
// ──────────────────────────────────────────────────────────────

const canvas = document.getElementById("game-canvas");
const ctx    = canvas.getContext("2d");

let camX = 0, camY = 0; // scroll offset for Mover fog-of-war view

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ──────────────────────────────────────────────────────────────
//  PEERJS NETWORKING
// ──────────────────────────────────────────────────────────────

let peer       = null;
let conn       = null;   // DataConnection
let mediaConn  = null;   // MediaConnection (voice)
let localStream = null;

function generateRoomId() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

async function getLocalStream() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return localStream;
  } catch(e) {
    console.warn("Mic unavailable:", e);
    return null;
  }
}

// ── HOST ──────────────────────────────────────────────────────

function initHost() {
  role = "host";
  const roomId = generateRoomId();
  document.getElementById("room-code-display").textContent = roomId;
  document.getElementById("host-status").textContent = "⏳ Waiting for player…";

  peer = new Peer(roomId, { debug: 0 });

  peer.on("open", id => {
    document.getElementById("host-status").textContent = "✅ Ready — share code above";
  });

  peer.on("connection", (dataConn) => {
    conn = dataConn;
    document.getElementById("host-status").textContent = "🎮 Mover connected! Starting…";

    conn.on("open", () => {
      // Answer voice call if Mover calls us
    });
    conn.on("data", handleDataFromMover);
    conn.on("error", e => console.error("conn error", e));

    // Start game after brief handshake delay
    setTimeout(() => startGame(), 800);
  });

  peer.on("call", async (call) => {
    const stream = await getLocalStream();
    call.answer(stream);
    mediaConn = call;
    call.on("stream", attachRemoteAudio);
  });

  peer.on("error", e => console.error("PeerJS error", e));
}

// ── MOVER ─────────────────────────────────────────────────────

async function initMover(hostId) {
  role = "mover";
  document.getElementById("join-status").textContent = "⏳ Connecting…";

  peer = new Peer(undefined, { debug: 0 });

  peer.on("open", async () => {
    const stream = await getLocalStream();

    // Data connection
    conn = peer.connect(hostId, { reliable: false, serialization: "json" });
    conn.on("open", () => {
      document.getElementById("join-status").textContent = "✅ Connected!";
      // Start voice call to host
      if (stream) {
        mediaConn = peer.call(hostId, stream);
        mediaConn.on("stream", attachRemoteAudio);
      }
    });
    conn.on("data", handleDataFromHost);
    conn.on("error", e => console.error("conn error", e));
  });

  peer.on("error", e => {
    document.getElementById("join-status").textContent = `❌ ${e.type}: Check room code`;
    console.error("PeerJS error", e);
  });
}

function attachRemoteAudio(stream) {
  const audio = new Audio();
  audio.srcObject = stream;
  audio.autoplay = true;
  audio.play().catch(() => {});
  document.getElementById("voice-indicator").classList.remove("hidden");
}

// ── DATA HANDLERS ─────────────────────────────────────────────

// HOST receives input from Mover
function handleDataFromMover(packet) {
  if (!packet) return;
  if (packet.type === "input") {
    remoteKeys = packet.keys;
  }
}

// MOVER receives state from Host
function handleDataFromHost(packet) {
  if (!packet) return;
  if (packet.type === "maze") {
    maze = packet.grid;
    if (!player) player = { x: 1 * TILE + TILE / 2, y: 1 * TILE + TILE / 2, vx: 0, vy: 0 };
    enemies = [];
    appState = State.PLAYING;
    syncOverlays();
    return;
  }
  if (packet.type === "state") {
    applyRemoteState(packet);
  }
  if (packet.type === "event") {
    handleRemoteEvent(packet);
  }
}

function applyRemoteState(s) {
  player  = s.player;
  enemies = s.enemies;
  pings   = s.pings;
  elapsedSec = s.elapsedSec;
  currentLevel = s.level;
  document.getElementById("hud-level").textContent = currentLevel + 1;
  updateTimer(elapsedSec);
  if (s.state && s.state !== appState) {
    appState = s.state;
    syncOverlays();
  }
}

function handleRemoteEvent(e) {
  if (e.evt === "win")   { triggerWin(false); }
  if (e.evt === "death") { triggerDeath(false); }
  if (e.evt === "ping")  { tryPlay(sfxPing); }
  if (e.evt === "nextLevel") { currentLevel = e.level; loadLevel(); }
}

// ──────────────────────────────────────────────────────────────
//  GAME INITIALIZATION
// ──────────────────────────────────────────────────────────────

let remoteKeys = {}; // Mover's keys received by Host

function startGame() {
  stopBgMusic();

  showScreen("game-screen");
  document.getElementById("hud-role").textContent = role === "host" ? "HOST" : "MOVER";

  currentLevel = 0;
  loadLevel();
  requestAnimationFrame(gameLoop);
}

function loadLevel() {
  appState = State.PLAYING;
  const cfg = LEVEL_CONFIGS[Math.min(currentLevel, LEVEL_CONFIGS.length - 1)];
  maze = buildMaze(cfg.seed, cfg.loops);

  // Player start at cell (1,1)
  player = {
    x: 1 * TILE + TILE / 2,
    y: 1 * TILE + TILE / 2,
    vx: 0, vy: 0
  };

  // Spawn enemies — Host only (Mover gets state from network)
  if (role === "host") {
    enemies = spawnEnemies(cfg.enemies);
  }

  pings = [];
  elapsedSec = 0;

  syncOverlays();
  document.getElementById("hud-level").textContent = currentLevel + 1;

  // Send maze to mover
  if (role === "host" && conn?.open) {
    conn.send({ type: "maze", grid: maze });
  }
}

function spawnEnemies(count) {
  const list = [];
  const rng = mulberry32(LEVEL_CONFIGS[currentLevel].seed + 1000);
  const floorCells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (maze[r][c] === 0 && !(r <= 3 && c <= 3)) {
        floorCells.push({ r, c });
      }
    }
  }
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * floorCells.length);
    const { r, c } = floorCells[idx];
    const path = buildPatrolPath(c, r, rng);
    list.push({
      x: c * TILE + TILE / 2,
      y: r * TILE + TILE / 2,
      vx: 0, vy: 0,
      aggro: false,
      patrolPath: path,
      patrolIdx: 0,
      patrolTimer: 0,
    });
  }
  return list;
}

function buildPatrolPath(startC, startR, rng) {
  const path = [{ c: startC, r: startR }];
  let c = startC, r = startR;
  for (let steps = 0; steps < 6; steps++) {
    const dirs = [[0,-1],[0,1],[-1,0],[1,0]].sort(() => rng() - 0.5);
    for (const [dc, dr] of dirs) {
      const nc = c + dc * 2, nr = r + dr * 2;
      if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS && maze[nr]?.[nc] === 0) {
        path.push({ c: nc, r: nr });
        c = nc; r = nr;
        break;
      }
    }
  }
  return path;
}

// ──────────────────────────────────────────────────────────────
//  GAME LOOP
// ──────────────────────────────────────────────────────────────

let lastTime = performance.now();

function gameLoop(ts) {
  const dt = Math.min((ts - lastTime) / 1000, 0.05);
  lastTime = ts;

  if (appState === State.PLAYING) {
    if (role === "host") {
      updateGame(dt);
      sendStateToMover();
    }
    // Mover: send input each frame
    if (role === "mover" && conn?.open) {
      conn.send({ type: "input", keys: { ...keys } });
    }
  }

  renderFrame();
  requestAnimationFrame(gameLoop);
}

// ──────────────────────────────────────────────────────────────
//  HOST — UPDATE GAME
// ──────────────────────────────────────────────────────────────

function updateGame(dt) {
  elapsedSec += dt;
  updateTimer(elapsedSec);

  // Determine input source
  const activeKeys = role === "host" ? {} : {};
  // For host-side simulation: merge local keys (host doesn't control player)
  // Mover's keys come from remoteKeys
  const input = remoteKeys;

  // Player movement
  const dx = (input["ArrowRight"] || input["KeyD"] ? 1 : 0) - (input["ArrowLeft"] || input["KeyA"] ? 1 : 0);
  const dy = (input["ArrowDown"]  || input["KeyS"] ? 1 : 0) - (input["ArrowUp"]   || input["KeyW"] ? 1 : 0);

  const len = Math.hypot(dx, dy) || 1;
  player.vx = (dx / len) * PLAYER_SPEED;
  player.vy = (dy / len) * PLAYER_SPEED;
  if (!dx && !dy) { player.vx = 0; player.vy = 0; }

  // Move with collision
  player.x = moveAxis(player.x, player.vx * dt, player.y, false);
  player.y = moveAxis(player.y, player.vy * dt, player.x, true);

  // Update enemies
  for (const e of enemies) {
    const dist = Math.hypot(player.x - e.x, player.y - e.y);
    e.aggro = dist < ENEMY_SENSE_RADIUS;
    const spd = ENEMY_BASE_SPEED * (1 + currentLevel * 0.12) * (e.aggro ? ENEMY_AGGRO_MULT : 1);

    if (e.aggro) {
      // Chase player directly
      const ed = Math.hypot(player.x - e.x, player.y - e.y) || 1;
      e.vx = ((player.x - e.x) / ed) * spd;
      e.vy = ((player.y - e.y) / ed) * spd;
    } else {
      // Patrol
      if (e.patrolPath.length > 0) {
        const target = e.patrolPath[e.patrolIdx % e.patrolPath.length];
        const tx = target.c * TILE + TILE / 2;
        const ty = target.r * TILE + TILE / 2;
        const pd = Math.hypot(tx - e.x, ty - e.y);
        if (pd < 3) {
          e.patrolIdx = (e.patrolIdx + 1) % e.patrolPath.length;
        } else {
          e.vx = ((tx - e.x) / pd) * spd;
          e.vy = ((ty - e.y) / pd) * spd;
        }
      }
    }

    e.x = moveAxis(e.x, e.vx * dt, e.y, false);
    e.y = moveAxis(e.y, e.vy * dt, e.x, true);
  }

  // Expire pings
  pings = pings.filter(p => elapsedSec - p.born < 2);

  // Win condition — reached exit cell
  const exitCX = (COLS - 2) * TILE + TILE / 2;
  const exitCY = (ROWS - 2) * TILE + TILE / 2;
  if (Math.hypot(player.x - exitCX, player.y - exitCY) < TILE * 0.55) {
    triggerWin(true);
    return;
  }

  // Death condition
  for (const e of enemies) {
    if (Math.hypot(player.x - e.x, player.y - e.y) < TILE * 0.5) {
      triggerDeath(true);
      return;
    }
  }
}

// Axis-separated collision against maze walls
function moveAxis(pos, vel, crossPos, isY) {
  const next = pos + vel;
  const half = TILE * 0.42;

  if (isY) {
    // Moving vertically: check top/bottom edges
    const top    = next - half;
    const bottom = next + half;
    const left   = crossPos - half + 2;
    const right  = crossPos + half - 2;
    if (isSolid(left, top) || isSolid(right, top) ||
        isSolid(left, bottom) || isSolid(right, bottom)) {
      return pos;
    }
  } else {
    // Moving horizontally: check left/right edges
    const lo   = next - half;
    const hi   = next + half;
    const top  = crossPos - half + 2;
    const bot  = crossPos + half - 2;
    if (isSolid(lo, top) || isSolid(lo, bot) ||
        isSolid(hi, top) || isSolid(hi, bot)) {
      return pos;
    }
  }
  return next;
}

function isSolid(wx, wy) {
  const c = Math.floor(wx / TILE);
  const r = Math.floor(wy / TILE);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return true;
  return maze[r][c] === 1;
}

// ──────────────────────────────────────────────────────────────
//  SEND STATE (Host → Mover)
// ──────────────────────────────────────────────────────────────

let lastSend = 0;
function sendStateToMover() {
  if (!conn?.open) return;
  const now = performance.now();
  if (now - lastSend < 16) return; // ~60fps cap
  lastSend = now;

  conn.send({
    type: "state",
    player: player,
    enemies: enemies.map(e => ({ x: e.x, y: e.y, aggro: e.aggro })),
    pings: pings,
    elapsedSec,
    level: currentLevel,
    state: appState,
  });
}

function broadcastEvent(evt, extra = {}) {
  if (conn?.open) conn.send({ type: "event", evt, ...extra });
}

// ──────────────────────────────────────────────────────────────
//  WIN / DEATH / PAUSE
// ──────────────────────────────────────────────────────────────

function triggerWin(isAuthority) {
  appState = State.WIN;
  tryPlay(sfxWin);
  if (isAuthority) broadcastEvent("win");
  document.getElementById("win-time").textContent =
    `Escaped in ${formatTime(elapsedSec)}`;
  syncOverlays();
}

function triggerDeath(isAuthority) {
  appState = State.DEAD;
  tryPlay(sfxDeath);
  if (isAuthority) broadcastEvent("death");
  syncOverlays();
}

function togglePause() {
  if (appState === State.PLAYING) {
    appState = State.PAUSED;
  } else if (appState === State.PAUSED) {
    appState = State.PLAYING;
    lastTime = performance.now();
  }
  syncOverlays();
}

function syncOverlays() {
  document.getElementById("pause-overlay").classList.toggle("hidden", appState !== State.PAUSED);
  document.getElementById("win-overlay").classList.toggle("hidden",   appState !== State.WIN);
  document.getElementById("death-overlay").classList.toggle("hidden", appState !== State.DEAD);
}

// ──────────────────────────────────────────────────────────────
//  HUD
// ──────────────────────────────────────────────────────────────

function updateTimer(sec) {
  document.getElementById("hud-timer").textContent = formatTime(sec);
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ──────────────────────────────────────────────────────────────
//  RENDERER
// ──────────────────────────────────────────────────────────────

let pingIdCounter = 0;

function renderFrame() {
  if (!maze || !player) return;

  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // Camera: center on player for Mover; fit full maze for Host
  let ox, oy;
  if (role === "mover") {
    ox = cw / 2 - player.x;
    oy = ch / 2 - player.y;
  } else {
    // Host: fit maze to canvas
    const scaleX = cw / W;
    const scaleY = ch / H;
    const scale  = Math.min(scaleX, scaleY);
    ox = (cw - W * scale) / 2;
    oy = (ch - H * scale) / 2;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    ox = 0; oy = 0;
  }

  if (role !== "mover") {
    drawScene(0, 0);
    ctx.restore();
  } else {
    drawMoverView(cw, ch, ox, oy);
  }
}

function drawMoverView(cw, ch, ox, oy) {
  ctx.save();
  ctx.translate(ox, oy);

  // Draw full scene (will be masked)
  drawScene(0, 0);

  // Fog of war mask
  ctx.globalCompositeOperation = "destination-in";
  const grad = ctx.createRadialGradient(
    player.x, player.y, FOG_RADIUS * 0.2,
    player.x, player.y, FOG_RADIUS
  );
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.7, "rgba(0,0,0,0.95)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.globalCompositeOperation = "source-over";

  // Dark fill outside fog
  const outerGrad = ctx.createRadialGradient(
    player.x, player.y, FOG_RADIUS * 0.85,
    player.x, player.y, FOG_RADIUS * 2
  );
  outerGrad.addColorStop(0, "rgba(3,3,14,0)");
  outerGrad.addColorStop(1, "rgba(3,3,14,1)");
  ctx.fillStyle = outerGrad;
  ctx.fillRect(0, 0, W, H);

  // Draw player on top always
  drawPlayer(player.x, player.y, false);

  ctx.restore();
}

function drawScene(ox, oy) {
  // Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // Maze tiles
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * TILE, y = r * TILE;
      if (maze[r][c] === 1) {
        drawWall(x, y);
      } else {
        ctx.fillStyle = COLORS.floor;
        ctx.fillRect(x, y, TILE, TILE);
      }
    }
  }

  // Exit tile
  drawExit();

  // Pings
  for (const p of pings) {
    drawPing(p);
  }

  // Enemies
  for (const e of enemies) {
    drawGhost(e.x, e.y, e.aggro);
  }

  // Player (host view shows it; mover draws it separately after fog)
  if (role === "host") {
    drawPlayer(player.x, player.y, false);
  }
}

function drawWall(x, y) {
  ctx.fillStyle = COLORS.wall;
  ctx.fillRect(x, y, TILE, TILE);

  // Glowing inner border
  ctx.strokeStyle = COLORS.wallGlow;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = "#2040b0";
  ctx.shadowBlur = 6;
  ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
  ctx.shadowBlur = 0;
}

function drawExit() {
  const x = (COLS - 2) * TILE, y = (ROWS - 2) * TILE;

  // Pulsing green portal
  const t = elapsedSec;
  const pulse = 0.5 + 0.5 * Math.sin(t * 3);

  ctx.save();
  ctx.shadowColor = COLORS.exit;
  ctx.shadowBlur  = 18 + pulse * 14;
  ctx.fillStyle   = `rgba(57,255,20,${0.15 + pulse * 0.25})`;
  ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);

  ctx.strokeStyle = COLORS.exit;
  ctx.lineWidth   = 2;
  ctx.strokeRect(x + 4, y + 4, TILE - 8, TILE - 8);

  // Arrow symbol
  ctx.fillStyle = COLORS.exit;
  ctx.font = `bold ${TILE * 0.55}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("▶", x + TILE / 2, y + TILE / 2);

  ctx.restore();
}

function drawPlayer(px, py, dim) {
  const r = TILE * 0.35;
  const t = elapsedSec;

  ctx.save();
  ctx.shadowColor = COLORS.player;
  ctx.shadowBlur  = 20 + 8 * Math.sin(t * 4);

  // Body
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fillStyle = dim ? "rgba(0,245,255,0.3)" : COLORS.player;
  ctx.fill();

  // Inner bright spot
  ctx.beginPath();
  ctx.arc(px - r * 0.25, py - r * 0.25, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fill();

  ctx.restore();
}

function drawGhost(gx, gy, aggro) {
  const t = elapsedSec;
  const w = TILE * 0.72;
  const h = TILE * 0.78;
  const waves = 4;

  ctx.save();
  ctx.shadowColor = COLORS.enemy;
  ctx.shadowBlur  = aggro ? 28 + 8 * Math.sin(t * 8) : 14;
  ctx.fillStyle   = aggro ? "#ff1133" : COLORS.enemy;

  ctx.beginPath();
  // Head arc
  ctx.arc(gx, gy - h * 0.1, w / 2, Math.PI, 0);
  // Right side down to bottom
  ctx.lineTo(gx + w / 2, gy + h * 0.4);
  // Wavy bottom
  for (let i = 0; i < waves; i++) {
    const waveX1 = gx + w / 2 - (w / waves) * (i + 0.5);
    const waveX2 = gx + w / 2 - (w / waves) * (i + 1);
    const waveY  = gy + h * 0.4 + (i % 2 === 0 ? 1 : -1) * (TILE * 0.13 + 0.06 * Math.sin(t * 5 + i));
    ctx.quadraticCurveTo(waveX1, waveY, waveX2, gy + h * 0.4);
  }
  ctx.closePath();
  ctx.fill();

  // Eyes
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(gx - w * 0.18, gy - h * 0.15, w * 0.12, 0, Math.PI * 2);
  ctx.arc(gx + w * 0.18, gy - h * 0.15, w * 0.12, 0, Math.PI * 2);
  ctx.fill();

  // Pupils (track player direction if aggro)
  ctx.fillStyle = aggro ? "#ff0000" : "#1a0030";
  const pupOff = aggro ? 0.04 : 0;
  ctx.beginPath();
  ctx.arc(gx - w * 0.18 + (player ? (player.x - gx) / W * 4 : 0) * pupOff,
          gy - h * 0.15 + (player ? (player.y - gy) / H * 4 : 0) * pupOff,
          w * 0.06, 0, Math.PI * 2);
  ctx.arc(gx + w * 0.18 + (player ? (player.x - gx) / W * 4 : 0) * pupOff,
          gy - h * 0.15 + (player ? (player.y - gy) / H * 4 : 0) * pupOff,
          w * 0.06, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawPing({ x, y, born }) {
  const age  = elapsedSec - born;
  const life = 2.0;
  const progress = age / life;
  if (progress >= 1) return;

  ctx.save();
  const maxR = TILE * 2.5;

  for (let ring = 0; ring < 3; ring++) {
    const ringProgress = (progress + ring * 0.15) % 1;
    const ringR = ringProgress * maxR;
    const alpha = (1 - ringProgress) * 0.8;

    ctx.beginPath();
    ctx.arc(x, y, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,230,0,${alpha})`;
    ctx.lineWidth   = 2.5 * (1 - ringProgress);
    ctx.shadowColor = COLORS.ping;
    ctx.shadowBlur  = 12;
    ctx.stroke();
  }

  // Center dot
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.ping;
  ctx.shadowBlur = 16;
  ctx.fill();

  ctx.restore();
}

// ──────────────────────────────────────────────────────────────
//  HOST CLICK → PING
// ──────────────────────────────────────────────────────────────

canvas.addEventListener("click", (e) => {
  if (role !== "host" || appState !== State.PLAYING) return;

  // Convert screen coords to maze coords (accounting for scale/offset)
  const rect  = canvas.getBoundingClientRect();
  const sx    = e.clientX - rect.left;
  const sy    = e.clientY - rect.top;

  const scaleX = canvas.width  / W;
  const scaleY = canvas.height / H;
  const scale  = Math.min(scaleX, scaleY);
  const offX   = (canvas.width  - W * scale) / 2;
  const offY   = (canvas.height - H * scale) / 2;

  const mx = (sx - offX) / scale;
  const my = (sy - offY) / scale;

  if (mx < 0 || my < 0 || mx > W || my > H) return;

  pings.push({ x: mx, y: my, born: elapsedSec, id: pingIdCounter++ });
  tryPlay(sfxPing);
  broadcastEvent("ping");
});

// ──────────────────────────────────────────────────────────────
//  NEXT LEVEL / RETRY BUTTONS
// ──────────────────────────────────────────────────────────────

document.getElementById("btn-next-level").addEventListener("click", () => {
  if (role === "host") {
    currentLevel = Math.min(currentLevel + 1, LEVEL_CONFIGS.length - 1);
    loadLevel();
    broadcastEvent("nextLevel", { level: currentLevel });
  }
});

document.getElementById("btn-retry").addEventListener("click", () => {
  if (role === "host") {
    loadLevel();
    broadcastEvent("nextLevel", { level: currentLevel });
  }
});

// ──────────────────────────────────────────────────────────────
//  UI HELPERS
// ──────────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(el => {
    el.classList.remove("active");
    el.classList.add("hidden");
  });
  const target = document.getElementById(id);
  target.classList.remove("hidden");
  target.classList.add("active");
}

// ──────────────────────────────────────────────────────────────
//  MENU BUTTON WIRING
// ──────────────────────────────────────────────────────────────

startBgMusic();

document.getElementById("btn-host").addEventListener("click", () => {
  document.getElementById("host-panel").classList.remove("hidden");
  document.getElementById("join-panel").classList.add("hidden");
  initHost();
});

document.getElementById("btn-join").addEventListener("click", () => {
  document.getElementById("join-panel").classList.remove("hidden");
  document.getElementById("host-panel").classList.add("hidden");
});

document.getElementById("btn-connect").addEventListener("click", () => {
  const id = document.getElementById("room-code-input").value.trim().toUpperCase();
  if (!id) return;
  initMover(id);
});

document.getElementById("room-code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-connect").click();
});

document.getElementById("btn-copy-code").addEventListener("click", () => {
  const code = document.getElementById("room-code-display").textContent;
  navigator.clipboard.writeText(code).then(() => {
    document.getElementById("btn-copy-code").textContent = "COPIED ✓";
    setTimeout(() => document.getElementById("btn-copy-code").textContent = "COPY CODE", 2000);
  });
});

// NOTE: handleDataFromHost (defined above) already handles the "maze" packet type
// alongside "state" and "event" packets — no additional patching needed.