# CLAUDE.md

Guidance for working in this repository.

## What this is

**Chess Assistant** — a Manifest V3 Chrome extension that overlays live Stockfish
analysis on **Chess.com** and **Lichess**. It scrapes the board from the page DOM,
sends a FEN to a bundled Stockfish WASM engine, and draws a mini-board, an
evaluation bar, and color-coded best-move arrows in an isolated Shadow DOM panel.

This is **not** an Electron app and has **no build step**. You load the unpacked
folder directly into Chrome.

## Run / reload

```
chrome://extensions  →  Developer mode ON  →  Load unpacked  →  select this folder
```

After editing any file, click the **reload ↻** icon on the extension card, then
**hard-refresh** the Chess.com / Lichess tab (Ctrl+Shift+R). Content scripts do
not hot-reload.

There is no `npm install` needed to run — the Stockfish engine is already
committed under `engine/`. `package.json` has no real build/test scripts.

## Architecture (message flow)

```
content.js  (runs in the page)
  ├─ DOM scraper → extractFEN()            reads pieces, builds FEN
  ├─ MutationObserver + polling            detects when the position changes
  └─ Shadow DOM UI                         mini-board, eval bar, arrows, panel
        │  chrome.runtime.sendMessage({ type:'ANALYZE', fen, depth })
        ▼
background.js  (service worker)
  └─ message router; creates/manages the offscreen document
        │
        ▼
offscreen.js  (hidden offscreen document — needed because SW can't run WASM/Workers well)
  └─ Web Worker → engine/stockfish-*.js (WASM)   speaks UCI
        │  position fen <FEN>  →  go depth N   →  info ... pv ...
        ▼
  results (top-N PV lines + score) routed back to content.js → UI
```

Why an offscreen document: MV3 service workers can't reliably host the Stockfish
Web Worker / WASM, so analysis lives in `offscreen.html` + `offscreen.js`.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, CSP (`wasm-unsafe-eval`), site match patterns |
| `content.js` | **The bulk of the logic** — scraping, FEN building, all UI rendering |
| `background.js` | Service worker; routes messages, manages offscreen lifecycle |
| `offscreen.js` / `offscreen.html` | Hosts the Stockfish Worker, UCI I/O |
| `engine/` | Bundled Stockfish WASM (`stockfish-18-lite-single.js`) |
| `styles.css` | Shadow DOM panel styles |
| `ui.js` | Placeholder module (UI is actually built inline in `content.js`) |
| `diagnose.js` | Standalone DOM-scraping diagnostic helper |

## Key concepts in content.js

- **Per-site config objects**: `CHESSCOM_CONFIG` and `LICHESS_CONFIG` near the top
  isolate DOM selectors and the `isFlipped()` detection for each site.
- **`detectSite()`** → `'chesscom' | 'lichess' | null` from the hostname.
- **`extractFEN()`** dispatches to `extractFEN_ChessCom()` / `extractFEN_Lichess()`,
  which build an 8×8 array and call `boardToFEN()`.
- **`detectActiveTurn()`** guesses whose move it is (used for the `w`/`b` field in
  the FEN). On Chess.com it counts move-list nodes; this is heuristic and fragile.
- **`detectPlayerColor()`** → `'white' | 'black'` from each site's flipped/orientation
  class. Drives mini-board orientation (`isFlipped = playerColor === 'black'`) and
  arrow flipping in `updateMiniBoard()` / `updateArrows()`.
- **Change detection**: `fenPositionPart()` compares only the piece-placement field
  so metadata-only changes don't re-trigger analysis.

## Conventions

- Plain ES5/ES6 in browser content-script scope — **no bundler, no imports, no npm
  deps at runtime**. Keep everything in the existing files.
- The whole content script is wrapped in an IIFE guarded by
  `window.__chessAssistantLoaded` to avoid double-injection.
- UI lives in a Shadow DOM so host-site CSS can't leak in. Query inside
  `shadowRoot`, not `document`, for panel elements.
- DOM selectors for chess sites are brittle and change often — when scraping
  breaks, the fix is almost always in the per-site `*_CONFIG` selectors.

## Debugging

- Content script logs: DevTools console on the Chess.com / Lichess tab.
- Engine logs: `chrome://extensions` → this extension → **inspect** the offscreen
  document (or the service worker for routing issues).
- FEN problems: run `extractFEN()` in the page console and compare to the real
  position. Wrong arrows usually means `detectPlayerColor()` / flip handling.

## Header controls (content.js)

- **Strength select** (`#ca-elo-select`, default "Max" = 3600/full) — sets the
  target engine strength via `engineElo`. Sent as `elo` in the `ANALYZE_FEN`
  message; `offscreen.js` translates it: `>=3190`/Max → full strength
  (`UCI_LimitStrength` off); `1320–3189` → `UCI_LimitStrength` on + `UCI_Elo`;
  `<1320` → weakened via `Skill Level` (0–19, mapped from ~200–1320). Lower
  targets also cap search depth (`effectiveDepth()`) for human-like shallow play.
  Because a strength-limited `bestmove` may differ from the top MultiPV line,
  `offscreen.js` promotes the line starting with `bestmove` to rank 1 so the
  primary arrow shows the level-appropriate move. Gets a yellow `.ca-elo-limited`
  tint when below Max.
- **Depth select** — Stockfish search depth (10–24).
- **♟ "My moves only"** (`#ca-mymoves-btn`, green when on, default ON) — toggles
  `myMovesOnly`. When on, `analyzeCurrentPosition()` only runs the engine while it
  is the user's turn; on the opponent's turn it clears arrows and shows
  "Opponent's turn — waiting".
- **⇅ Flip** (`#ca-flip-btn`) — sets `playerColorOverride` ('white'/'black'),
  overriding auto-detected orientation. `detectPlayerColor()` returns the override
  first. Re-renders board + arrows immediately via cached `lastLines`.

## Known weak spots (active areas)

- **Side-to-move detection**: `detectActiveTurn()` reads the page move list
  (max `data-ply`, with element-count fallbacks). It is still a heuristic — if it
  misfires, the "my moves only" filter can suppress analysis on the user's real
  turn. The fix is to turn the filter off (♟) or correct selectors per site.
- **Orientation auto-detect** still relies on site CSS classes; the ⇅ button is the
  manual escape hatch when it's wrong.
