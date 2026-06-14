# Chess Assistant — Chrome Extension

A Manifest V3 Chrome extension that provides real-time chess analysis with **Stockfish WASM** on Chess.com and Lichess. It injects a beautiful overlay UI with a mini-board, evaluation bar, and color-coded best-move arrows.

## Features

- **Live Board Scraping** — Reads piece positions from Chess.com and Lichess DOM
- **Stockfish Analysis** — Bundled WASM engine running in a Web Worker (no external servers)
- **Top 3 Moves** — MultiPV=3 with color-coded SVG arrows (🟢 Best, 🟡 2nd, 🟠 3rd)
- **Evaluation Bar** — Animated vertical bar showing White vs. Black advantage
- **Mini-Board** — Mirrors the live position with auto-orientation detection
- **Shadow DOM UI** — Completely isolated styles; no CSS conflicts with host sites
- **Draggable Panel** — Grab the header to move it anywhere on screen
- **Keyboard Shortcut** — `Ctrl+Shift+A` to toggle visibility
- **Depth Selector** — Adjustable from depth 10 to 24

## Architecture

```text
Content Script (content.js)
  ├── DOM Scraper → extractFEN()
  ├── MutationObserver → watches for moves
  └── Shadow DOM UI → mini-board, eval bar, arrows
         │
         │  chrome.runtime.sendMessage
         ▼
Background Service Worker (background.js)
  └── Routes messages, manages offscreen lifecycle
         │
         ▼
Offscreen Document (offscreen.js)
  └── Web Worker → Stockfish WASM (engine/)
         │
         │  UCI Protocol (position fen ... → go depth N)
         ▼
     Analysis Results (top 3 PV lines)
```

## Setup Instructions

### 1. Install Dependencies

```bash
cd c:\projects\chess
npm install
```

### 2. Bundle the Stockfish Engine

Copy the engine files from `node_modules` into the `engine/` directory:

```bash
mkdir engine
copy node_modules\stockfish\src\stockfish-nnue-16.js engine\
copy node_modules\stockfish\src\stockfish-nnue-16.wasm engine\
```

> **Note:** If the file names in the npm package differ, check `node_modules/stockfish/src/` and copy the appropriate `.js` and `.wasm` files. Update the path in `offscreen.js` accordingly.

### 3. Generate Extension Icons

You can use any chess-themed icon. Place PNG files at:

- `icons/icon16.png` (16×16)
- `icons/icon48.png` (48×48)
- `icons/icon128.png` (128×128)

### 4. Load the Extension in Chrome

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `c:\projects\chess` folder
5. The Chess Assistant icon appears in your toolbar

### 5. Use It

1. Navigate to a game on [chess.com](https://chess.com) or [lichess.org](https://lichess.org)
2. The overlay panel appears in the top-right corner
3. The engine starts analyzing automatically when pieces move
4. Press `Ctrl+Shift+A` to toggle the panel

## Customizing DOM Selectors

The DOM selectors for each chess site are isolated in configuration objects at the top of `content.js`:

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

### Adding a New Site

1. Create a new config object (e.g., `CHESS24_CONFIG`)
2. Add an adapter function (e.g., `extractFEN_Chess24()`)
3. Add the site detection in `detectSite()`
4. Add the URL pattern in `manifest.json` under `content_scripts.matches`

## Troubleshooting

| Issue                  | Solution                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Panel doesn't appear   | Check DevTools console for errors. The board may not have loaded yet.                 |
| FEN is wrong           | Open DevTools, run `extractFEN()` manually, compare with known position.              |
| Engine doesn't respond | Check the offscreen document's console (chrome://extensions → inspect offscreen).     |
| WASM fails to load     | Ensure `engine/` files exist and `wasm-unsafe-eval` is in the manifest CSP.           |
| Arrows point wrong     | Board may be flipped — check `detectPlayerColor()` returns correctly.                 |

## File Structure

```text
chess/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker — message router
├── offscreen.html         # Hidden document for WASM worker
├── offscreen.js           # Stockfish UCI communication
├── content.js             # DOM scraper + UI injector
├── ui.js                  # UI module (placeholder)
├── styles.css             # Shadow DOM styles
├── engine/
│   ├── stockfish-nnue-16.js    # Stockfish WASM loader
│   └── stockfish-nnue-16.wasm  # Stockfish binary
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── package.json
└── README.md
```

## License

This project is for educational and analysis purposes only. Using chess engines during rated online games violates the terms of service of chess platforms.
