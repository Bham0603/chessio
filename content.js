// =============================================================================
// content.js — Content Script (Chess.com & Lichess DOM Scraper + UI Injector)
// =============================================================================
// This content script is injected into chess.com and lichess.org pages.
// It performs three main tasks:
//   1. Detects the chess site and scrapes the board state into FEN notation
//   2. Watches for board changes via MutationObserver
//   3. Injects the Shadow DOM UI overlay and feeds it engine results
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │  HOW TO CUSTOMIZE FOR OTHER CHESS SITES                                   │
// │                                                                           │
// │  1. Add a new site config object (like CHESSCOM_CONFIG or LICHESS_CONFIG) │
// │  2. Implement an adapter function (like extractFEN_ChessCom)              │
// │  3. Add the site detection logic in detectSite()                          │
// │  4. Update manifest.json with the new site's URL pattern                  │
// └─────────────────────────────────────────────────────────────────────────────┘
// =============================================================================

(function () {
  'use strict';

  // Prevent double-injection
  if (window.__chessAssistantLoaded) return;
  window.__chessAssistantLoaded = true;

  // ===========================================================================
  // CONFIGURATION — Site-specific DOM selectors
  // ===========================================================================
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │  MODIFY THESE SELECTORS when the chess site updates their DOM.         │
  // │  Each config object maps CSS selectors to board concepts.              │
  // └─────────────────────────────────────────────────────────────────────────┘

  /**
   * Chess.com Configuration
   *
   * Chess.com uses a <wc-chess-board> or <chess-board> custom element.
   * Pieces are <div> elements with two key CSS classes:
   *   - Piece identity: two-letter code like "wp" (white pawn), "bk" (black king)
   *   - Square position: "square-XY" where X=file(1-8) and Y=rank(1-8)
   *
   * Example piece element:
   *   <div class="piece wp square-14" style="..."></div>
   *   → White pawn on d1 (file 1, rank 4... wait, square-14 = file 1, rank 4 → a4)
   *
   * The "square-XY" class encodes:
   *   X = file number (1=a, 2=b, ..., 8=h)
   *   Y = rank number (1-8, from White's perspective)
   */
  const CHESSCOM_CONFIG = {
    // The board container element
    boardSelector: 'wc-chess-board, chess-board, .board',

    // Individual piece elements within the board
    pieceSelector: '.piece',

    // Regex to extract piece type from class list (case-insensitive)
    // Matches: wp, wn, wb, wr, wq, wk, bp, bn, bb, br, bq, bk (any case)
    pieceClassPattern: /\b([wb])([prnbqk])\b/i,

    // Regex to extract square coordinates from class list
    // Matches: square-11 through square-88
    squareClassPattern: /\bsquare-(\d)(\d)\b/,

    // How to detect if the board is flipped (Black's perspective)
    // Chess.com adds a "flipped" class to the board element
    isFlipped: (boardEl) => {
      return boardEl.classList.contains('flipped');
    },
  };

  /**
   * Lichess Configuration
   *
   * Lichess uses the Chessground library with a <cg-board> element.
   * Pieces are <piece> elements with semantic CSS classes:
   *   - Color: "white" or "black"
   *   - Type: "king", "queen", "rook", "bishop", "knight", "pawn"
   *
   * Positioning is done via CSS transform on each piece element:
   *   transform: translate(X, Y)
   * where X and Y are percentages or pixel values mapping to board squares.
   *
   * Example piece element:
   *   <piece class="white king" style="transform: translate(400%, 0%)"></piece>
   *   → White king, position depends on board dimensions
   *
   * Square size is typically 12.5% of board width (100% / 8 = 12.5%)
   */
  const LICHESS_CONFIG = {
    // The board container element
    boardSelector: 'cg-board',

    // Individual piece elements
    pieceSelector: 'piece',

    // Map Lichess color class names to FEN color codes
    colorClasses: {
      white: 'w',
      black: 'b',
    },

    // Map Lichess piece type class names to FEN piece codes
    typeClasses: {
      king: 'k',
      queen: 'q',
      rook: 'r',
      bishop: 'b',
      knight: 'n',
      pawn: 'p',
    },

    // How to detect if the board is flipped
    // Lichess adds "orientation-black" class to a parent container
    isFlipped: () => {
      const container = document.querySelector('.cg-wrap');
      if (container) {
        return container.classList.contains('orientation-black');
      }
      return false;
    },
  };

  // ===========================================================================
  // SITE DETECTION
  // ===========================================================================

  /**
   * Detect which chess site we're on based on the hostname.
   * @returns {"chesscom"|"lichess"|null}
   */
  function detectSite() {
    const host = window.location.hostname;

    if (host.includes('chess.com')) return 'chesscom';
    if (host.includes('lichess.org')) return 'lichess';

    // ┌───────────────────────────────────────────────────────────────────────┐
    // │  ADD NEW SITES HERE:                                                 │
    // │  if (host.includes('chess24.com')) return 'chess24';                  │
    // └───────────────────────────────────────────────────────────────────────┘

    return null;
  }

  // ===========================================================================
  // FEN EXTRACTION — Chess.com
  // ===========================================================================

  /**
   * Extract the board position from Chess.com's DOM and return a FEN string.
   *
   * @returns {string|null} FEN string or null if board not found
   *
   * How it works:
   *   1. Find the board container (<wc-chess-board> or <chess-board>)
   *   2. Query all piece elements (.piece)
   *   3. For each piece, extract:
   *      - The piece type from its CSS classes (e.g., "wp" → white pawn)
   *      - The square from its "square-XY" class (e.g., "square-15" → a5)
   *   4. Build an 8x8 grid and convert to FEN notation
   */
  /**
   * Find all piece elements on Chess.com by searching multiple DOM locations.
   * Chess.com's <wc-chess-board> may place .piece elements in the light DOM,
   * inside a shadow root, or as deeply nested children.
   *
   * @param {Element} boardEl - The board container element
   * @returns {NodeList|Array} Collection of piece elements
   */
  function findChessComPieces(boardEl) {
    let pieces;

    // Strategy 1: Query the board element's light DOM directly
    pieces = boardEl.querySelectorAll('.piece');
    if (pieces.length > 0) {
      return pieces;
    }

    // Strategy 2: Query inside the shadow root (if open)
    if (boardEl.shadowRoot) {
      pieces = boardEl.shadowRoot.querySelectorAll('.piece');
      if (pieces.length > 0) {
        return pieces;
      }
    }

    // Strategy 3: Search globally on the document
    pieces = document.querySelectorAll('.piece');
    if (pieces.length > 0) {
      return pieces;
    }

    // Strategy 4: Try alternative selectors
    pieces = document.querySelectorAll('[class*="piece"][class*="square-"]');
    if (pieces.length > 0) {
      return pieces;
    }

    return [];
  }

  /** Flag to log piece debug info once */
  let _pieceDebugLogged = false;

  /**
   * Extract the board position from Chess.com's DOM and return a FEN string.
   */
  function extractFEN_ChessCom() {
    const config = CHESSCOM_CONFIG;
    const boardEl = document.querySelector(config.boardSelector);
    if (!boardEl) {
      console.warn('[Chess Assistant] Board element not found');
      return null;
    }

    // Initialize empty 8x8 board (rank 8 at index 0, rank 1 at index 7)
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));

    // Find pieces using multiple search strategies
    const pieces = findChessComPieces(boardEl);
    if (pieces.length === 0) {
      console.warn('[Chess Assistant] No pieces found');
      return null;
    }

    // Debug: log ALL piece class names once so we can diagnose detection issues
    if (!_pieceDebugLogged) {
      _pieceDebugLogged = true;
      console.log('[Chess Assistant] DEBUG — Found', pieces.length, 'piece elements:');
      for (let i = 0; i < pieces.length; i++) {
        const el = pieces[i];
        console.log(`  [${i}] tag=${el.tagName} class="${el.className}" style="${el.style.cssText.substring(0, 80)}"`);
      }
    }

    let placedCount = 0;

    for (const pieceEl of pieces) {
      const classList = pieceEl.className;

      // === Extract piece identity ===
      // Try the standard pattern first (case-insensitive): wp, bk, etc.
      let color = null;
      let type = null;

      const pieceMatch = classList.match(config.pieceClassPattern);
      if (pieceMatch) {
        color = pieceMatch[1].toLowerCase(); // 'w' or 'b'
        type = pieceMatch[2].toLowerCase();  // 'p', 'r', 'n', 'b', 'q', 'k'
      }

      // Fallback: check data-piece attribute (e.g., data-piece="wK" or "bP")
      if (!color || !type) {
        const dataPiece = pieceEl.getAttribute('data-piece') || pieceEl.dataset?.piece;
        if (dataPiece && dataPiece.length >= 2) {
          const dp = dataPiece.toLowerCase();
          if ((dp[0] === 'w' || dp[0] === 'b') && 'prnbqk'.includes(dp[1])) {
            color = dp[0];
            type = dp[1];
          }
        }
      }

      if (!color || !type) continue;

      // === Extract square position ===
      let file = -1, rank = -1;

      // Method 1: "square-XY" class (e.g., "square-14" → file 1, rank 4)
      const squareMatch = classList.match(config.squareClassPattern);
      if (squareMatch) {
        file = parseInt(squareMatch[1], 10) - 1; // 0-indexed (0=a, 7=h)
        rank = parseInt(squareMatch[2], 10) - 1; // 0-indexed (0=rank1, 7=rank8)
      }

      // Method 2: CSS transform fallback — translate(X%, Y%) or translate3d
      if (file < 0 || rank < 0) {
        const transform = pieceEl.style.transform || '';
        const cssText = pieceEl.style.cssText || '';
        const src = transform || cssText;
        if (src) {
          const txMatch = src.match(
            /translate(?:3d)?\(\s*([\d.]+)%\s*,\s*([\d.]+)%/
          );
          if (txMatch) {
            file = Math.round(parseFloat(txMatch[1]) / 12.5);
            rank = 7 - Math.round(parseFloat(txMatch[2]) / 12.5);
          }
        }
      }

      // Method 3: CSS left/top percentage fallback
      if (file < 0 || rank < 0) {
        const left = parseFloat(pieceEl.style.left);
        const top = parseFloat(pieceEl.style.top);
        if (!isNaN(left) && !isNaN(top)) {
          file = Math.round(left / 12.5);
          rank = 7 - Math.round(top / 12.5);
        }
      }

      if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;

      // Place piece on the board
      const row = 7 - rank;
      const col = file;

      const fenChar = color === 'w' ? type.toUpperCase() : type.toLowerCase();
      board[row][col] = fenChar;
      placedCount++;
    }

    if (placedCount === 0) {
      console.warn('[Chess Assistant] Found piece elements but could not place any');
      return null;
    }

    return boardToFEN(board);
  }

  // ===========================================================================
  // FEN EXTRACTION — Lichess
  // ===========================================================================

  /**
   * Extract the board position from Lichess's DOM and return a FEN string.
   *
   * @returns {string|null} FEN string or null if board not found
   *
   * How it works:
   *   1. Find the Chessground board container (<cg-board>)
   *   2. Query all <piece> elements
   *   3. For each piece:
   *      - Determine color from "white"/"black" class
   *      - Determine type from "king"/"queen"/etc. class
   *      - Calculate square from CSS transform: translate(X, Y)
   *        where each square = 12.5% (or 1/8 of the board)
   *   4. Build an 8x8 grid and convert to FEN notation
   */
  function extractFEN_Lichess() {
    const config = LICHESS_CONFIG;
    const boardEl = document.querySelector(config.boardSelector);
    if (!boardEl) return null;

    // Initialize empty 8x8 board
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));

    // Get board dimensions for coordinate calculation
    const boardRect = boardEl.getBoundingClientRect();
    const squareWidth = boardRect.width / 8;
    const squareHeight = boardRect.height / 8;

    if (squareWidth === 0 || squareHeight === 0) return null;

    const isFlipped = config.isFlipped();

    // Query all piece elements
    const pieces = boardEl.querySelectorAll(config.pieceSelector);
    if (pieces.length === 0) return null;

    for (const pieceEl of pieces) {
      // Skip ghost/phantom pieces (used during drag animations)
      if (pieceEl.classList.contains('ghost') || pieceEl.cgDragging) continue;

      // Determine piece color
      let color = null;
      for (const [className, code] of Object.entries(config.colorClasses)) {
        if (pieceEl.classList.contains(className)) {
          color = code;
          break;
        }
      }
      if (!color) continue;

      // Determine piece type
      let type = null;
      for (const [className, code] of Object.entries(config.typeClasses)) {
        if (pieceEl.classList.contains(className)) {
          type = code;
          break;
        }
      }
      if (!type) continue;

      // Calculate square from CSS transform
      const transform = pieceEl.style.transform;
      if (!transform) continue;

      // Parse transform: translate(Xpx, Ypx) or translate(X%, Y%)
      const translateMatch = transform.match(
        /translate\(\s*(-?[\d.]+)(px|%)\s*,\s*(-?[\d.]+)(px|%)\s*\)/
      );
      if (!translateMatch) continue;

      let xVal = parseFloat(translateMatch[1]);
      let yVal = parseFloat(translateMatch[3]);
      const xUnit = translateMatch[2];
      const yUnit = translateMatch[4];

      // Convert to file/rank indices
      let file, rank;

      if (xUnit === '%') {
        // Percentage-based positioning (each square = 12.5%)
        file = Math.round(xVal / 12.5);
        rank = Math.round(yVal / 12.5);
      } else {
        // Pixel-based positioning
        file = Math.round(xVal / squareWidth);
        rank = Math.round(yVal / squareHeight);
      }

      // If board is flipped, invert coordinates
      if (isFlipped) {
        file = 7 - file;
        rank = 7 - rank;
      }

      // Clamp to valid range
      file = Math.max(0, Math.min(7, file));
      rank = Math.max(0, Math.min(7, rank));

      // In Lichess (non-flipped): rank 0 in transform = rank 8 on board
      // Board array: row 0 = rank 8
      const row = rank;
      const col = file;

      const fenChar = color === 'w' ? type.toUpperCase() : type.toLowerCase();
      board[row][col] = fenChar;
    }

    return boardToFEN(board);
  }

  // ===========================================================================
  // FEN CONVERSION UTILITY
  // ===========================================================================

  /**
   * Detect whose turn it is from the page's move list.
   *
   * Plies are 1-indexed: ply 1 = White's first move, ply 2 = Black's reply, …
   * After the highest completed ply P, the side to move is White when P is even
   * and Black when P is odd. Using the MAX ply (rather than counting elements)
   * is robust against duplicate/variation nodes that would corrupt a raw count.
   *
   * @returns {'w'|'b'} Active color
   */
  function detectActiveTurn() {
    try {
      // 1) Most reliable: explicit ply numbers (Chess.com + Lichess both expose
      //    data-ply on move nodes). Take the largest one.
      let maxPly = 0;
      document.querySelectorAll('[data-ply]').forEach((el) => {
        const ply = parseInt(el.getAttribute('data-ply'), 10);
        if (!isNaN(ply) && ply > maxPly) maxPly = ply;
      });
      if (maxPly > 0) {
        return maxPly % 2 === 0 ? 'w' : 'b';
      }

      // 2) Fallback: count individual move nodes (one selector at a time so we
      //    never double-count an element that matches several selectors).
      const moveSelectors = [
        '.main-line-ply',        // Chess.com
        '.move-text-component',  // Chess.com (older)
        'kwdb',                  // Lichess move SAN tags
        'l4x move, .tview2 move',// Lichess move list
      ];
      for (const sel of moveSelectors) {
        const count = document.querySelectorAll(sel).length;
        if (count > 0) {
          return count % 2 === 0 ? 'w' : 'b';
        }
      }

      // 3) No moves played yet → White to move.
    } catch (e) {
      // If anything fails, default to white.
    }
    return 'w';
  }

  /**
   * Convert an 8x8 board array to a FEN position string.
   *
   * @param {Array<Array<string|null>>} board - 8x8 array, row 0 = rank 8
   * @returns {string} Complete FEN string
   */
  function boardToFEN(board) {
    const ranks = [];

    for (let row = 0; row < 8; row++) {
      let rankStr = '';
      let emptyCount = 0;

      for (let col = 0; col < 8; col++) {
        if (board[row][col] === null) {
          emptyCount++;
        } else {
          if (emptyCount > 0) {
            rankStr += emptyCount;
            emptyCount = 0;
          }
          rankStr += board[row][col];
        }
      }

      if (emptyCount > 0) {
        rankStr += emptyCount;
      }

      ranks.push(rankStr);
    }

    // Join ranks with '/' and append metadata
    // Try to detect active color; default others to safe values
    const position = ranks.join('/');
    const activeColor = detectActiveTurn();
    return `${position} ${activeColor} KQkq - 0 1`;
  }

  // ===========================================================================
  // MAIN DISPATCHER — extractFEN()
  // ===========================================================================

  /**
   * Extract the current board position as a FEN string.
   * Dispatches to the correct site-specific adapter.
   *
   * @returns {string|null} FEN string or null if extraction failed
   */
  function extractFEN() {
    const site = detectSite();

    switch (site) {
      case 'chesscom':
        return extractFEN_ChessCom();
      case 'lichess':
        return extractFEN_Lichess();

      // ┌─────────────────────────────────────────────────────────────────────┐
      // │  ADD NEW SITE ADAPTERS HERE:                                       │
      // │  case 'chess24':                                                    │
      // │    return extractFEN_Chess24();                                      │
      // └─────────────────────────────────────────────────────────────────────┘

      default:
        console.warn('[Chess Assistant] Unsupported chess site:', window.location.hostname);
        return null;
    }
  }

  // ===========================================================================
  // BOARD ORIENTATION DETECTION
  // ===========================================================================

  /**
   * Detect which color the user is playing (for flipping the mini-board).
   * @returns {"white"|"black"}
   */
  function detectPlayerColor() {
    // Manual flip button takes precedence over auto-detection.
    if (playerColorOverride) return playerColorOverride;

    const site = detectSite();

    if (site === 'chesscom') {
      const boardEl = document.querySelector(CHESSCOM_CONFIG.boardSelector);
      if (boardEl) {
        // Check the board element itself and its shadow root for the flipped class
        const searchRoot = boardEl.shadowRoot || boardEl;
        if (CHESSCOM_CONFIG.isFlipped(boardEl) ||
            (boardEl.shadowRoot && searchRoot.querySelector('.board.flipped'))) {
          return 'black';
        }
      }
    }

    if (site === 'lichess') {
      if (LICHESS_CONFIG.isFlipped()) {
        return 'black';
      }
    }

    return 'white';
  }

  // ===========================================================================
  // MUTATION OBSERVER — Watch for board changes
  // ===========================================================================

  let debounceTimer = null;
  let lastFEN = null;
  let analysisDepth = 18; // Default analysis depth
  let pollingInterval = null;

  // engineElo: target Stockfish strength. 3600 = full strength (default). Lower
  // values make the engine recommend level-appropriate moves (e.g. set ~300 to
  // get moves a ~300-rated player would play) instead of perfect 3600 lines.
  let engineElo = 3600;

  // Watchdog: searches are time-bounded in the engine (≤~2s), so a result should
  // always arrive quickly. If the engine genuinely goes silent (no progress and
  // no result) for ANALYSIS_TIMEOUT_MS, nudge it — but only a few times, then give
  // up gracefully instead of looping forever (which would peg a low-end CPU).
  let analysisWatchdog = null;
  let watchdogRetries = 0;
  const ANALYSIS_TIMEOUT_MS = 7000;
  const MAX_WATCHDOG_RETRIES = 2;

  function armWatchdog(fen, isRetry) {
    clearTimeout(analysisWatchdog);
    if (!isRetry) watchdogRetries = 0; // fresh search (or live progress) resets
    analysisWatchdog = setTimeout(() => {
      const ui = window.__chessAssistantUI;
      if (watchdogRetries >= MAX_WATCHDOG_RETRIES) {
        // Stop hammering the engine — show the last state and wait for the next move.
        if (ui) ui.setStatus('Engine busy — try a lower depth', false);
        console.warn('[Chess Assistant] Engine still silent — giving up retries');
        return;
      }
      watchdogRetries++;
      if (ui) ui.setStatus('Engine slow — retrying…', true);
      console.warn(`[Chess Assistant] Engine silent — retry ${watchdogRetries}/${MAX_WATCHDOG_RETRIES}`);
      chrome.runtime.sendMessage({ type: 'STOP_ENGINE' });
      chrome.runtime.sendMessage({
        type: 'ANALYZE_FEN', fen, depth: analysisDepth, elo: engineElo,
      });
      armWatchdog(fen, true); // keep watching, preserving the retry count
    }, ANALYSIS_TIMEOUT_MS);
  }

  // ── User-facing orientation / move-filter state ─────────────────────────────
  // playerColorOverride: null = auto-detect from the site; otherwise force
  //   'white' | 'black'. Set by the manual flip button when auto-detection is
  //   wrong (or the user just wants the other perspective).
  let playerColorOverride = null;
  // myMovesOnly: when true, only analyze and draw arrows while it is the user's
  //   own turn. Stops the engine from suggesting the opponent's best moves.
  let myMovesOnly = true;
  // Cache of the most recent engine PV lines so we can re-render arrows when the
  // user flips the board without waiting for a fresh analysis.
  let lastLines = null;

  /**
   * Compare only the piece-placement portion of two FEN strings.
   * This avoids false negatives from metadata differences (turn, castling, etc.)
   */
  function fenPositionPart(fen) {
    return fen ? fen.split(' ')[0] : '';
  }

  /**
   * Process a newly detected position: update the UI and trigger engine analysis.
   */
  function processNewPosition(fen) {
    // Only re-analyze if the piece placement actually changed
    if (fenPositionPart(fen) === fenPositionPart(lastFEN)) return;
    lastFEN = fen;

    console.log('[Chess Assistant] New position detected:', fen);
    analyzeCurrentPosition();
  }

  /**
   * Render the current position (lastFEN) and either trigger analysis or, when
   * "my moves only" is on and it is the opponent's turn, show a waiting state.
   * Safe to call repeatedly (e.g. after the user flips the board or toggles the
   * move filter) — it does not depend on the position having changed.
   */
  function analyzeCurrentPosition() {
    const fen = lastFEN;
    if (!fen || !window.__chessAssistantUI) return;

    const ui = window.__chessAssistantUI;
    const playerColor = detectPlayerColor();

    // Always reflect the live position on the mini-board.
    ui.updateBoard(fen, playerColor);

    // Whose move is it? The active-color field of the FEN we built.
    const activeColor = fen.split(' ')[1] === 'b' ? 'black' : 'white';
    const isMyTurn = activeColor === playerColor;

    // When the filter is on and it's the opponent to move, don't analyze —
    // suppress arrows/PV so we never surface the opponent's best move.
    if (myMovesOnly && !isMyTurn) {
      clearTimeout(analysisWatchdog);
      lastLines = null;
      ui.updateArrows([], playerColor);
      ui.updatePVLines([]);
      ui.setStatus("Opponent's turn — waiting", false);
      const pvContainer = ui.shadowRoot.getElementById('ca-pv-lines');
      if (pvContainer) {
        pvContainer.innerHTML =
          '<div class="ca-pv-line ca-pv-loading">Opponent to move…</div>';
      }
      return;
    }

    ui.setStatus('Analyzing...', true);
    const pvContainer = ui.shadowRoot.getElementById('ca-pv-lines');
    if (pvContainer) {
      pvContainer.innerHTML =
        '<div class="ca-pv-line ca-pv-loading">Analyzing position...</div>';
    }

    // Send FEN to the background for Stockfish analysis
    chrome.runtime.sendMessage({
      type: 'ANALYZE_FEN',
      fen: fen,
      depth: analysisDepth,
      elo: engineElo,
    });
    armWatchdog(fen);
  }

  /**
   * Called whenever the board DOM changes.
   * Debounces rapid changes (e.g., piece animations) and triggers analysis.
   */
  function onBoardChange() {
    clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      const fen = extractFEN();
      if (!fen) return;
      processNewPosition(fen);
    }, 300); // 300ms debounce to avoid spamming during animations
  }

  /**
   * Polling fallback: periodically re-extract the board position.
   * This catches opponent moves that the MutationObserver might miss
   * (e.g., if Chess.com updates pieces via JavaScript without DOM mutations,
   * or if mutations happen in a shadow root we can't observe).
   */
  function startPolling() {
    if (pollingInterval) return;

    pollingInterval = setInterval(() => {
      const fen = extractFEN();
      if (!fen) return;
      processNewPosition(fen);
    }, 1500); // Check every 1.5 seconds

    console.log('[Chess Assistant] Polling fallback started (1.5s interval).');
  }

  /**
   * Start observing the chess board DOM for changes.
   */
  function startObserver() {
    const site = detectSite();
    if (!site) return;

    const boardSelector =
      site === 'chesscom' ? CHESSCOM_CONFIG.boardSelector : LICHESS_CONFIG.boardSelector;

    const boardEl = document.querySelector(boardSelector);
    if (!boardEl) {
      // Board not loaded yet — retry after a short delay
      console.log('[Chess Assistant] Board not found, retrying in 2s...');
      setTimeout(startObserver, 2000);
      return;
    }

    console.log(`[Chess Assistant] Board found on ${site}. Starting observer.`);

    const observerCallback = (mutations) => {
      // Filter for relevant changes (piece movements, additions, removals)
      const hasRelevantChange = mutations.some(
        (m) =>
          m.type === 'childList' ||
          (m.type === 'attributes' &&
            (m.attributeName === 'class' || m.attributeName === 'style'))
      );

      if (hasRelevantChange) {
        onBoardChange();
      }
    };

    const observerConfig = {
      childList: true,      // Watch for pieces being added/removed
      subtree: true,        // Watch nested elements too
      attributes: true,     // Watch for class/style changes (piece movements)
      attributeFilter: ['class', 'style', 'transform'],
    };

    // Observe the board element itself (light DOM children)
    const observer = new MutationObserver(observerCallback);
    observer.observe(boardEl, observerConfig);

    // Also observe the shadow root if it exists (shadow DOM children)
    if (site === 'chesscom' && boardEl.shadowRoot) {
      const shadowObserver = new MutationObserver(observerCallback);
      shadowObserver.observe(boardEl.shadowRoot, observerConfig);
      console.log('[Chess Assistant] Also observing shadow root.');
    }

    // Also do an initial extraction
    onBoardChange();

    // Start polling as a safety net for missed mutations (e.g., opponent moves)
    startPolling();
  }

  // ===========================================================================
  // UI INJECTION — Shadow DOM
  // ===========================================================================

  /**
   * Inject the Chess Assistant UI into the page using Shadow DOM.
   * Shadow DOM prevents the host page's CSS from breaking our layout.
   */
  function injectUI() {
    // Create the host element
    const host = document.createElement('div');
    host.id = 'chess-assistant-host';
    host.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483647;
      font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    `;
    document.body.appendChild(host);

    // Attach Shadow DOM
    const shadow = host.attachShadow({ mode: 'open' });

    // Load our encapsulated styles inside shadow root
    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = chrome.runtime.getURL('styles.css');
    shadow.appendChild(styleLink);

    // Flag to avoid double-init if both onload and timeout fire
    let uiInitialized = false;
    function tryInitUI() {
      if (uiInitialized) return;
      uiInitialized = true;
      initializeUI(shadow);
    }

    // Wait for styles to load, then initialize UI
    styleLink.onload = tryInitUI;
    // Fallback: if onload never fires (cache, error, etc.), init after 500ms
    styleLink.onerror = () => {
      console.warn('[Chess Assistant] styles.css failed to load via shadow link, initializing anyway.');
      tryInitUI();
    };
    setTimeout(tryInitUI, 500);
  }

  /**
   * Build the complete UI inside the Shadow DOM root.
   */
  function initializeUI(shadowRoot) {
    // ── Main Container ────────────────────────────────────────────────────
    const container = document.createElement('div');
    container.className = 'chess-assistant';
    container.id = 'chess-assistant-container';

    // ── Header / Title Bar ────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'ca-header';
    header.innerHTML = `
      <div class="ca-header-title">
        <span class="ca-icon">♞</span>
        <span class="ca-title-text">Chess Assistant</span>
      </div>
      <div class="ca-header-controls">
        <select class="ca-elo-select" id="ca-elo-select" title="Engine strength — match your opponent's Elo so the suggested moves look human, not 3600-perfect">
          ${[
            { v: 3600, label: 'Max' },
            { v: 2800, label: '2800' },
            { v: 2400, label: '2400' },
            { v: 2000, label: '2000' },
            { v: 1600, label: '1600' },
            { v: 1320, label: '1320' },
            { v: 1000, label: '~1000' },
            { v: 800,  label: '~800' },
            { v: 600,  label: '~600' },
            { v: 400,  label: '~400' },
            { v: 250,  label: '~250' },
          ]
            .map((o) => `<option value="${o.v}" ${o.v === 3600 ? 'selected' : ''}>♟ ${o.label}</option>`)
            .join('')}
        </select>
        <select class="ca-depth-select" id="ca-depth-select" title="Analysis Depth">
          ${[10, 12, 14, 16, 18, 20, 22, 24]
            .map((d) => `<option value="${d}" ${d === 18 ? 'selected' : ''}>D${d}</option>`)
            .join('')}
        </select>
        <button class="ca-btn ca-mymoves-btn ca-toggle-on" id="ca-mymoves-btn" title="Only show YOUR best moves (hide opponent's)">♟</button>
        <button class="ca-btn ca-flip-btn" id="ca-flip-btn" title="Flip board / switch your side">⇅</button>
        <button class="ca-btn ca-minimize-btn" id="ca-minimize-btn" title="Minimize">─</button>
        <button class="ca-btn ca-close-btn" id="ca-close-btn" title="Hide (Ctrl+Shift+A)">✕</button>
      </div>
    `;

    // ── Body (Mini-Board + Eval Bar) ──────────────────────────────────────
    const body = document.createElement('div');
    body.className = 'ca-body';
    body.id = 'ca-body';

    // Evaluation Bar (left side)
    const evalBar = document.createElement('div');
    evalBar.className = 'ca-eval-bar';
    evalBar.id = 'ca-eval-bar';
    evalBar.innerHTML = `
      <div class="ca-eval-fill" id="ca-eval-fill"></div>
      <div class="ca-eval-label" id="ca-eval-label">0.0</div>
    `;

    // Mini-Board Container
    const boardContainer = document.createElement('div');
    boardContainer.className = 'ca-board-container';
    boardContainer.id = 'ca-board-container';

    // The 8x8 board grid
    const boardGrid = document.createElement('div');
    boardGrid.className = 'ca-board';
    boardGrid.id = 'ca-board';

    // Create 64 squares
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const square = document.createElement('div');
        const isLight = (row + col) % 2 === 0;
        square.className = `ca-square ${isLight ? 'ca-light' : 'ca-dark'}`;
        square.dataset.row = row;
        square.dataset.col = col;
        boardGrid.appendChild(square);
      }
    }

    // SVG overlay for arrows (defs are created fresh by updateArrows each call)
    const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.setAttribute('class', 'ca-arrows');
    arrowSvg.setAttribute('id', 'ca-arrows');
    arrowSvg.setAttribute('viewBox', '0 0 280 280');
    arrowSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    boardContainer.appendChild(boardGrid);
    boardContainer.appendChild(arrowSvg);


    body.appendChild(evalBar);
    body.appendChild(boardContainer);

    // ── Footer (PV lines info) ────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.className = 'ca-footer';
    footer.id = 'ca-footer';
    footer.innerHTML = `
      <div class="ca-pv-lines" id="ca-pv-lines">
        <div class="ca-pv-line ca-pv-loading">Waiting for position...</div>
      </div>
      <div class="ca-status" id="ca-status">
        <span class="ca-status-dot"></span>
        <span class="ca-status-text">Initializing engine...</span>
      </div>
    `;

    // ── Assemble ──────────────────────────────────────────────────────────
    container.appendChild(header);
    container.appendChild(body);
    container.appendChild(footer);
    shadowRoot.appendChild(container);

    // ── Wire up event listeners ───────────────────────────────────────────
    setupUIEventListeners(shadowRoot, container);

    // ── Expose UI API for content script ──────────────────────────────────
    window.__chessAssistantUI = {
      shadowRoot,
      container,
      updateBoard: (fen, playerColor) => updateMiniBoard(shadowRoot, fen, playerColor),
      updateEval: (score) => updateEvalBar(shadowRoot, score),
      updateArrows: (lines, playerColor) => updateArrows(shadowRoot, lines, playerColor),
      updatePVLines: (lines) => updatePVLines(shadowRoot, lines),
      setStatus: (text, isActive) => setStatus(shadowRoot, text, isActive),
      toggle: () => toggleUI(container),
      setDepth: (d) => { analysisDepth = d; },
      setElo: (e) => { engineElo = e; },
    };
  }

  // ===========================================================================
  // UI UPDATE FUNCTIONS
  // ===========================================================================

  /**
   * Unicode chess pieces for rendering on the mini-board.
   * We use the SOLID (filled) glyph set for BOTH colors and distinguish white
   * vs. black purely via CSS fill + outline (.ca-white-piece / .ca-black-piece).
   * Mixing the outline glyphs (♔♕♖) for white with solid glyphs for black looks
   * inconsistent and thin — solid silhouettes read far cleaner at small sizes.
   */
  const PIECE_UNICODE = {
    K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟',
    k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
  };

  /**
   * Update the mini-board squares with the current FEN position.
   */
  function updateMiniBoard(shadowRoot, fen, playerColor) {
    const boardEl = shadowRoot.getElementById('ca-board');
    if (!boardEl) return;

    // Parse FEN position part (before the space)
    const positionPart = fen.split(' ')[0];
    const ranks = positionPart.split('/');

    const squares = boardEl.querySelectorAll('.ca-square');
    const isFlipped = playerColor === 'black';

    for (let row = 0; row < 8; row++) {
      const rank = ranks[row];
      let col = 0;
      let charIdx = 0;

      // Build the rank data
      const rankData = [];
      while (charIdx < rank.length) {
        const ch = rank[charIdx];
        if (ch >= '1' && ch <= '8') {
          const emptyCount = parseInt(ch, 10);
          for (let e = 0; e < emptyCount; e++) {
            rankData.push(null);
          }
        } else {
          rankData.push(ch);
        }
        charIdx++;
      }

      // Fill squares
      for (col = 0; col < 8; col++) {
        let displayRow = isFlipped ? 7 - row : row;
        let displayCol = isFlipped ? 7 - col : col;
        const squareIdx = displayRow * 8 + displayCol;
        const square = squares[squareIdx];
        if (!square) continue;

        const piece = rankData[col] || null;
        square.textContent = piece ? (PIECE_UNICODE[piece] || '') : '';
        square.className = `ca-square ${
          (displayRow + displayCol) % 2 === 0 ? 'ca-light' : 'ca-dark'
        }`;
        if (piece) {
          square.classList.add(piece === piece.toUpperCase() ? 'ca-white-piece' : 'ca-black-piece');
        }
      }
    }
  }

  /**
   * Update the evaluation bar fill and label.
   *
   * @param {Object} score - { type: "cp"|"mate", value: number }
   *   cp: centipawns (positive = white advantage)
   *   mate: moves to mate (positive = white mates, negative = black mates)
   */
  function updateEvalBar(shadowRoot, score) {
    const fill = shadowRoot.getElementById('ca-eval-fill');
    const label = shadowRoot.getElementById('ca-eval-label');
    if (!fill || !label) return;

    let percentage, displayText;

    if (score.type === 'mate') {
      // Mate score — snap to the extreme
      if (score.value > 0) {
        percentage = 100;
        displayText = `M${score.value}`;
      } else {
        percentage = 0;
        displayText = `M${Math.abs(score.value)}`;
      }
    } else {
      // Centipawn score — map to 0-100% range
      // Clamp to ±1000cp for visual display
      const cp = Math.max(-1000, Math.min(1000, score.value));

      // Convert: +1000cp → 100%, 0cp → 50%, -1000cp → 0%
      percentage = ((cp + 1000) / 2000) * 100;

      // Display as pawns (e.g., +1.23, -0.50)
      const pawns = score.value / 100;
      displayText = (pawns >= 0 ? '+' : '') + pawns.toFixed(1);
    }

    fill.style.height = `${percentage}%`;
    label.textContent = displayText;

    // Color the label based on who's ahead
    if (percentage > 55) {
      label.style.color = '#ffffff';
    } else if (percentage < 45) {
      label.style.color = '#1a1a2e';
    } else {
      label.style.color = '#94a3b8';
    }
  }

  function updateArrows(shadowRoot, lines, playerColor) {
    const svg = shadowRoot.getElementById('ca-arrows');
    if (!svg) return;

    // Clear all existing arrows
    svg.innerHTML = '';

    if (!lines || lines.length === 0) return;

    const squareSize = 280 / 8; // 35px per square
    const isFlipped  = playerColor === 'black';

    // Arrow visual styles for top 3 lines
    const arrowStyles = [
      { color: '#22c55e', shaft: 5.5, headSize: 13, opacity: 0.95 }, // #1 best — green
      { color: '#eab308', shaft: 3.5, headSize: 10, opacity: 0.80 }, // #2      — yellow
      { color: '#f97316', shaft: 2.5, headSize:  8, opacity: 0.65 }, // #3      — orange
    ];

    /**
     * Draw a single arrow (shaft + filled triangular arrowhead) using only
     * <line> and <polygon>. No SVG <marker> or url() references needed —
     * those are broken inside Shadow DOM in Chrome.
     *
     * The arrowhead is a triangle whose tip lands exactly at (tx, ty) and
     * whose base is centred on the shaft direction.
     */
    function drawArrow(x1, y1, tx, ty, style) {
      const dx   = tx - x1;
      const dy   = ty - y1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) return; // zero-length move (shouldn't happen)

      // Unit vector along the arrow
      const ux = dx / dist;
      const uy = dy / dist;

      // Perpendicular unit vector (for the base of the arrowhead triangle)
      const px = -uy;
      const py =  ux;

      const hs = style.headSize;  // half-width of arrowhead base
      const hl = hs * 1.8;        // length of arrowhead along the shaft

      // Arrowhead tip  = (tx, ty)
      // Arrowhead base = tip moved back by hl along the shaft
      const bx = tx - ux * hl;
      const by = ty - uy * hl;

      // Shaft runs from (x1,y1) to the arrowhead base (so the head sits on top)
      const shaftX2 = bx + ux * (hs * 0.3); // slight overlap for clean join
      const shaftY2 = by + uy * (hs * 0.3);

      // Draw shaft
      const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      shaft.setAttribute('x1', x1.toFixed(2));
      shaft.setAttribute('y1', y1.toFixed(2));
      shaft.setAttribute('x2', shaftX2.toFixed(2));
      shaft.setAttribute('y2', shaftY2.toFixed(2));
      shaft.setAttribute('stroke',         style.color);
      shaft.setAttribute('stroke-width',   style.shaft);
      shaft.setAttribute('stroke-opacity', style.opacity);
      shaft.setAttribute('stroke-linecap', 'round');
      svg.appendChild(shaft);

      // Draw arrowhead triangle: tip, left-base, right-base
      const pts = [
        `${tx.toFixed(2)},${ty.toFixed(2)}`,
        `${(bx + px * hs).toFixed(2)},${(by + py * hs).toFixed(2)}`,
        `${(bx - px * hs).toFixed(2)},${(by - py * hs).toFixed(2)}`,
      ].join(' ');

      const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      head.setAttribute('points',        pts);
      head.setAttribute('fill',          style.color);
      head.setAttribute('fill-opacity',  style.opacity);
      head.setAttribute('stroke',        'none');
      svg.appendChild(head);
    }

    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      const line = lines[i];
      if (!line.pv || line.pv.length === 0) continue;

      const move = line.pv[0]; // e.g. "e2e4"
      if (!move || move.length < 4) continue;

      // Parse UCI notation → 0-based file/rank
      const fromFile = move.charCodeAt(0) - 97; // a=0 … h=7
      const fromRank = parseInt(move[1], 10) - 1;
      const toFile   = move.charCodeAt(2) - 97;
      const toRank   = parseInt(move[3], 10) - 1;

      // Board → SVG pixel (centre of each square)
      let x1, y1, x2, y2;
      if (isFlipped) {
        x1 = (7 - fromFile) * squareSize + squareSize / 2;
        y1 = fromRank       * squareSize + squareSize / 2;
        x2 = (7 - toFile)   * squareSize + squareSize / 2;
        y2 = toRank         * squareSize + squareSize / 2;
      } else {
        x1 = fromFile * squareSize + squareSize / 2;
        y1 = (7 - fromRank) * squareSize + squareSize / 2;
        x2 = toFile   * squareSize + squareSize / 2;
        y2 = (7 - toRank)   * squareSize + squareSize / 2;
      }

      drawArrow(x1, y1, x2, y2, arrowStyles[i]);
    }
  }

  /**
   * Update the PV lines display in the footer.
   */
  function updatePVLines(shadowRoot, lines) {
    const pvContainer = shadowRoot.getElementById('ca-pv-lines');
    if (!pvContainer) return;

    const rankLabels = ['①', '②', '③'];
    const rankColors = ['#22c55e', '#eab308', '#f97316'];

    pvContainer.innerHTML = '';

    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      const line = lines[i];
      const pvEl = document.createElement('div');
      pvEl.className = 'ca-pv-line';

      // Score display
      let scoreText;
      if (line.score.type === 'mate') {
        scoreText = `M${Math.abs(line.score.value)}`;
      } else {
        const pawns = line.score.value / 100;
        scoreText = (pawns >= 0 ? '+' : '') + pawns.toFixed(1);
      }

      // Show first 5 moves of the PV
      const movesText = (line.pv || []).slice(0, 5).join(' ');

      pvEl.innerHTML = `
        <span class="ca-pv-rank" style="color: ${rankColors[i]}">${rankLabels[i]}</span>
        <span class="ca-pv-score">${scoreText}</span>
        <span class="ca-pv-moves">${movesText}</span>
      `;

      pvContainer.appendChild(pvEl);
    }
  }

  /**
   * Update the status indicator.
   */
  function setStatus(shadowRoot, text, isActive = true) {
    const statusEl = shadowRoot.getElementById('ca-status');
    if (!statusEl) return;

    statusEl.innerHTML = `
      <span class="ca-status-dot ${isActive ? 'ca-active' : ''}"></span>
      <span class="ca-status-text">${text}</span>
    `;
  }

  /**
   * Toggle the UI panel visibility.
   */
  function toggleUI(container) {
    const host = document.getElementById('chess-assistant-host');
    if (host) {
      const isHidden = host.style.display === 'none';
      host.style.display = isHidden ? '' : 'none';
    }
  }

  // ===========================================================================
  // UI EVENT LISTENERS
  // ===========================================================================

  function setupUIEventListeners(shadowRoot, container) {
    // Minimize button — collapse/expand the body
    const minimizeBtn = shadowRoot.getElementById('ca-minimize-btn');
    if (minimizeBtn) {
      minimizeBtn.addEventListener('click', () => {
        const body = shadowRoot.getElementById('ca-body');
        const footer = shadowRoot.getElementById('ca-footer');
        const isMinimized = body.style.display === 'none';

        body.style.display = isMinimized ? '' : 'none';
        footer.style.display = isMinimized ? '' : 'none';
        minimizeBtn.textContent = isMinimized ? '─' : '□';
      });
    }

    // Close button — hide the entire panel
    const closeBtn = shadowRoot.getElementById('ca-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        toggleUI(container);
      });
    }

    // Engine strength (Elo) selector — adjusts how strong the suggested moves are.
    const eloSelect = shadowRoot.getElementById('ca-elo-select');
    if (eloSelect) {
      eloSelect.addEventListener('change', (e) => {
        engineElo = parseInt(e.target.value, 10);
        console.log(`[Chess Assistant] Engine strength set to ${engineElo} Elo`);
        // Highlight the control whenever it's below full strength.
        eloSelect.classList.toggle('ca-elo-limited', engineElo < 3600);
        // Re-analyze the current position at the new strength.
        analyzeCurrentPosition();
      });
    }

    // Depth selector
    const depthSelect = shadowRoot.getElementById('ca-depth-select');
    if (depthSelect) {
      depthSelect.addEventListener('change', (e) => {
        analysisDepth = parseInt(e.target.value, 10);
        console.log(`[Chess Assistant] Depth changed to ${analysisDepth}`);

        // Re-analyze current position with new depth
        if (lastFEN) {
          chrome.runtime.sendMessage({
            type: 'ANALYZE_FEN',
            fen: lastFEN,
            depth: analysisDepth,
            elo: engineElo,
          });
        }
      });
    }

    // Flip button — override the auto-detected orientation / player side.
    const flipBtn = shadowRoot.getElementById('ca-flip-btn');
    if (flipBtn) {
      flipBtn.addEventListener('click', () => {
        // Toggle based on the CURRENT effective color so the first click always
        // visibly flips, even when no override was set yet.
        const current = detectPlayerColor();
        playerColorOverride = current === 'white' ? 'black' : 'white';
        console.log('[Chess Assistant] Board orientation set to', playerColorOverride);
        // Re-render board + arrows and re-evaluate whose-turn gating.
        analyzeCurrentPosition();
        if (lastLines) {
          window.__chessAssistantUI.updateArrows(lastLines, playerColorOverride);
        }
      });
    }

    // "My moves only" toggle — when on, suppress analysis on the opponent's turn.
    const myMovesBtn = shadowRoot.getElementById('ca-mymoves-btn');
    if (myMovesBtn) {
      myMovesBtn.addEventListener('click', () => {
        myMovesOnly = !myMovesOnly;
        myMovesBtn.classList.toggle('ca-toggle-on', myMovesOnly);
        myMovesBtn.title = myMovesOnly
          ? "Only show YOUR best moves (hide opponent's)"
          : 'Showing best move for whoever is to move';
        console.log('[Chess Assistant] My-moves-only:', myMovesOnly);
        // Re-evaluate immediately with the current position.
        analyzeCurrentPosition();
      });
    }

    // ── Make the panel draggable ───────────────────────────────────────────
    const headerEl = shadowRoot.querySelector('.ca-header');
    if (headerEl) {
      let isDragging = false;
      let dragOffsetX = 0;
      let dragOffsetY = 0;

      headerEl.addEventListener('mousedown', (e) => {
        // Don't drag when clicking buttons/selects
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;

        isDragging = true;
        const host = document.getElementById('chess-assistant-host');
        const rect = host.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        headerEl.style.cursor = 'grabbing';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const host = document.getElementById('chess-assistant-host');
        host.style.left = `${e.clientX - dragOffsetX}px`;
        host.style.top = `${e.clientY - dragOffsetY}px`;
        host.style.right = 'auto';
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
        headerEl.style.cursor = 'grab';
      });
    }
  }

  // ===========================================================================
  // MESSAGE HANDLING — Receive engine results
  // ===========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ENGINE_READY' && window.__chessAssistantUI) {
      // Engine has initialized — update status from "Initializing engine..."
      window.__chessAssistantUI.setStatus('Engine ready', true);
    }

    if (message.type === 'ENGINE_RESULT' && window.__chessAssistantUI) {
      clearTimeout(analysisWatchdog); // got a result — stop watching
      const data = message.data;
      if (!data) {
        console.warn('[Chess Assistant] ENGINE_RESULT received but data is missing');
        return;
      }
      console.log('[Chess Assistant] ENGINE_RESULT received:', data.bestMove, 'lines:', data.lines?.length);

      const ui = window.__chessAssistantUI;
      const playerColor = detectPlayerColor();

      // Cache lines so a board flip can redraw arrows without re-analyzing.
      lastLines = data.lines || null;

      // Update evaluation bar with the best line's score
      if (data.lines && data.lines.length > 0 && data.lines[0].score) {
        ui.updateEval(data.lines[0].score);
      }

      // Draw arrows for top 3 moves
      if (data.lines && data.lines.length > 0) {
        ui.updateArrows(data.lines, playerColor);
      }

      // Update PV lines display
      if (data.lines) {
        ui.updatePVLines(data.lines);
      }

      // Update status
      const depth = data.lines?.[0]?.depth || '?';
      ui.setStatus(`Depth ${depth} — ${data.bestMove}`, true);
    }

    if (message.type === 'ENGINE_PROGRESS' && window.__chessAssistantUI) {
      const ui = window.__chessAssistantUI;
      const progData = message.data;
      if (!progData) return;

      // Engine is alive and searching — refresh the watchdog so a legitimately
      // long search doesn't trigger a spurious retry; it only fires after a true
      // stall (no progress at all for ANALYSIS_TIMEOUT_MS).
      if (lastFEN) armWatchdog(lastFEN);

      if (progData.score) {
        ui.updateEval(progData.score);
      }
      ui.setStatus(`Analyzing... depth ${progData.depth || '?'}`, true);
    }

    if (message.type === 'TOGGLE_UI' && window.__chessAssistantUI) {
      window.__chessAssistantUI.toggle();
    }

    return false;
  });

  // ===========================================================================
  // KEYBOARD SHORTCUT — Ctrl+Shift+A to toggle
  // ===========================================================================

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      if (window.__chessAssistantUI) {
        window.__chessAssistantUI.toggle();
      }
    }
  });

  // ===========================================================================
  // INITIALIZATION
  // ===========================================================================

  function init() {
    const site = detectSite();
    if (!site) {
      console.log('[Chess Assistant] Not a supported chess site.');
      return;
    }

    console.log(`[Chess Assistant] Detected site: ${site}`);

    // Inject the UI overlay
    injectUI();

    // Notify the background that a chess tab is active.
    // This triggers eager engine initialization and lets us receive ENGINE_READY.
    chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' }).catch(() => {});

    // Start observing the board for changes
    // Wait a beat for the board to fully render its pieces
    setTimeout(startObserver, 2000);
  }

  // Run initialization when the DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
