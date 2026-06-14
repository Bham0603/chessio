<div align="center">

# ♞ Chess Assistant

### Real-time Stockfish analysis, overlaid live on Chess.com & Lichess

A **Manifest V3 Chrome extension** that scrapes the board straight from the page,
runs a bundled **Stockfish WASM** engine, and paints a mini-board, an evaluation
bar, and color-coded best-move arrows in an isolated Shadow DOM panel — with an
**adjustable engine strength** so the moves it suggests can match any rating, from
beginner to 3600.

<br/>

![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)
![Stockfish](https://img.shields.io/badge/Engine-Stockfish%2018%20Lite-2D2D2D?logo=lichess&logoColor=white)
![WASM](https://img.shields.io/badge/WebAssembly-enabled-654FF0?logo=webassembly&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6-F7DF1E?logo=javascript&logoColor=black)
![No Build](https://img.shields.io/badge/build%20step-none-success)
![No Servers](https://img.shields.io/badge/network-100%25%20offline-success)
![Sites](https://img.shields.io/badge/sites-Chess.com%20%7C%20Lichess-769656)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-Educational%20Use-orange)

</div>

---

## 📖 Table of Contents

- [What it is](#-what-it-is)
- [Features](#-features)
- [Screenshots / The Panel](#-the-panel)
- [How it works (architecture)](#-how-it-works)
- [Engine strength (Elo matching)](#-engine-strength-elo-matching)
- [Install & run](#-install--run)
- [Controls reference](#-controls-reference)
- [File structure](#-file-structure)
- [Customizing DOM selectors](#-customizing-dom-selectors)
- [Debugging](#-debugging)
- [Troubleshooting](#-troubleshooting)
- [Tech & conventions](#-tech--conventions)
- [Disclaimer & license](#-disclaimer--license)

---

## 🎯 What it is

Chess Assistant injects an analysis overlay into Chess.com and Lichess game pages.
It **reads the position directly from the DOM** (no screenshots, no APIs), converts
it to a FEN string, and feeds it to a Stockfish engine bundled with the extension.
The result — the best continuations and a numerical evaluation — is rendered as a
draggable panel that sits on top of the page.

> **There is no build step and no server.** The engine is committed under `engine/`
> and runs entirely on your machine via WebAssembly. You load the unpacked folder
> directly into Chrome.

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🔬 | **Live board scraping** | Reads piece positions from the Chess.com / Lichess DOM and rebuilds a FEN |
| 🐟 | **Local Stockfish engine** | Bundled Stockfish 18 Lite WASM — runs in a Web Worker, **100% offline** |
| 🎚️ | **Adjustable engine strength** | Dial the engine from **~250 Elo to Max (3600)** so suggestions match the opponent's level |
| 🎯 | **Top 3 moves** | `MultiPV=3` rendered as color-coded SVG arrows — 🟢 best · 🟡 2nd · 🟠 3rd |
| 📊 | **Evaluation bar** | Animated vertical bar showing the White ↔ Black advantage |
| ♟️ | **Live mini-board** | Mirrors the real position with automatic orientation detection |
| 👤 | **"My moves only" filter** | Only analyzes on *your* turn — never surfaces the opponent's best move |
| ⇅ | **Manual flip** | Override auto-detected orientation when it guesses wrong |
| 🧊 | **Shadow DOM UI** | Fully isolated styles — host-site CSS can't leak in, and vice-versa |
| 🖱️ | **Draggable panel** | Grab the header and move it anywhere on screen |
| ⌨️ | **Keyboard shortcut** | `Ctrl + Shift + A` toggles the panel |
| 🔎 | **Depth selector** | Search depth adjustable from 10 to 24 |

---

## 🖥️ The panel

```text
┌─────────────────────────────────────────────┐
│ ♞ Chess Assistant   [♟ Max ▾] [D18 ▾] ♟ ⇅ ─ ✕│  ← header / controls (draggable)
├──────┬──────────────────────────────────────┤
│ ▓    │  ┌────────────────────────┐           │
│ ▓    │  │   mini-board with        │          │
│ ▓    │  │   best-move arrows  ↗    │          │  ← body
│ █    │  │   🟢 🟡 🟠               │          │
│ █eval│  └────────────────────────┘           │
├──────┴──────────────────────────────────────┤
│ 1. Nf3  (+0.42)   2. e4  (+0.31)  ...         │  ← PV lines
│ ● Depth 18 — g1f3                             │  ← status
└─────────────────────────────────────────────┘
```

---

## 🏗️ How it works

The extension is split across four contexts because a Manifest V3 service worker
can't reliably host a WASM Web Worker — so the engine lives in a hidden **offscreen
document**.

```text
┌─ content.js ──────────────── (runs in the page) ───────────────────────┐
│  DOM scraper → extractFEN()        reads pieces, builds a FEN           │
│  MutationObserver + polling        detects when the position changes    │
│  Shadow DOM UI                     mini-board, eval bar, arrows, panel  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                    │  chrome.runtime.sendMessage
                                    │  { type:'ANALYZE_FEN', fen, depth, elo }
                                    ▼
┌─ background.js ──────────── (service worker) ──────────────────────────┐
│  Message router · creates & manages the offscreen document             │
└──────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─ offscreen.js ─────── (hidden offscreen document) ─────────────────────┐
│  Web Worker → engine/stockfish-18-lite-single.js  (speaks UCI)         │
│  position fen <FEN> → setoption … → go depth N → info … pv …           │
└──────────────────────────────────┬─────────────────────────────────────┘
                                    │  top-N PV lines + score
                                    ▼
                       routed back to content.js → UI
```

**Message types**

| Type | Direction | Purpose |
|---|---|---|
| `CONTENT_SCRIPT_READY` | content → background | Registers the tab; triggers eager engine init |
| `ANALYZE_FEN` | content → background → offscreen | Request analysis of a position (`fen`, `depth`, `elo`) |
| `ENGINE_PROGRESS` | offscreen → background → content | Live depth/score updates while searching |
| `ENGINE_RESULT` | offscreen → background → content | Final best move + top 3 PV lines |
| `ENGINE_READY` | offscreen → background → content | Engine finished loading |
| `STOP_ENGINE` | content → background → offscreen | Halt the current search |
| `TOGGLE_UI` | background → content | Show/hide the panel |

---

## 🎚️ Engine strength (Elo matching)

By default the engine plays at **full strength (≈3600)** — which produces inhumanly
perfect moves. The **Strength selector** (`♟` dropdown in the header) lets you dial
it down so the suggested moves reflect a *specific rating* instead.

Pick a target and `offscreen.js` maps it to a Stockfish **`Skill Level` (0–20)**:

| Target you pick | Skill Level |
|---|---|
| **Max** (3600) | 20 — full strength (default) |
| **2800** | 19 |
| **2400** | 17 |
| **2000** | 14 |
| **1600** | 11 |
| **1320** | 8 |
| **~1000 / ~800 / ~600 / ~400 / ~250** | 5 / 3 / 2 / 1 / 0 |

> **Why Skill Level and not `UCI_LimitStrength`/`UCI_Elo`?** Stockfish's official
> Elo limiter forces *single-PV* mode and, in this lite-single WASM build, can hang
> without ever returning a `bestmove` (the panel sticks on "Analyzing…"). `Skill
> Level` keeps normal MultiPV output and reliably returns a move, so it's the safe
> path for an overlay that must always respond.

Three extra touches make the lower levels robust and human-like:

- **Time-capped search.** Every search is bounded by `go depth N movetime T`
  (`searchTime()` ≈ 0.7–2s), so depth is an *upper bound*, not a fixed target. The
  engine always returns its best move within the budget — keeping the panel
  responsive on low-end / single-thread machines, where a complex mid/endgame
  position could otherwise take 30s+ to reach depth 18.
- **Shorter search at low levels.** Lower targets also cap the depth
  (`effectiveDepth()` → 8–12 plies) so the move reflects shallow, human-like
  calculation rather than deep engine vision.
- **Honest "chosen move" arrow.** A skill-limited engine's actual `bestmove` may
  differ from the top objective line, so the engine **promotes (or synthesizes) the
  line for the move it actually chose to rank 1** — the primary arrow always shows
  the level-appropriate move. (At Max strength this is a no-op.)
- **Watchdog.** If the engine ever goes silent, `content.js` retries automatically
  so the panel never gets permanently stuck.

The selector turns **yellow** whenever it's below Max, as a reminder that
suggestions are intentionally weakened.

> ⚠️ **Limitation:** Stockfish can't *truly* emulate sub-~1350 play — `Skill Level 0`
> floors around ~1350. The ~250–600 options push the engine as weak as it allows
> (clearly blundery, shallow moves) but are approximations of those bands, not exact
> reproductions.

---

## 🚀 Install & run

> **No `npm install` is needed.** The Stockfish engine is already committed under
> `engine/`, and there is no build step.

1. Clone or download this repository.
2. Open **`chrome://extensions`** in Chrome.
3. Toggle **Developer mode** ON (top-right).
4. Click **Load unpacked** and select this project folder.
5. The **Chess Assistant** icon appears in your toolbar.
6. Open a game on [chess.com](https://chess.com) or [lichess.org](https://lichess.org) —
   the panel appears in the top-right and starts analyzing automatically.

### 🔄 After editing any file

Content scripts **do not hot-reload**:

1. Click the **reload ↻** icon on the extension card in `chrome://extensions`.
2. **Hard-refresh** the Chess.com / Lichess tab with **`Ctrl + Shift + R`**.

---

## 🎛️ Controls reference

All controls live in the panel header.

| Control | ID | Default | What it does |
|---|---|---|---|
| **Strength** ▾ | `#ca-elo-select` | `Max` | Target engine Elo (~250 → 3600). See [Engine strength](#-engine-strength-elo-matching). Yellow when below Max. |
| **Depth** ▾ | `#ca-depth-select` | `D18` | Stockfish search depth (10–24) |
| **♟ My moves only** | `#ca-mymoves-btn` | **ON** (green) | Only analyze on your turn; show *"Opponent's turn — waiting"* otherwise |
| **⇅ Flip** | `#ca-flip-btn` | auto | Override the auto-detected board orientation / your side |
| **─ Minimize** | `#ca-minimize-btn` | — | Collapse the panel body |
| **✕ Close** | `#ca-close-btn` | — | Hide the panel (`Ctrl+Shift+A` to bring back) |

---

## 📁 File structure

```text
chessio/
├── manifest.json                     # MV3 manifest · CSP (wasm-unsafe-eval) · site match patterns
├── background.js                     # Service worker — message router, offscreen lifecycle
├── offscreen.html                    # Hidden document that hosts the WASM worker
├── offscreen.js                      # Stockfish UCI I/O, strength mapping, result building
├── content.js                        # ★ The bulk of the logic — scraping, FEN, all UI
├── ui.js                             # Placeholder module (UI is built inline in content.js)
├── diagnose.js                       # Standalone DOM-scraping diagnostic helper
├── styles.css                        # Shadow DOM panel styles
├── engine/
│   ├── stockfish-18-lite-single.js   # Stockfish WASM loader
│   └── stockfish-18-lite-single.wasm # Stockfish binary
├── icons/                            # 16 / 48 / 128 px extension icons
├── package.json                      # Metadata only — no real build/test scripts
├── CLAUDE.md                         # Contributor / agent guidance
└── README.md
```

---

## 🧩 Customizing DOM selectors

Chess-site DOM changes often — when scraping breaks, the fix is almost always in the
per-site config objects near the top of `content.js`.

### Chess.com

```javascript
const CHESSCOM_CONFIG = {
  boardSelector: 'wc-chess-board, chess-board, .board',
  pieceSelector: '.piece',
  pieceClassPattern: /\b([wb])([prnbqk])\b/,
  squareClassPattern: /\bsquare-(\d)(\d)\b/,
  isFlipped: (boardEl) => boardEl.classList.contains('flipped'),
};
```

### Lichess

```javascript
const LICHESS_CONFIG = {
  boardSelector: 'cg-board',
  pieceSelector: 'piece',
  colorClasses: { white: 'w', black: 'b' },
  typeClasses: { king: 'k', queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: 'p' },
  isFlipped: () => document.querySelector('.cg-wrap')?.classList.contains('orientation-black'),
};
```

### Adding a new site

1. Create a new config object (e.g. `CHESS24_CONFIG`).
2. Add an adapter function (e.g. `extractFEN_Chess24()`).
3. Register it in `detectSite()`.
4. Add the URL pattern to `manifest.json` under `content_scripts.matches`
   **and** `web_accessible_resources.matches`.

---

## 🐞 Debugging

| Where | How |
|---|---|
| **Content script logs** | Open DevTools on the Chess.com / Lichess tab |
| **Engine logs** | `chrome://extensions` → this extension → **inspect** the *offscreen document* |
| **Routing logs** | `chrome://extensions` → this extension → **inspect** the *service worker* |
| **FEN problems** | Run `extractFEN()` in the page console and compare to the real position |
| **Wrong arrows** | Usually `detectPlayerColor()` / flip handling — try the **⇅** button |

---

## 🔧 Troubleshooting

| Issue | Solution |
|---|---|
| Panel doesn't appear | Check the page DevTools console. The board may not have loaded yet — hard-refresh. |
| FEN is wrong | Run `extractFEN()` manually and compare with the known position. |
| Engine doesn't respond | Inspect the offscreen document's console (`chrome://extensions` → inspect). |
| WASM fails to load | Ensure `engine/` files exist and `wasm-unsafe-eval` is in the manifest CSP. |
| Arrows point the wrong way | Board is probably flipped — press **⇅** or verify `detectPlayerColor()`. |
| No analysis on your turn | The "my moves only" filter may be misreading whose turn it is — toggle **♟** off. |
| Suggestions feel "too perfect" | Lower the **Strength** selector to match your level. |
| Changes not showing | Reload the extension (↻) **and** hard-refresh the tab (`Ctrl+Shift+R`). |

---

## 🛠️ Tech & conventions

- **Plain ES5/ES6** in browser content-script scope — **no bundler, no imports, no
  runtime npm deps.** Keep everything in the existing files.
- The whole content script is wrapped in an **IIFE guarded by
  `window.__chessAssistantLoaded`** to avoid double-injection.
- UI lives in a **Shadow DOM** — query inside `shadowRoot`, not `document`, for panel
  elements.
- **Change detection** compares only the piece-placement field of the FEN
  (`fenPositionPart()`) so metadata-only changes don't re-trigger analysis.
- **Per-site config objects** isolate the brittle DOM selectors that break most often.

**Permissions** (`manifest.json`): `activeTab`, `scripting`, `offscreen`, `tabs`.
**CSP**: `script-src 'self' 'wasm-unsafe-eval'` (required to run the WASM engine).

---

## ⚖️ Disclaimer & license

> **For educational, training, and research purposes only.**
> Using a chess engine to receive move suggestions during **rated online games**
> violates the Terms of Service of Chess.com, Lichess, and other platforms, and will
> get your account banned. Use this against bots, in analysis, for study, or in your
> own offline games — not to cheat real opponents.

Released for **educational use**. The bundled Stockfish engine is licensed under the
**GNU GPL v3** — see the [Stockfish project](https://github.com/official-stockfish/Stockfish)
for details.

<div align="center">

---

Made with ♟️ &nbsp;·&nbsp; Powered by [Stockfish](https://stockfishchess.org/)

</div>
