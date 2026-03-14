/**
 * ═══════════════════════════════════════════════════════════════════
 *  OVER HERE! — main.js  v5  (cross-device final)
 *  Vite + PeerJS
 * ═══════════════════════════════════════════════════════════════════
 *
 *  WHAT'S NEW IN v5
 *  ─────────────────
 *  ✦ STUN servers → works on university / corporate Wi-Fi
 *  ✦ Running Man avatar: procedural stick-figure, animated limbs
 *  ✦ Mobile D-Pad: touch controls wired to same key-state object
 *  ✦ All bold-white text in HUD / overlays
 *  ✦ START_GAME handshake intact (no black screen)
 *  ✦ BGM stops on game start; win/death SFX fire on both clients
 *
 *  PACKET PROTOCOL  (Host → Mover)
 *  ─────────────────────────────────
 *   START_GAME  { maze, spawn, enemies, levelIdx }
 *   STATE       { player, enemies, pings, elapsed, appState }
 *   LOAD_LEVEL  { maze, spawn, enemies, levelIdx }
 *   EVENT       { evt: 'win'|'death'|'ping' }
 *
 *  PACKET PROTOCOL  (Mover → Host)
 *  ─────────────────────────────────
 *   INPUT       { keys }
 * ═══════════════════════════════════════════════════════════════════
 */

import Peer from "peerjs";

// ─────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────

const TILE   = 40;
const COLS   = 19;   // must be odd
const ROWS   = 15;   // must be odd
const MW     = COLS * TILE;   // 760
const MH     = ROWS * TILE;   // 600

const PLAYER_SPEED   = 185;
const PLAYER_R       = TILE * 0.34;
const ENEMY_R        = TILE * 0.38;
const ENEMY_BASE_SPD = 76;
const ENEMY_AGGRO_M  = 2.25;
const SENSE_R        = TILE * 3.9;
const FOG_R          = TILE * 3.5;
const INVU_MS        = 550;
const SPAWN_MIN_D    = TILE * 5;

const EXIT_C = COLS - 2;
const EXIT_R = ROWS - 2;
const EXIT_X = EXIT_C * TILE + TILE / 2;
const EXIT_Y = EXIT_R * TILE + TILE / 2;

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
//  ICE / STUN CONFIG  (university-Wi-Fi fix)
// ─────────────────────────────────────────────────────────────────

const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302"  },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────
//  SEEDED RNG
// ─────────────────────────────────────────────────────────────────

function rng32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────
//  MAZE (recursive backtracker + loop cuts)
// ─────────────────────────────────────────────────────────────────

function buildMaze(seed, extraLoops) {
  const rng  = rng32(seed);
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(1));
  const vis  = Array.from({ length: ROWS }, () => Array(COLS).fill(false));

  function carve(cx, cy) {
    vis[cy][cx]  = true;
    grid[cy][cx] = 0;
    const dirs = [[0,-2],[0,2],[-2,0],[2,0]].sort(() => rng() - 0.5);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx > 0 && nx < COLS-1 && ny > 0 && ny < ROWS-1 && !vis[ny][nx]) {
        grid[cy + dy/2][cx + dx/2] = 0;
        carve(nx, ny);
      }
    }
  }
  carve(1, 1);

  for (let i = 0; i < extraLoops; i++) {
    const x = Math.floor(rng() * (COLS - 2)) + 1;
    const y = Math.floor(rng() * (ROWS - 2)) + 1;
    if (grid[y][x] === 1) {
      let fn = 0;
      for (const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]])
        if (grid[y+dy]?.[x+dx] === 0) fn++;
      if (fn >= 2) grid[y][x] = 0;
    }
  }

  grid[1][1]           = 0;
  grid[ROWS-2][COLS-2] = 0;
  return grid;
}

// ─────────────────────────────────────────────────────────────────
//  LEVEL TABLE
// ─────────────────────────────────────────────────────────────────

const LEVELS = [
  { seed:2001, loops:12, enemies:0,  aggro:false }, // 1 Tutorial
  { seed:2002, loops:11, enemies:1,  aggro:false }, // 2
  { seed:2003, loops: 9, enemies:3,  aggro:true  }, // 3
  { seed:2004, loops: 8, enemies:4,  aggro:true  }, // 4
  { seed:2005, loops: 7, enemies:5,  aggro:true  }, // 5
  { seed:2006, loops: 6, enemies:6,  aggro:true  }, // 6
  { seed:2007, loops: 5, enemies:7,  aggro:true  }, // 7
  { seed:2008, loops: 4, enemies:9,  aggro:true  }, // 8
  { seed:2009, loops: 3, enemies:11, aggro:true  }, // 9
  { seed:2010, loops: 2, enemies:13, aggro:true  }, // 10
];

// ─────────────────────────────────────────────────────────────────
//  STATE ENUM
// ─────────────────────────────────────────────────────────────────

const GS = { MENU:"MENU", PLAYING:"PLAYING", PAUSED:"PAUSED",
             DANCING:"DANCING", WIN:"WIN", DEAD:"DEAD" };

// ─────────────────────────────────────────────────────────────────
//  RUNTIME
// ─────────────────────────────────────────────────────────────────

let gs         = GS.MENU;
let role       = null;          // "host" | "mover"
let levelIdx   = 0;

let maze       = null;
let player     = null;          // { x,y,vx,vy,angle,moving }
let enemies    = [];
let pings      = [];
let elapsed    = 0;
let invuUntil  = 0;
let danceTimer = 0;
let pingCtr    = 0;

// Unified input state (keyboard + D-Pad both write here)
const keys       = { up:false, down:false, left:false, right:false };
let   remoteKeys = { up:false, down:false, left:false, right:false };

// ─────────────────────────────────────────────────────────────────
//  KEYBOARD → unified keys
// ─────────────────────────────────────────────────────────────────

window.addEventListener("keydown", e => {
  if (e.code === "ArrowUp"    || e.code === "KeyW") keys.up    = true;
  if (e.code === "ArrowDown"  || e.code === "KeyS") keys.down  = true;
  if (e.code === "ArrowLeft"  || e.code === "KeyA") keys.left  = true;
  if (e.code === "ArrowRight" || e.code === "KeyD") keys.right = true;
  if (e.code === "Escape") onEsc();
});
window.addEventListener("keyup", e => {
  if (e.code === "ArrowUp"    || e.code === "KeyW") keys.up    = false;
  if (e.code === "ArrowDown"  || e.code === "KeyS") keys.down  = false;
  if (e.code === "ArrowLeft"  || e.code === "KeyA") keys.left  = false;
  if (e.code === "ArrowRight" || e.code === "KeyD") keys.right = false;
});

// ─────────────────────────────────────────────────────────────────
//  MOBILE D-PAD SETUP
//  Mounted after DOM is ready (called from initDPad())
// ─────────────────────────────────────────────────────────────────

function isTouchDevice() {
  return ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
}

function initDPad() {
  if (!isTouchDevice()) return;   // desktop — don't show D-Pad at all

  // D-Pad is shown only once we're in the game screen as Mover
  // (showDPad() called from goPlaying() when role === mover)

  const map = {
    "dp-up":    "up",
    "dp-down":  "down",
    "dp-left":  "left",
    "dp-right": "right",
  };

  Object.entries(map).forEach(([btnId, dir]) => {
    const el = g(btnId);

    const press = (e) => {
      e.preventDefault();
      keys[dir] = true;
      el.classList.add("pressed");
    };
    const release = (e) => {
      e.preventDefault();
      keys[dir] = false;
      el.classList.remove("pressed");
    };

    el.addEventListener("touchstart",  press,   { passive: false });
    el.addEventListener("touchend",    release, { passive: false });
    el.addEventListener("touchcancel", release, { passive: false });

    // Also wire mouse for hybrid devices
    el.addEventListener("mousedown", press);
    el.addEventListener("mouseup",   release);
    el.addEventListener("mouseleave",release);
  });
}

function showDPad() {
  if (isTouchDevice() && role === "mover") {
    g("dpad").classList.remove("hidden");
  }
}

// ─────────────────────────────────────────────────────────────────
//  AUDIO
// ─────────────────────────────────────────────────────────────────

const bgm    = new Audio("/bgmusic.mp3");
bgm.loop     = true;
bgm.volume   = 0.2;
let bgmOn    = false;

const sfxWin   = new Audio("/win.mp3");
const sfxDeath = new Audio("/death.mp3");
const sfxPing  = new Audio("/ping.mp3");   // optional

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

function playSfx(audio) {
  try {
    const c = audio.cloneNode();
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
//  PEERJS  (with STUN)
// ─────────────────────────────────────────────────────────────────

let peer       = null;
let dataConn   = null;
let mediaConn  = null;
let localStream = null;

function makeId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

async function getMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
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

  peer = new Peer(rid, PEER_CONFIG);

  peer.on("open", () => setStatus("host", "✅ Ready — share the Room ID above!"));

  peer.on("connection", dc => {
    dataConn = dc;
    setStatus("host", "🔗 Player connecting…");

    dc.on("open", () => {
      setStatus("host", "🎮 Connected! Sending level…");

      // Build level data, send START_GAME, THEN transition host to playing
      prepareLevel(levelIdx);

      dc.send({
        type:     "START_GAME",
        levelIdx: levelIdx,
        maze:     maze,
        spawn:    { x: player.x, y: player.y },
        enemies:  enemies.map(serEnemy),
      });

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

  peer = new Peer(undefined, PEER_CONFIG);

  peer.on("open", async () => {
    const stream = await getMic();
    dataConn = peer.connect(hostId, { reliable:true, serialization:"json" });

    dataConn.on("open", () => {
      setStatus("join", "✅ Connected! Waiting for level…");
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

    case "START_GAME":
      // ← critical: Mover gets maze + spawn, transitions immediately
      maze      = pkt.maze;
      levelIdx  = pkt.levelIdx ?? 0;
      enemies   = (pkt.enemies || []).map(deserEnemy);
      pings     = [];
      elapsed   = 0;
      player    = { x: pkt.spawn.x, y: pkt.spawn.y,
                    vx:0, vy:0, angle:0, moving:false };
      invuUntil  = performance.now() + INVU_MS;
      danceTimer = 0;
      updateHud();
      goPlaying();      // show canvas, stop BGM, show D-Pad if mobile
      break;

    case "STATE":
      if (pkt.player)  player  = pkt.player;
      if (pkt.enemies) enemies = pkt.enemies;
      if (pkt.pings)   pings   = pkt.pings;
      if (pkt.elapsed !== undefined) { elapsed = pkt.elapsed; updateTimer(elapsed); }
      if (pkt.appState && pkt.appState !== gs &&
          [GS.WIN, GS.DEAD, GS.DANCING].includes(pkt.appState)) {
        gs = pkt.appState;
        if (gs === GS.WIN) g("ov-win-time").textContent = `Escaped in ${fmt(elapsed)}`;
        syncOverlays();
      }
      break;

    case "LOAD_LEVEL":
      maze      = pkt.maze;
      levelIdx  = pkt.levelIdx ?? levelIdx;
      enemies   = (pkt.enemies || []).map(deserEnemy);
      pings     = [];
      elapsed   = 0;
      player    = { x: pkt.spawn.x, y: pkt.spawn.y,
                    vx:0, vy:0, angle:0, moving:false };
      invuUntil  = performance.now() + INVU_MS;
      danceTimer = 0;
      updateHud();
      gs = GS.PLAYING;
      syncOverlays();
      break;

    case "EVENT":
      if (pkt.evt === "win")   playSfx(sfxWin);
      if (pkt.evt === "death") playSfx(sfxDeath);
      if (pkt.evt === "ping")  playSfx(sfxPing);
      break;
  }
}

function serEnemy(e) {
  return { x:e.x, y:e.y, vx:e.vx, vy:e.vy,
           aggro:e.aggro, aggroEnabled:e.aggroEnabled,
           patrolPath:e.patrolPath, patrolIdx:e.patrolIdx };
}
function deserEnemy(e) { return { ...e }; }

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

function sendEvent(evt) {
  dataConn?.open && dataConn.send({ type:"EVENT", evt });
}

function sendLoadLevel() {
  dataConn?.open && dataConn.send({
    type:     "LOAD_LEVEL",
    levelIdx: levelIdx,
    maze:     maze,
    spawn:    { x: player.x, y: player.y },
    enemies:  enemies.map(serEnemy),
  });
}

// ─────────────────────────────────────────────────────────────────
//  LEVEL INIT  (Host-only; Mover gets via network)
// ─────────────────────────────────────────────────────────────────

function prepareLevel(idx) {
  const cfg = LEVELS[Math.min(idx, LEVELS.length - 1)];
  maze    = buildMaze(cfg.seed, cfg.loops);
  player  = { x: 1*TILE+TILE/2, y: 1*TILE+TILE/2,
               vx:0, vy:0, angle:0, moving:false };
  enemies = spawnEnemies(cfg.enemies, cfg.seed+8888, cfg.aggro);
  pings   = [];
  elapsed = 0;
  invuUntil  = performance.now() + INVU_MS;
  danceTimer = 0;
}

function spawnEnemies(count, seed, aggroEnabled) {
  const rng  = rng32(seed);
  const list = [];
  const px = player.x, py = player.y;
  const pool = [];

  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (maze[r][c] !== 0) continue;
    const ex = c*TILE+TILE/2, ey = r*TILE+TILE/2;
    if (Math.hypot(ex-px, ey-py) >= SPAWN_MIN_D) pool.push({ c, r, ex, ey });
  }

  for (let i = pool.length-1; i > 0; i--) {
    const j = Math.floor(rng()*(i+1));
    [pool[i],pool[j]] = [pool[j],pool[i]];
  }

  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const { c, r, ex, ey } = pool[i];
    list.push({ x:ex, y:ey, vx:0, vy:0,
                aggro:false, aggroEnabled,
                patrolPath: buildPatrol(c, r, rng32(seed+i*17)),
                patrolIdx: 0 });
  }
  return list;
}

function buildPatrol(sc, sr, rng) {
  const path = [{ c:sc, r:sr }];
  let c = sc, r = sr;
  for (let i = 0; i < 9; i++) {
    const dirs = [[0,-1],[0,1],[-1,0],[1,0]].sort(() => rng()-0.5);
    for (const [dc,dr] of dirs) {
      const nc = c+dc, nr = r+dr;
      if (nc>0 && nc<COLS-1 && nr>0 && nr<ROWS-1 && maze[nr]?.[nc]===0) {
        path.push({ c:nc, r:nr }); c=nc; r=nr; break;
      }
    }
  }
  return path;
}

// ─────────────────────────────────────────────────────────────────
//  SCREEN TRANSITIONS
// ─────────────────────────────────────────────────────────────────

function goPlaying() {
  stopBgm();
  showScreen("screen-game");
  g("h-role").textContent = role === "host" ? "HOST" : "MOVER";
  updateHud();
  gs = GS.PLAYING;
  syncOverlays();
  showDPad();   // shows D-Pad on Mover's touch device
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
  setHidden("ov-pause", gs !== GS.PAUSED);
  setHidden("ov-win",   gs !== GS.WIN);
  setHidden("ov-death", gs !== GS.DEAD);
}

// ─────────────────────────────────────────────────────────────────
//  PAUSE / LEAVE
// ─────────────────────────────────────────────────────────────────

function onEsc() {
  if      (gs === GS.PLAYING) { gs = GS.PAUSED;  syncOverlays(); }
  else if (gs === GS.PAUSED)  {
    gs = GS.PLAYING;
    prevTs = performance.now();
    syncOverlays();
  }
}

function leaveGame() {
  try { dataConn?.close(); }  catch(_){}
  try { mediaConn?.close(); } catch(_){}
  try { peer?.destroy(); }    catch(_){}
  location.reload();
}

["btn-leave-pause","btn-leave-win","btn-leave-death"].forEach(id =>
  g(id).addEventListener("click", leaveGame)
);

g("btn-resume").addEventListener("click", () => {
  if (gs !== GS.PAUSED) return;
  gs = GS.PLAYING;
  prevTs = performance.now();
  syncOverlays();
});

// ─────────────────────────────────────────────────────────────────
//  GAME LOOP
// ─────────────────────────────────────────────────────────────────

let prevTs = performance.now();

function loop(ts) {
  const dt = Math.min((ts - prevTs) / 1000, 0.05);
  prevTs = ts;

  if (gs === GS.PLAYING) {
    if (role === "host") { tick(dt); broadcastState(); }
    if (role === "mover" && dataConn?.open)
      dataConn.send({ type:"INPUT", keys: { ...keys } });
  }

  if (gs === GS.DANCING) {
    danceTimer += dt;
    if (danceTimer > 1.9) {
      gs = GS.WIN;
      g("ov-win-time").textContent = `Escaped in ${fmt(elapsed)}`;
      syncOverlays();
    }
    if (role === "host") broadcastState();
  }

  render();
  requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────────────────────────
//  PHYSICS  (Host-authoritative)
// ─────────────────────────────────────────────────────────────────

function tick(dt) {
  elapsed += dt;
  updateTimer(elapsed);

  const inp = remoteKeys;
  const lvlM = 1 + levelIdx * 0.09;

  const dx = (inp.right?1:0) - (inp.left?1:0);
  const dy = (inp.down?1:0)  - (inp.up?1:0);
  const dl = Math.hypot(dx,dy) || 1;
  const norm = (dx||dy) ? 1/dl : 0;

  player.vx     = dx * norm * PLAYER_SPEED;
  player.vy     = dy * norm * PLAYER_SPEED;
  player.moving = !!(dx || dy);
  if (dx || dy) player.angle = Math.atan2(dy, dx);

  player.x = slide(player.x, player.vx*dt, player.y, false);
  player.y = slide(player.y, player.vy*dt, player.x, true);

  for (const e of enemies) {
    const dist = Math.hypot(player.x-e.x, player.y-e.y);
    e.aggro = e.aggroEnabled && dist < SENSE_R;
    const spd = ENEMY_BASE_SPD * lvlM * (e.aggro ? ENEMY_AGGRO_M : 1);

    if (e.aggro) {
      const d = dist||1;
      e.vx = ((player.x-e.x)/d)*spd;
      e.vy = ((player.y-e.y)/d)*spd;
    } else {
      const pt = e.patrolPath?.[e.patrolIdx % (e.patrolPath?.length||1)];
      if (pt) {
        const tx = pt.c*TILE+TILE/2, ty = pt.r*TILE+TILE/2;
        const pd = Math.hypot(tx-e.x, ty-e.y);
        if (pd < 4) { e.patrolIdx=(e.patrolIdx+1)%e.patrolPath.length; }
        else { e.vx=((tx-e.x)/pd)*spd; e.vy=((ty-e.y)/pd)*spd; }
      }
    }
    e.x = slide(e.x, e.vx*dt, e.y, false);
    e.y = slide(e.y, e.vy*dt, e.x, true);
  }

  pings = pings.filter(p => elapsed - p.born < 2.3);

  // Win
  if (Math.hypot(player.x-EXIT_X, player.y-EXIT_Y) < TILE*0.62) {
    triggerWin(); return;
  }
  // Death
  if (performance.now() > invuUntil) {
    for (const e of enemies) {
      if (Math.hypot(player.x-e.x, player.y-e.y) < PLAYER_R+ENEMY_R) {
        triggerDeath(); return;
      }
    }
  }
}

function slide(pos, vel, cross, isY) {
  if (!vel) return pos;
  const next = pos + vel;
  const hr   = PLAYER_R * 0.86;
  const chk  = isY
    ? [[cross-hr+2,next-hr],[cross+hr-2,next-hr],[cross-hr+2,next+hr],[cross+hr-2,next+hr]]
    : [[next-hr,cross-hr+2],[next-hr,cross+hr-2],[next+hr,cross-hr+2],[next+hr,cross+hr-2]];
  for (const [wx,wy] of chk) if (solidAt(wx,wy)) return pos;
  return next;
}

function solidAt(wx, wy) {
  const c = Math.floor(wx/TILE), r = Math.floor(wy/TILE);
  if (c<0||c>=COLS||r<0||r>=ROWS) return true;
  return maze[r][c] === 1;
}

// ─────────────────────────────────────────────────────────────────
//  WIN / DEATH / NEXT / RETRY
// ─────────────────────────────────────────────────────────────────

function triggerWin() {
  if (gs===GS.WIN||gs===GS.DANCING) return;
  gs = GS.DANCING; danceTimer = 0;
  playSfx(sfxWin); sendEvent("win");
}
function triggerDeath() {
  if (gs===GS.DEAD) return;
  gs = GS.DEAD; syncOverlays();
  playSfx(sfxDeath); sendEvent("death");
}

g("btn-next").addEventListener("click", () => {
  if (role!=="host") return;
  levelIdx = Math.min(levelIdx+1, LEVELS.length-1);
  prepareLevel(levelIdx);
  updateHud(); gs=GS.PLAYING; syncOverlays();
  sendLoadLevel();
});

g("btn-retry").addEventListener("click", () => {
  if (role!=="host") return;
  prepareLevel(levelIdx);
  updateHud(); gs=GS.PLAYING; syncOverlays();
  sendLoadLevel();
});

// ─────────────────────────────────────────────────────────────────
//  HOST CLICK → PING
// ─────────────────────────────────────────────────────────────────

canvas.addEventListener("click", e => {
  if (role!=="host"||gs!==GS.PLAYING) return;
  const rect = canvas.getBoundingClientRect();
  const { ox,oy,sc } = hostTx();
  const mx = (e.clientX-rect.left-ox)/sc;
  const my = (e.clientY-rect.top -oy)/sc;
  if (mx<0||my<0||mx>MW||my>MH) return;
  pings.push({ x:mx, y:my, born:elapsed, id:pingCtr++ });
  playSfx(sfxPing);
  sendEvent("ping");
});

function hostTx() {
  const sc = Math.min(canvas.width/MW, canvas.height/MH);
  const ox = (canvas.width -MW*sc)/2;
  const oy = (canvas.height-MH*sc)/2;
  return { ox,oy,sc };
}

// ─────────────────────────────────────────────────────────────────
//  RENDERER
// ─────────────────────────────────────────────────────────────────

function render() {
  if (!maze||!player) return;
  const cw=canvas.width, ch=canvas.height;
  ctx.clearRect(0,0,cw,ch);

  if (role==="host") {
    const { ox,oy,sc } = hostTx();
    ctx.save();
    ctx.translate(ox,oy);
    ctx.scale(sc,sc);
    drawWorld();
    ctx.restore();
  } else {
    drawMoverView(cw,ch);
  }
}

function drawWorld() {
  ctx.fillStyle = CLR.bg;
  ctx.fillRect(0,0,MW,MH);

  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) {
    if (maze[r][c]===1) drawWall(c*TILE,r*TILE);
    else { ctx.fillStyle=CLR.floor; ctx.fillRect(c*TILE,r*TILE,TILE,TILE); }
  }

  drawExit();
  for (const p of pings)   drawPing(p);
  for (const e of enemies) drawGhost(e);
  drawRunningMan(player.x, player.y, player.angle,
                 player.moving, gs===GS.DANCING);
}

function drawMoverView(cw, ch) {
  const px=player.x, py=player.y;
  const ox=cw/2-px, oy=ch/2-py;

  ctx.save();
  ctx.translate(ox,oy);
  drawWorld();

  // Fog of war
  ctx.globalCompositeOperation = "destination-in";
  const fog = ctx.createRadialGradient(px,py,FOG_R*0.14, px,py,FOG_R);
  fog.addColorStop(0,    "rgba(0,0,0,1)");
  fog.addColorStop(0.72, "rgba(0,0,0,1)");
  fog.addColorStop(1,    "rgba(0,0,0,0)");
  ctx.fillStyle = fog;
  ctx.fillRect(-ox,-oy,cw,ch);

  ctx.globalCompositeOperation = "source-over";
  const dark = ctx.createRadialGradient(px,py,FOG_R*0.78, px,py,FOG_R*2.4);
  dark.addColorStop(0,"rgba(4,4,14,0)");
  dark.addColorStop(1,"rgba(4,4,14,1)");
  ctx.fillStyle = dark;
  ctx.fillRect(-ox,-oy,cw,ch);

  ctx.restore();
}

// ── Tiles / Exit / Ping / Ghost ───────────────────────────────────

function drawWall(x,y) {
  ctx.fillStyle = CLR.wall;
  ctx.fillRect(x,y,TILE,TILE);
  ctx.save();
  ctx.strokeStyle = CLR.wallGlow;
  ctx.lineWidth   = 1.6;
  ctx.shadowColor = CLR.wallGlow;
  ctx.shadowBlur  = 9;
  ctx.strokeRect(x+1.5,y+1.5,TILE-3,TILE-3);
  ctx.restore();
}

function drawExit() {
  const x=EXIT_C*TILE, y=EXIT_R*TILE;
  const pulse = 0.5+0.5*Math.sin(elapsed*3.2);
  ctx.save();
  ctx.shadowColor = CLR.exit; ctx.shadowBlur = 20+pulse*18;
  ctx.fillStyle   = `rgba(57,255,20,${0.1+pulse*0.22})`;
  ctx.fillRect(x+3,y+3,TILE-6,TILE-6);
  ctx.strokeStyle  = CLR.exit; ctx.lineWidth=2.5;
  ctx.strokeRect(x+4,y+4,TILE-8,TILE-8);
  ctx.fillStyle    = CLR.exit;
  ctx.font         = `bold ${TILE*0.5}px monospace`;
  ctx.textAlign    = "center"; ctx.textBaseline="middle";
  ctx.fillText("▶",x+TILE/2,y+TILE/2);
  ctx.restore();
}

function drawPing({ x,y,born }) {
  const prog = (elapsed-born)/2.3;
  if (prog>=1) return;
  ctx.save();
  for (let ring=0;ring<3;ring++) {
    const rp=(prog+ring*0.18)%1;
    ctx.beginPath();
    ctx.arc(x,y,rp*TILE*2.9,0,Math.PI*2);
    ctx.strokeStyle=`rgba(255,230,0,${(1-rp)*0.85})`;
    ctx.lineWidth  =2.8*(1-rp);
    ctx.shadowColor=CLR.ping; ctx.shadowBlur=12;
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(x,y,4.5,0,Math.PI*2);
  ctx.fillStyle=CLR.ping; ctx.shadowBlur=18; ctx.shadowColor=CLR.ping;
  ctx.fill(); ctx.restore();
}

function drawGhost(e) {
  const t=elapsed, gx=e.x, gy=e.y;
  const w=TILE*0.7, h=TILE*0.76;
  ctx.save();
  ctx.shadowColor=CLR.enemy;
  ctx.shadowBlur=e.aggro?32+10*Math.sin(t*9):14;
  ctx.fillStyle=e.aggro?"#ff0020":CLR.enemy;

  ctx.beginPath();
  ctx.arc(gx,gy-h*0.08,w/2,Math.PI,0);
  ctx.lineTo(gx+w/2,gy+h*0.42);
  for (let i=0;i<4;i++) {
    const wx1=gx+w/2-(w/4)*(i+0.5);
    const wx2=gx+w/2-(w/4)*(i+1);
    const wy=gy+h*0.42+(i%2===0?1:-1)*(TILE*0.12+0.07*Math.sin(t*5+i));
    ctx.quadraticCurveTo(wx1,wy,wx2,gy+h*0.42);
  }
  ctx.closePath(); ctx.fill();

  ctx.fillStyle="#fff"; ctx.shadowBlur=0;
  ctx.beginPath();
  ctx.arc(gx-w*0.19,gy-h*0.13,w*0.11,0,Math.PI*2);
  ctx.arc(gx+w*0.19,gy-h*0.13,w*0.11,0,Math.PI*2);
  ctx.fill();
  ctx.fillStyle=e.aggro?"#ff0000":"#110022";
  ctx.beginPath();
  ctx.arc(gx-w*0.19,gy-h*0.13,w*0.052,0,Math.PI*2);
  ctx.arc(gx+w*0.19,gy-h*0.13,w*0.052,0,Math.PI*2);
  ctx.fill();
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────
//  RUNNING MAN AVATAR
//  Procedural stick-figure in neon cyan.
//  When moving: limbs animate with Math.sin(Date.now()*0.015)*15
//  When facing left: flip via ctx.scale(-1,1)
// ─────────────────────────────────────────────────────────────────

function drawRunningMan(px, py, angle, moving, dancing) {
  const now   = Date.now();
  const t     = elapsed;

  // Limb swing angle (degrees → used directly in trig)
  const swing = moving ? Math.sin(now * 0.015) * 15 : 0;  // ±15°
  const swingR = (swing * Math.PI) / 180;

  // Scale factor for victory dance
  let scl = 1;
  let spin = 0;
  if (dancing) {
    scl  = 1 + 0.22 * Math.sin(danceTimer * 14);
    spin = danceTimer * 5.2;
  }

  // Facing direction: flip if moving/facing left
  const facingLeft = Math.cos(angle) < -0.1 && (moving || dancing);

  ctx.save();
  ctx.translate(px, py);
  if (spin)      ctx.rotate(spin);
  if (facingLeft) ctx.scale(-1, 1);
  if (scl !== 1) ctx.scale(scl, scl);

  const c = CLR.player;  // neon cyan

  ctx.strokeStyle = c;
  ctx.fillStyle   = c;
  ctx.lineCap     = "round";
  ctx.lineJoin    = "round";
  ctx.shadowColor = c;
  ctx.shadowBlur  = 14 + 5 * Math.sin(t * 4);

  const S = TILE * 0.22;  // base unit (~8-9 px at TILE=40)

  // ── Head ──
  ctx.beginPath();
  ctx.arc(0, -S * 3.6, S * 0.85, 0, Math.PI * 2);
  ctx.fill();

  // ── Torso ──
  ctx.lineWidth = S * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -S * 2.7);
  ctx.lineTo(0, -S * 0.4);
  ctx.stroke();

  // ── Arms ──
  // Upper arm pivot = shoulder at (0, -S*2.4)
  // Arm swing: front arm swings forward when right leg goes back
  const armSwing = swingR;
  ctx.lineWidth = S * 0.45;

  // Front arm
  ctx.beginPath();
  ctx.moveTo(0, -S * 2.4);
  ctx.lineTo(
    Math.sin(armSwing) * S * 1.6,
    -S * 2.4 + Math.cos(armSwing) * S * 1.6
  );
  ctx.stroke();

  // Back arm (opposite phase)
  ctx.beginPath();
  ctx.moveTo(0, -S * 2.4);
  ctx.lineTo(
    -Math.sin(armSwing) * S * 1.4,
    -S * 2.4 + Math.cos(armSwing) * S * 1.5
  );
  ctx.stroke();

  // ── Legs ──
  // Hip at (0, -S*0.4); thigh + shin with knee bend
  const legSwing  =  swingR;          // front leg
  const legSwingB = -swingR;          // back leg (opposite)

  function drawLeg(sw) {
    const hipX = 0, hipY = -S * 0.4;
    // Thigh
    const kneeX = Math.sin(sw) * S * 1.7;
    const kneeY = hipY + Math.cos(sw) * S * 1.7;
    // Shin — always hangs down-ish, knee-bend exaggerated while running
    const shinAngle = sw + (moving ? swingR * 0.6 : 0);
    const footX = kneeX + Math.sin(shinAngle) * S * 1.6;
    const footY = kneeY + Math.abs(Math.cos(shinAngle)) * S * 1.6;

    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(footX, footY);
    ctx.stroke();
  }

  ctx.lineWidth = S * 0.5;
  drawLeg(legSwing);
  drawLeg(legSwingB);

  // ── Victory sparkles ──
  if (dancing) {
    for (let i = 0; i < 7; i++) {
      const a   = (i/7)*Math.PI*2 + danceTimer*3.2;
      const rad = S * 4.5 + 4 * Math.sin(danceTimer * 9 + i);
      ctx.beginPath();
      ctx.arc(Math.cos(a)*rad, Math.sin(a)*rad, 3, 0, Math.PI*2);
      ctx.fillStyle   = `hsl(${(i*51+t*120)%360},100%,68%)`;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur  = 10;
      ctx.fill();
    }
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────
//  HUD
// ─────────────────────────────────────────────────────────────────

function updateTimer(s) { g("h-timer").textContent = fmt(s); }
function updateHud()    { g("h-level").textContent = levelIdx+1; updateTimer(elapsed); }
function fmt(s) {
  return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(Math.floor(s%60)).padStart(2,"0")}`;
}

// ─────────────────────────────────────────────────────────────────
//  MENU WIRING
// ─────────────────────────────────────────────────────────────────

g("btn-host").addEventListener("click", () => {
  startBgm();
  g("panel-host").classList.remove("hidden");
  g("panel-join").classList.add("hidden");
  initHost();
});

g("btn-join").addEventListener("click", () => {
  startBgm();
  g("panel-join").classList.remove("hidden");
  g("panel-host").classList.add("hidden");
});

g("btn-connect").addEventListener("click", () => {
  const id = g("room-id-input").value.trim().toUpperCase();
  if (!id) { setStatus("join","⚠ Enter a Room ID!"); return; }
  initMover(id);
});

g("room-id-input").addEventListener("keydown", e => {
  if (e.key==="Enter") g("btn-connect").click();
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

function g(id)      { return document.getElementById(id); }
function setHidden(id, v) { g(id).classList.toggle("hidden", v); }
function setStatus(who, msg) {
  g(who==="host"?"host-status":"join-status").textContent = msg;
}

// ─────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────

initDPad();                          // wire D-Pad touch events
requestAnimationFrame(loop);         // start render loop