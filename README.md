# 🎮 OVER HERE!
### Two-Player Cooperative Maze Escape · Built with Vite + PeerJS

```
  ██████╗ ██╗   ██╗███████╗██████╗      ██╗  ██╗███████╗██████╗ ███████╗██╗
 ██╔═══██╗██║   ██║██╔════╝██╔══██╗     ██║  ██║██╔════╝██╔══██╗██╔════╝██║
 ██║   ██║██║   ██║█████╗  ██████╔╝     ███████║█████╗  ██████╔╝█████╗  ██║
 ██║   ██║╚██╗ ██╔╝██╔══╝  ██╔══██╗     ██╔══██║██╔══╝  ██╔══██╗██╔══╝  ╚═╝
 ╚██████╔╝ ╚████╔╝ ███████╗██║  ██║     ██║  ██║███████╗██║  ██║███████╗██╗
  ╚═════╝   ╚═══╝  ╚══════╝╚═╝  ╚═╝     ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝
```

---

## What Is It?

**Over Here!** is a real-time, browser-based co-op game for exactly two players. One player is the **HOST (Viewer)** — they see the full neon maze, all the enemies, and the exit. The other is the **MOVER (Player)** — they're trapped inside with only a small circle of fog-of-war vision.

The Viewer must guide the Mover to the exit using **voice chat** and **click-to-Ping** markers, before the neon-red ghosts catch them.

---

## How to Play

| Step | Action |
|------|--------|
| **1** | **HOST** opens the game, clicks **Host Game**, and copies the Room ID |
| **2** | **MOVER** opens the game on a second device, clicks **Join Game**, and pastes the ID |
| **3** | Both screens transition simultaneously — the maze loads, voice chat connects |
| **4** | HOST guides with voice + click pings. MOVER navigates with WASD / Arrow Keys |
| **5** | Reach the glowing green exit portal to escape! |

> ⚠️ **Connection issues?** Try using a mobile hotspot — university and corporate firewalls often block WebRTC.

---

## Controls

```
MOVER          WASD  /  Arrow Keys  /  On-screen D-Pad (mobile)
HOST PING      Click anywhere on the map
PAUSE          ESC
LEAVE          Pause Menu → Leave Game
```

---

## Features

- 🌐 **P2P Networking** via PeerJS with STUN servers (Google ICE)
- 🎙 **Live Voice Chat** — WebRTC audio stream, auto-connected on join
- 👁 **Fog of War** — Mover sees only a small radius around themselves
- 🔔 **Click-to-Ping** — Host clicks the map to drop a ripple marker
- 👻 **Intelligent Ghost AI** — Aggro mode: ghosts sense and chase the Mover
- 📱 **Mobile D-Pad** — Touch controls auto-appear on mobile/tablet
- 🏆 **10 Levels** — Tutorial → tight corridors + 13 aggressive enemies
- 🎵 **Audio** — Looping BGM on menu, SFX for win, death, and pings

---

## Level Curve

| Levels | Enemies | AI Mode |
|--------|---------|---------|
| 1 | 0 | Tutorial — no threats |
| 2 | 1 | Slow patrol only |
| 3–5 | 3–5 | Aggro sensing enabled |
| 6–10 | 6–13 | Fast, tight mazes, full chaos |

---

## Stack

```
Vite          Dev server & bundler
PeerJS        WebRTC data + media connections
Canvas API    Procedural rendering (no sprites)
Web Audio     BGM + SFX via HTML5 Audio
```

---

## Setup

```bash
npm install
npm run dev
```

Place these audio files in `/public` before running:

```
/public/bgmusic.mp3   # Menu background music
/public/win.mp3       # Level complete SFX
/public/death.mp3     # Caught by ghost SFX
/public/ping.mp3      # Host ping SFX (optional)
```

---

## Tips for Hosts

- **Watch the Mover's cyan dot** — ping in front of where they're heading, not where they are
- **Aggro warning** — ghosts glow brighter and move faster when they've locked on
- **Loops are intentional** — mazes have multiple valid paths, so there's always an escape route

---

*Two players. One maze. No map. Good luck.*