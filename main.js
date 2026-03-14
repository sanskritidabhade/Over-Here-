/**
 * ═══════════════════════════════════════════════════════════════════
 *  OVER HERE! — main.js  v4  (black-screen fix + pause/leave)
 *  Vite + PeerJS
 * ═══════════════════════════════════════════════════════════════════
 *
 *  KEY ARCHITECTURAL DECISIONS
 *  ────────────────────────────
 *  • HOST is the sole source of truth for all physics / AI / timer.
 *  • On Mover connect, Host sends a { type:'START_GAME' } packet
 *    containing the full maze and spawn point → Mover transitions to
 *    PLAYING immediately (no blank screen).
 *  • Host sends { type:'STATE' } every ~16 ms (≈60 fps) thereafter.
 *  • Mover sends { type:'INPUT' } every frame.
 *  • ESC pauses both clients; pause overlay shows Leave button.
 *  • "Leave Game" closes PeerJS conn and calls location.reload().
 *
 *  PACKET TYPES (Host → Mover)
 *  ────────────────────────────
 *   START_GAME  { maze, spawn, levelIdx }
 *   STATE       { player, enemies, pings, elapsed, appState }
 *   LOAD_LEVEL  { maze, spawn, levelIdx }
 *   EVENT       { evt: 'win'|'death'|'ping' }
 *
 *  PACKET TYPES (Mover → Host)
 *  ────────────────────────────
 *   INPUT       { keys }
 * ═══════════════════════════════════════════════════════════════════
 */

import Peer from "peerjs";

// ─────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────

const TILE   = 40;
const COLS   = 19;   // odd
const ROWS   = 15;   // odd
const MW     = COLS * TILE;   // 760
const MH     = ROWS * TILE;   // 600

const PLAYER_SPEED   = 185;   // px / s
const PLAYER_R       = TILE * 0.36;
const ENEMY_R        = TILE * 0.38;
const ENEMY_BASE_SPD = 76;
const ENEMY_AGGRO_M  = 2.25;
const SENSE_R        = TILE * 3.9;
const FOG_R          = TILE * 3.5;
const INVU_MS        = 550;          // invulnerability at level start
const SPAWN_MIN_D    = TILE * 5;     // min distance from player spawn

// World-space exit position
const EXIT_C = COLS - 2;
const EXIT_R = ROWS - 2;
const EXIT_X = EXIT_C * TILE + TILE / 2;
const EXIT_Y = EXIT_R * TILE + TILE / 2;

// Colours (used in canvas renderer)
const CLR = {
  bg:       "#04040e",
  wall:     "#1a0a3a",
  wallGlow: "#7b2fff",
  floor:    "#060611",
  exit:     "#39ff14",
  player:   "#00f5ff",
  enemy:    "#ff2244",
  ping:     "#ffe600",
};

// ─────────────────────────────────────────────────────────────────
//  SEEDED RNG  (mulberry32)
// ─────────────────────────────────────────────────────────────────

function rngFactory(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────
//  MAZE GENERATOR  (recursive backtracker + loop cuts)
// ─────────────────────────────────────────────────────────────────

function buildMaze(seed, extraLoops) {
  const rng  = rngFactory(seed);
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(1));
  const vis  = Array.from({ length: ROWS }, () => Array(COLS).fill(false));

  function carve(cx, cy) {
    vis[cy][cx]  = true;
    grid[cy][cx] = 0;
    const dirs = [[0,-2],[0,2],[-2,0],[2,0]].sort(() => rng() - 0.5);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx > 0 && nx < COLS - 1 && ny > 0 && ny < ROWS - 1 && !vis[ny][nx]) {
        grid[cy + dy / 2][cx + dx / 2] = 0;
        carve(nx, ny);
      }
    }
  }
  carve(1, 1);

  // Extra loop cuts → multi-path maze
  for (let i = 0; i < extraLoops; i++) {
    const x = Math.floor(rng() * (COLS - 2)) + 1;
    const y = Math.floor(rng() * (ROWS - 2)) + 1;
    if (grid[y][x] === 1) {
      let fn = 0;
      for (const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        if (grid[y+dy]?.[x+dx] === 0) fn++;
      }
      if (fn >= 2) grid[y][x] = 0;
    }
  }

  // Force start and exit cells open
  grid[1][1]           = 0;
  grid[ROWS-2][COLS-2] = 0;

  return grid;
}

// ─────────────────────────────────────────────────────────────────
//  LEVEL TABLE  (10 levels)
// ─────────────────────────────────────────────────────────────────

const LEVELS = [
  /* 1  Tutorial  */ { seed: 2001, loops: 12, enemies: 0,  aggro: false },
  /* 2  One ghost */ { seed: 2002, loops: 11, enemies: 1,  aggro: false },
  /* 3  Aggro on  */ { seed: 2003, loops:  9, enemies: 3,  aggro: true  },
  /* 4            */ { seed: 2004, loops:  8, enemies: 4,  aggro: true  },
  /* 5            */ { seed: 2005, loops:  7, enemies: 5,  aggro: true  },
  /* 6            */ { seed: 2006, loops:  6, enemies: 6,  aggro: true  },
  /* 7            */ { seed: 2007, loops:  5, enemies: 7,  aggro: true  },
  /* 8            */ { seed: 2008, loops:  4, enemies: 9,  aggro: true  },
  /* 9            */ { seed: 2009, loops:  3, enemies: 11, aggro: true  },
  /* 10 Final     */ { seed: 2010, loops:  2, enemies: 13, aggro: true  },
];

// ─────────────────────────────────────────────────────────────────
//  GAME-STATE ENUM
// ─────────────────────────────────────────────────────────────────

const GS = {
  MENU:    "MENU",
  PLAYING: "PLAYING",
  PAUSED:  "PAUSED",
  DANCING: "DANCING",   // victory animation
  WIN:     "WIN",
  DEAD:    "DEAD",
};

// ─────────────────────────────────────────────────────────────────
//  RUNTIME STATE
// ─────────────────────────────────────────────────────────────────

let gs          = GS.MENU;
let role        = null;    // "host" | "mover"
let levelIdx    = 0;

// Simulation world  (authoritative on Host; mirrored on Mover via network)
let maze        = null;
let player      = null;   // { x, y, vx, vy, angle }
let enemies     = [];     // [{ x,y,vx,vy,aggro,aggroEnabled,patrolPath,patrolIdx }]
let pings       = [];     // [{ x, y, born }]
let elapsed     = 0;      // seconds
let invuUntil   = 0;      // performance.now() timestamp — death blocked until then
let danceTimer  = 0;
let pingCtr     = 0;

// Input
const localKeys  = {};
let   remoteKeys = {};    // Mover's keys received on Host side

// ─────────────────────────────────────────────────────────────────
//  KEYBOARD
// ─────────────────────────────────────────────────────────────────

window.addEventListener("keydown", e => {
  localKeys[e.code] = true;
  if (e.code === "Escape") onEsc();
});
window.addEventListener("keyup", e => { localKeys[e.code] = false; });

// ─────────────────────────────────────────────────────────────────
//  AUDIO
// ─────────────────────────────────────────────────────────────────

const bgm    = new Audio("/bgmusic.mp3");
bgm.loop     = true;
bgm.volume   = 0.2;
let bgmOn    = false;

const sfxWin   = new Audio("/win.mp3");
const sfxDeath = new Audio("/death.mp3");
const sfxPing  = new Audio("/ping.mp3");

function startBgm() {
  if (bgmOn) return;
  bgmOn = true;
  bgm.play().catch(() => {});
}

function stopBgm() {
  bgm.pause();
  bgm.currentTime = 0;
  bgmOn = false;
}

function playSfx(a) {
  try {
    const c = a.cloneNode();
    c.volume = 0.72;
    c.play().catch(() => {});
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────
//  CANVAS
// ─────────────────────────────────────────────────────────────────

const canvas = g("gc");
const ctx    = canvas.getContext("2d");

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ─────────────────────────────────────────────────────────────────
//  PEERJS
// ─────────────────────────────────────────────────────────────────

let peer        = null;
let dataConn    = null;
let mediaConn   = null;
let localStream = null;

function makeId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

async function getMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return localStream;
  } catch (e) {
    console.warn("Mic unavailable:", e);
    return null;
  }
}

// ── HOST ──────────────────────────────────────────────────────────

function initHost() {
  role = "host";
  const rid = makeId();
  g("room-id-display").textContent = rid;
  setStatus("host", "⏳ Waiting for player…");

  peer = new Peer(rid, { debug: 0 });

  peer.on("open", () => setStatus("host", "✅ Ready — share the Room ID above!"));

  peer.on("connection", dc => {
    dataConn = dc;
    setStatus("host", "🔗 Player connecting…");

    dc.on("open", () => {
      setStatus("host", "🎮 Connected! Sending level…");

      // ── CRITICAL FIX: build level THEN send START_GAME immediately ──
      prepareLevel(levelIdx);

      dc.send({
        type:     "START_GAME",
        levelIdx: levelIdx,
        maze:     maze,
        spawn:    { x: player.x, y: player.y },
        enemies:  enemies.map(serEnemy),
      });

      // Now transition host to PLAYING
      goPlaying();
    });

    dc.on("data",  onFromMover);
    dc.on("error", e => console.error("DC:", e));
    dc.on("close", () => console.warn("DC closed"));
  });

  peer.on("call", async call => {
    const s = await getMic();
    call.answer(s || undefined);
    call.on("stream", hookAudio);
  });

  peer.on("error", e => {
    setStatus("host", `❌ ${e.type}`);
    console.error(e);
  });
}

// ── MOVER ─────────────────────────────────────────────────────────

async function initMover(hostId) {
  role = "mover";
  setStatus("join", "⏳ Connecting…");

  peer = new Peer(undefined, { debug: 0 });

  peer.on("open", async () => {
    const stream = await getMic();

    dataConn = peer.connect(hostId, { reliable: true, serialization: "json" });

    dataConn.on("open", () => {
      setStatus("join", "✅ Connected! Waiting for level data…");
      // Voice
      if (stream) {
        mediaConn = peer.call(hostId, stream);
        mediaConn.on("stream", hookAudio);
      }
    });

    dataConn.on("data",  onFromHost);
    dataConn.on("error", e => console.error("DC:", e));
    dataConn.on("close", () => console.warn("DC closed"));
  });

  peer.on("error", e => {
    setStatus("join", `❌ ${e.type} — check the Room ID`);
    console.error(e);
  });
}

function hookAudio(stream) {
  const a = new Audio();
  a.srcObject = stream;
  a.autoplay  = true;
  a.play().catch(() => {});
  g("voice-badge").classList.remove("hidden");
}

// ── DATA HANDLERS ─────────────────────────────────────────────────

function onFromMover(pkt) {
  if (!pkt) return;
  if (pkt.type === "INPUT") remoteKeys = pkt.keys || {};
}

function onFromHost(pkt) {
  if (!pkt) return;

  switch (pkt.type) {

    // ── THE FIX: Mover receives START_GAME, transitions immediately ──
    case "START_GAME":
      maze     = pkt.maze;
      levelIdx = pkt.levelIdx ?? 0;
      // Restore full enemy objects from serialised form
      enemies  = (pkt.enemies || []).map(deserEnemy);
      pings    = [];
      elapsed  = 0;
      // ── Camera fix: set player at the spawn point the Host sent ──
      player   = { x: pkt.spawn.x, y: pkt.spawn.y, vx: 0, vy: 0, angle: 0 };
      invuUntil = performance.now() + INVU_MS;
      danceTimer = 0;
      updateHud();
      goPlaying();         // show game canvas, stop BGM
      break;

    case "STATE":
      if (pkt.player)  player  = pkt.player;
      if (pkt.enemies) enemies = pkt.enemies;   // already serialised lightly
      if (pkt.pings)   pings   = pkt.pings;
      if (pkt.elapsed !== undefined) { elapsed = pkt.elapsed; updateTimer(elapsed); }
      // Sync appState only for terminal states (WIN/DEAD/DANCING)
      if (pkt.appState && pkt.appState !== gs &&
          [GS.WIN, GS.DEAD, GS.DANCING].includes(pkt.appState)) {
        gs = pkt.appState;
        syncOverlays();
      }
      break;

    case "LOAD_LEVEL":
      maze     = pkt.maze;
      levelIdx = pkt.levelIdx ?? levelIdx;
      enemies  = (pkt.enemies || []).map(deserEnemy);
      pings    = [];
      elapsed  = 0;
      player   = { x: pkt.spawn.x, y: pkt.spawn.y, vx: 0, vy: 0, angle: 0 };
      invuUntil = performance.now() + INVU_MS;
      danceTimer = 0;
      updateHud();
      gs = GS.PLAYING;
      syncOverlays();
      break;

    case "EVENT":
      if (pkt.evt === "win")   { playSfx(sfxWin); }
      if (pkt.evt === "death") { playSfx(sfxDeath); }
      if (pkt.evt === "ping")  { playSfx(sfxPing); }
      break;
  }
}

// Serialise enemy for network (strip heavy patrol array after first send)
function serEnemy(e) {
  return { x: e.x, y: e.y, vx: e.vx, vy: e.vy,
           aggro: e.aggro, aggroEnabled: e.aggroEnabled,
           patrolPath: e.patrolPath, patrolIdx: e.patrolIdx };
}
function deserEnemy(e) {
  return { ...e };
}

// ── BROADCAST ─────────────────────────────────────────────────────

let lastSend = 0;
function broadcastState() {
  if (!dataConn?.open) return;
  const now = performance.now();
  if (now - lastSend < 16) return;
  lastSend = now;
  dataConn.send({
    type: "STATE",
    player,
    enemies: enemies.map(e => ({ x:e.x, y:e.y, aggro:e.aggro })),
    pings,
    elapsed,
    appState: gs,
  });
}

function sendEvent(evt, extra = {}) {
  dataConn?.open && dataConn.send({ type: "EVENT", evt, ...extra });
}

function sendLoadLevel() {
  if (!dataConn?.open) return;
  dataConn.send({
    type:     "LOAD_LEVEL",
    levelIdx: levelIdx,
    maze:     maze,
    spawn:    { x: player.x, y: player.y },
    enemies:  enemies.map(serEnemy),
  });
}

// ─────────────────────────────────────────────────────────────────
//  LEVEL INIT  (runs on Host; Mover gets data via network)
// ─────────────────────────────────────────────────────────────────

function prepareLevel(idx) {
  const cfg = LEVELS[Math.min(idx, LEVELS.length - 1)];
  maze    = buildMaze(cfg.seed, cfg.loops);
  player  = { x: 1 * TILE + TILE / 2, y: 1 * TILE + TILE / 2, vx: 0, vy: 0, angle: 0 };
  enemies = spawnEnemies(cfg.enemies, cfg.seed + 8888, cfg.aggro);
  pings   = [];
  elapsed = 0;
  invuUntil  = performance.now() + INVU_MS;
  danceTimer = 0;
}

function spawnEnemies(count, seed, aggroEnabled) {
  const rng  = rngFactory(seed);
  const list = [];
  const px = player.x, py = player.y;

  // Build pool of safe floor cells
  const pool = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (maze[r][c] !== 0) continue;
      const ex = c * TILE + TILE / 2, ey = r * TILE + TILE / 2;
      if (Math.hypot(ex - px, ey - py) >= SPAWN_MIN_D) {
        pool.push({ c, r, ex, ey });
      }
    }
  }

  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const { c, r, ex, ey } = pool[i];
    list.push({
      x: ex, y: ey, vx: 0, vy: 0,
      aggro: false, aggroEnabled,
      patrolPath: buildPatrol(c, r, rngFactory(seed + i * 17)),
      patrolIdx: 0,
    });
  }
  return list;
}

function buildPatrol(sc, sr, rng) {
  const path = [{ c: sc, r: sr }];
  let c = sc, r = sr;
  for (let step = 0; step < 9; step++) {
    const dirs = [[0,-1],[0,1],[-1,0],[1,0]].sort(() => rng() - 0.5);
    for (const [dc, dr] of dirs) {
      const nc = c + dc, nr = r + dr;
      if (nc > 0 && nc < COLS-1 && nr > 0 && nr < ROWS-1 && maze[nr]?.[nc] === 0) {
        path.push({ c: nc, r: nr });
        c = nc; r = nr;
        break;
      }
    }
  }
  return path;
}

// ─────────────────────────────────────────────────────────────────
//  SCREEN TRANSITIONS
// ─────────────────────────────────────────────────────────────────

function goPlaying() {
  stopBgm();                         // ← stop BGM the moment game starts
  showScreen("screen-game");
  g("h-role").textContent = role === "host" ? "HOST" : "MOVER";
  updateHud();
  gs = GS.PLAYING;
  syncOverlays();
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => {
    s.classList.remove("active");
    s.classList.add("hidden");
  });
  const t = g(id);
  t.classList.remove("hidden");
  t.classList.add("active");
}

function syncOverlays() {
  hide("ov-pause", gs !== GS.PAUSED);
  hide("ov-win",   gs !== GS.WIN);
  hide("ov-death", gs !== GS.DEAD);
}

// ─────────────────────────────────────────────────────────────────
//  PAUSE / LEAVE
// ─────────────────────────────────────────────────────────────────

function onEsc() {
  if (gs === GS.PLAYING) {
    gs = GS.PAUSED;
    syncOverlays();
  } else if (gs === GS.PAUSED) {
    gs = GS.PLAYING;
    prevTs = performance.now();
    syncOverlays();
  }
}

function leaveGame() {
  try { dataConn?.close(); } catch (_) {}
  try { mediaConn?.close(); } catch (_) {}
  try { peer?.destroy(); }    catch (_) {}
  location.reload();
}

// Wire all "leave" buttons
["btn-leave-pause", "btn-leave-win", "btn-leave-death"].forEach(id => {
  g(id).addEventListener("click", leaveGame);
});

g("btn-resume").addEventListener("click", () => {
  if (gs === GS.PAUSED) {
    gs = GS.PLAYING;
    prevTs = performance.now();
    syncOverlays();
  }
});

// ─────────────────────────────────────────────────────────────────
//  GAME LOOP
// ─────────────────────────────────────────────────────────────────

let prevTs = performance.now();

function loop(ts) {
  const dt = Math.min((ts - prevTs) / 1000, 0.05);
  prevTs = ts;

  if (gs === GS.PLAYING) {
    if (role === "host") {
      tick(dt);
      broadcastState();
    }
    if (role === "mover" && dataConn?.open) {
      dataConn.send({ type: "INPUT", keys: { ...localKeys } });
    }
  }

  if (gs === GS.DANCING) {
    danceTimer += dt;
    if (danceTimer > 1.85) {
      gs = GS.WIN;
      syncOverlays();
      g("ov-win-time").textContent = `Escaped in ${fmt(elapsed)}`;
    }
    if (role === "host") broadcastState();
  }

  render();
  requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────────────────────────
//  PHYSICS / AI  (Host-authoritative)
// ─────────────────────────────────────────────────────────────────

function tick(dt) {
  elapsed += dt;
  updateTimer(elapsed);

  const inp = remoteKeys;
  const lvlM = 1 + levelIdx * 0.09;

  // ── Player ──────────────────────────────────────────────────────
  const dx = axis(inp,"ArrowRight","KeyD") - axis(inp,"ArrowLeft","KeyA");
  const dy = axis(inp,"ArrowDown","KeyS")  - axis(inp,"ArrowUp","KeyW");
  const dl = Math.hypot(dx, dy) || 1;
  const norm = (dx || dy) ? 1 / dl : 0;
  player.vx = dx * norm * PLAYER_SPEED;
  player.vy = dy * norm * PLAYER_SPEED;
  if (dx || dy) player.angle = Math.atan2(dy, dx);

  player.x = slide(player.x, player.vx * dt, player.y, false);
  player.y = slide(player.y, player.vy * dt, player.x, true);

  // ── Enemies ─────────────────────────────────────────────────────
  for (const e of enemies) {
    const dist = Math.hypot(player.x - e.x, player.y - e.y);
    e.aggro = e.aggroEnabled && dist < SENSE_R;
    const spd = ENEMY_BASE_SPD * lvlM * (e.aggro ? ENEMY_AGGRO_M : 1);

    if (e.aggro) {
      const d = dist || 1;
      e.vx = ((player.x - e.x) / d) * spd;
      e.vy = ((player.y - e.y) / d) * spd;
    } else {
      const pt = e.patrolPath?.[e.patrolIdx % (e.patrolPath?.length || 1)];
      if (pt) {
        const tx = pt.c * TILE + TILE / 2, ty = pt.r * TILE + TILE / 2;
        const pd = Math.hypot(tx - e.x, ty - e.y);
        if (pd < 4) {
          e.patrolIdx = (e.patrolIdx + 1) % e.patrolPath.length;
        } else {
          e.vx = ((tx - e.x) / pd) * spd;
          e.vy = ((ty - e.y) / pd) * spd;
        }
      }
    }
    e.x = slide(e.x, e.vx * dt, e.y, false);
    e.y = slide(e.y, e.vy * dt, e.x, true);
  }

  // Expire pings
  pings = pings.filter(p => elapsed - p.born < 2.3);

  // ── Win ──────────────────────────────────────────────────────────
  if (Math.hypot(player.x - EXIT_X, player.y - EXIT_Y) < TILE * 0.62) {
    triggerWin();
    return;
  }

  // ── Death (with invulnerability window) ──────────────────────────
  if (performance.now() > invuUntil) {
    for (const e of enemies) {
      if (Math.hypot(player.x - e.x, player.y - e.y) < PLAYER_R + ENEMY_R) {
        triggerDeath();
        return;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
//  COLLISION
// ─────────────────────────────────────────────────────────────────

function slide(pos, vel, cross, isY) {
  if (!vel) return pos;
  const next = pos + vel;
  const hr   = PLAYER_R * 0.87;

  const checks = isY
    ? [[cross - hr + 2, next - hr],[cross + hr - 2, next - hr],
       [cross - hr + 2, next + hr],[cross + hr - 2, next + hr]]
    : [[next - hr, cross - hr + 2],[next - hr, cross + hr - 2],
       [next + hr, cross - hr + 2],[next + hr, cross + hr - 2]];

  for (const [wx, wy] of checks) if (solidAt(wx, wy)) return pos;
  return next;
}

function solidAt(wx, wy) {
  const c = Math.floor(wx / TILE), r = Math.floor(wy / TILE);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return true;
  return maze[r][c] === 1;
}

// ─────────────────────────────────────────────────────────────────
//  WIN / DEATH / NEXT / RETRY
// ─────────────────────────────────────────────────────────────────

function triggerWin() {
  if (gs === GS.WIN || gs === GS.DANCING) return;
  gs = GS.DANCING;
  danceTimer = 0;
  playSfx(sfxWin);
  sendEvent("win");
}

function triggerDeath() {
  if (gs === GS.DEAD) return;
  gs = GS.DEAD;
  syncOverlays();
  playSfx(sfxDeath);
  sendEvent("death");
}

g("btn-next").addEventListener("click", () => {
  if (role !== "host") return;
  levelIdx = Math.min(levelIdx + 1, LEVELS.length - 1);
  prepareLevel(levelIdx);
  updateHud();
  gs = GS.PLAYING;
  syncOverlays();
  sendLoadLevel();
});

g("btn-retry").addEventListener("click", () => {
  if (role !== "host") return;
  prepareLevel(levelIdx);
  updateHud();
  gs = GS.PLAYING;
  syncOverlays();
  sendLoadLevel();
});

// ─────────────────────────────────────────────────────────────────
//  HOST CLICK → PING
// ─────────────────────────────────────────────────────────────────

canvas.addEventListener("click", e => {
  if (role !== "host" || gs !== GS.PLAYING) return;
  const rect = canvas.getBoundingClientRect();
  const sx   = e.clientX - rect.left;
  const sy   = e.clientY - rect.top;
  const { ox, oy, sc } = hostTransform();
  const mx = (sx - ox) / sc;
  const my = (sy - oy) / sc;
  if (mx < 0 || my < 0 || mx > MW || my > MH) return;
  pings.push({ x: mx, y: my, born: elapsed, id: pingCtr++ });
  playSfx(sfxPing);
  sendEvent("ping");
});

function hostTransform() {
  const sc = Math.min(canvas.width / MW, canvas.height / MH);
  const ox = (canvas.width  - MW * sc) / 2;
  const oy = (canvas.height - MH * sc) / 2;
  return { ox, oy, sc };
}

// ─────────────────────────────────────────────────────────────────
//  RENDERER
// ─────────────────────────────────────────────────────────────────

function render() {
  if (!maze || !player) return;
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  if (role === "host") {
    const { ox, oy, sc } = hostTransform();
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(sc, sc);
    drawWorld();
    ctx.restore();
  } else {
    drawMoverView(cw, ch);
  }
}

// ── Full world (Host sees this, Mover sees it through fog) ────────
function drawWorld() {
  ctx.fillStyle = CLR.bg;
  ctx.fillRect(0, 0, MW, MH);

  // Tiles
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (maze[r][c] === 1) drawWall(c * TILE, r * TILE);
      else { ctx.fillStyle = CLR.floor; ctx.fillRect(c * TILE, r * TILE, TILE, TILE); }
    }
  }

  drawExit();
  for (const p of pings)   drawPing(p);
  for (const e of enemies) drawGhost(e);
  drawPlayer(player.x, player.y, player.angle, gs === GS.DANCING);
}

// ── Mover view with fog-of-war ────────────────────────────────────
function drawMoverView(cw, ch) {
  const px = player.x, py = player.y;
  // ── Camera centered on player (spawn fix) ──
  const ox = cw / 2 - px;
  const oy = ch / 2 - py;

  ctx.save();
  ctx.translate(ox, oy);

  drawWorld();

  // Fog mask
  ctx.globalCompositeOperation = "destination-in";
  const fog = ctx.createRadialGradient(px, py, FOG_R * 0.14, px, py, FOG_R);
  fog.addColorStop(0,    "rgba(0,0,0,1)");
  fog.addColorStop(0.72, "rgba(0,0,0,1)");
  fog.addColorStop(1,    "rgba(0,0,0,0)");
  ctx.fillStyle = fog;
  ctx.fillRect(-ox, -oy, cw, ch);

  ctx.globalCompositeOperation = "source-over";

  // Outer darkness
  const dark = ctx.createRadialGradient(px, py, FOG_R * 0.78, px, py, FOG_R * 2.4);
  dark.addColorStop(0, "rgba(4,4,14,0)");
  dark.addColorStop(1, "rgba(4,4,14,1)");
  ctx.fillStyle = dark;
  ctx.fillRect(-ox, -oy, cw, ch);

  ctx.restore();
}

// ── Draw helpers ──────────────────────────────────────────────────

function drawWall(x, y) {
  // Dark purple fill
  ctx.fillStyle = CLR.wall;
  ctx.fillRect(x, y, TILE, TILE);
  // Neon purple glowing edge
  ctx.save();
  ctx.strokeStyle = CLR.wallGlow;
  ctx.lineWidth   = 1.6;
  ctx.shadowColor = CLR.wallGlow;
  ctx.shadowBlur  = 9;
  ctx.strokeRect(x + 1.5, y + 1.5, TILE - 3, TILE - 3);
  ctx.restore();
}

function drawExit() {
  const x = EXIT_C * TILE, y = EXIT_R * TILE;
  const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3.2);
  ctx.save();
  ctx.shadowColor = CLR.exit;
  ctx.shadowBlur  = 20 + pulse * 18;
  ctx.fillStyle   = `rgba(57,255,20,${0.11 + pulse * 0.22})`;
  ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
  ctx.strokeStyle  = CLR.exit;
  ctx.lineWidth    = 2.5;
  ctx.strokeRect(x + 4, y + 4, TILE - 8, TILE - 8);
  ctx.fillStyle    = CLR.exit;
  ctx.font         = `bold ${TILE * 0.5}px monospace`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("▶", x + TILE / 2, y + TILE / 2);
  ctx.restore();
}

function drawPlayer(px, py, angle, dancing) {
  const r = PLAYER_R;
  const t = elapsed;

  ctx.save();
  ctx.translate(px, py);

  if (dancing) {
    ctx.rotate(danceTimer * 5.2);
    const ps = 1 + 0.24 * Math.sin(danceTimer * 14);
    ctx.scale(ps, ps);
  }

  ctx.shadowColor = CLR.player;
  ctx.shadowBlur  = 22 + 8 * Math.sin(t * 4);

  // Body gradient
  const g2 = ctx.createRadialGradient(-r * 0.2, -r * 0.2, r * 0.04, 0, 0, r);
  g2.addColorStop(0,   "#aaffff");
  g2.addColorStop(0.5, CLR.player);
  g2.addColorStop(1,   "#0077aa");
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = g2;
  ctx.fill();

  // Eyes
  ctx.shadowBlur = 0;
  ctx.fillStyle  = "#fff";
  ctx.beginPath();
  ctx.arc(-r * 0.27, -r * 0.22, r * 0.18, 0, Math.PI * 2);
  ctx.arc( r * 0.27, -r * 0.22, r * 0.18, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#003344";
  ctx.beginPath();
  ctx.arc(-r * 0.27, -r * 0.22, r * 0.08, 0, Math.PI * 2);
  ctx.arc( r * 0.27, -r * 0.22, r * 0.08, 0, Math.PI * 2);
  ctx.fill();

  // Highlight
  ctx.beginPath();
  ctx.arc(-r * 0.18, -r * 0.18, r * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fill();

  // Victory sparkles
  if (dancing) {
    for (let i = 0; i < 7; i++) {
      const a   = (i / 7) * Math.PI * 2 + danceTimer * 3.2;
      const rad = r * 1.7 + 5 * Math.sin(danceTimer * 9 + i);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rad, Math.sin(a) * rad, 3.2, 0, Math.PI * 2);
      ctx.fillStyle   = `hsl(${(i * 51 + t * 120) % 360},100%,68%)`;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur  = 10;
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawGhost(e) {
  const t = elapsed;
  const gx = e.x, gy = e.y;
  const w = TILE * 0.7, h = TILE * 0.76;

  ctx.save();
  ctx.shadowColor = CLR.enemy;
  ctx.shadowBlur  = e.aggro ? 32 + 10 * Math.sin(t * 9) : 14;
  ctx.fillStyle   = e.aggro ? "#ff0020" : CLR.enemy;

  ctx.beginPath();
  ctx.arc(gx, gy - h * 0.08, w / 2, Math.PI, 0);
  ctx.lineTo(gx + w / 2, gy + h * 0.42);
  for (let i = 0; i < 4; i++) {
    const wx1 = gx + w/2 - (w/4)*(i+0.5);
    const wx2 = gx + w/2 - (w/4)*(i+1);
    const wy  = gy + h*0.42 + (i%2===0?1:-1)*(TILE*0.12 + 0.07*Math.sin(t*5+i));
    ctx.quadraticCurveTo(wx1, wy, wx2, gy + h * 0.42);
  }
  ctx.closePath();
  ctx.fill();

  // Eyes
  ctx.fillStyle = "#fff"; ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(gx - w*0.19, gy - h*0.13, w*0.11, 0, Math.PI*2);
  ctx.arc(gx + w*0.19, gy - h*0.13, w*0.11, 0, Math.PI*2);
  ctx.fill();

  ctx.fillStyle = e.aggro ? "#ff0000" : "#110022";
  ctx.beginPath();
  ctx.arc(gx - w*0.19, gy - h*0.13, w*0.052, 0, Math.PI*2);
  ctx.arc(gx + w*0.19, gy - h*0.13, w*0.052, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();
}

function drawPing({ x, y, born }) {
  const progress = (elapsed - born) / 2.3;
  if (progress >= 1) return;
  ctx.save();
  for (let ring = 0; ring < 3; ring++) {
    const rp  = (progress + ring * 0.18) % 1;
    const rad = rp * TILE * 2.9;
    const al  = (1 - rp) * 0.85;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,230,0,${al})`;
    ctx.lineWidth   = 2.8 * (1 - rp);
    ctx.shadowColor = CLR.ping;
    ctx.shadowBlur  = 12;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fillStyle   = CLR.ping;
  ctx.shadowBlur  = 18;
  ctx.shadowColor = CLR.ping;
  ctx.fill();
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────
//  HUD HELPERS
// ─────────────────────────────────────────────────────────────────

function updateTimer(s) { g("h-timer").textContent = fmt(s); }
function updateHud() {
  g("h-level").textContent = levelIdx + 1;
  updateTimer(elapsed);
}
function fmt(s) {
  return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(Math.floor(s%60)).padStart(2,"0")}`;
}

// ─────────────────────────────────────────────────────────────────
//  MENU WIRING
// ─────────────────────────────────────────────────────────────────

g("btn-host").addEventListener("click", () => {
  startBgm();                         // BGM on first interaction
  show("panel-host");
  hide("panel-join", true);
  initHost();
});

g("btn-join").addEventListener("click", () => {
  startBgm();                         // BGM on first interaction
  show("panel-join");
  hide("panel-host", true);
});

g("btn-connect").addEventListener("click", () => {
  const id = g("room-id-input").value.trim().toUpperCase();
  if (!id) { setStatus("join","⚠ Please enter a Room ID!"); return; }
  initMover(id);
});

g("room-id-input").addEventListener("keydown", e => {
  if (e.key === "Enter") g("btn-connect").click();
});

g("btn-copy").addEventListener("click", () => {
  const code = g("room-id-display").textContent;
  navigator.clipboard.writeText(code).then(() => {
    g("btn-copy").textContent = "COPIED ✓";
    setTimeout(() => { g("btn-copy").textContent = "COPY ID"; }, 2000);
  });
});

// ─────────────────────────────────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────────────────────────────────

function g(id)    { return document.getElementById(id); }
function show(id) { g(id).classList.remove("hidden"); }
function hide(id, force) {
  if (force === undefined) g(id).classList.add("hidden");
  else if (force) g(id).classList.add("hidden");
  else            g(id).classList.remove("hidden");
}
function axis(keys, a, b) { return (keys[a] || keys[b]) ? 1 : 0; }

function setStatus(who, msg) {
  g(who === "host" ? "host-status" : "join-status").textContent = msg;
}

// ─────────────────────────────────────────────────────────────────
//  START RENDER LOOP
// ─────────────────────────────────────────────────────────────────

requestAnimationFrame(loop);