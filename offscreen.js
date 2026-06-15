// =============================================================================
// offscreen.js — Stockfish WASM Engine Host
// =============================================================================
// Hybrid approach: Tries Web Worker first (standard non-blocking Stockfish.js).
// Falls back to Module API if Worker fails (some Chrome extension configs block Workers).
//
// In Module mode, ALL commands go through a serial queue to prevent re-entrant
// ccall crashes. The engine's Asyncify support requires careful sequencing.
// =============================================================================

let stockfishWorker = null;
let engineModule = null;
let isEngineReady = false;
let pvLines = {};
let analysisTabId = null;
let pendingCommands = [];

// Module mode: serial command queue
let moduleCommandQueue = [];
let moduleCommandRunning = false;

// Track if Worker ever responded
let workerResponded = false;

// -----------------------------------------------------------------------------
// Initialize — Try Worker, fall back to Module
// -----------------------------------------------------------------------------

function initEngine() {
  if (stockfishWorker || engineModule) return;

  try {
    const jsUrl  = chrome.runtime.getURL('engine/stockfish-18-lite-single.js');
    const wasmUrl = chrome.runtime.getURL('engine/stockfish-18-lite-single.wasm');
    const workerUrl = `${jsUrl}#${wasmUrl},worker`;

    console.log('[Chess Assistant] Creating worker...');
    stockfishWorker = new Worker(workerUrl);

    stockfishWorker.onmessage = (event) => {
      workerResponded = true;
      handleEngineOutput(String(event.data));
    };

    stockfishWorker.onerror = (error) => {
      console.error('[Chess Assistant] Worker error:', error.message);
      if (!workerResponded) {
        console.log('[Chess Assistant] Worker failed, switching to module mode...');
        stockfishWorker.terminate();
        stockfishWorker = null;
        initModuleMode();
      }
    };

    // Send uci immediately — engine queues it internally until WASM loads
    stockfishWorker.postMessage('uci');

    // Fallback timeout: if no response in 8 seconds, use module mode
    setTimeout(() => {
      if (!workerResponded && stockfishWorker) {
        console.warn('[Chess Assistant] Worker timeout. Falling back to module...');
        stockfishWorker.terminate();
        stockfishWorker = null;
        initModuleMode();
      }
    }, 8000);

  } catch (err) {
    console.error('[Chess Assistant] Worker creation failed:', err);
    initModuleMode();
  }
}

// -----------------------------------------------------------------------------
// Module Mode — Load engine via <script> tag
// -----------------------------------------------------------------------------

function initModuleMode() {
  if (engineModule) return;
  engineModule = 'initializing';

  const scriptEl = document.getElementById('stockfish-engine');
  if (!scriptEl || typeof scriptEl._exports !== 'function') {
    console.error('[Chess Assistant] Stockfish module not found!');
    engineModule = null;
    return;
  }

  const wasmUrl = chrome.runtime.getURL('engine/stockfish-18-lite-single.wasm');
  console.log('[Chess Assistant] Module mode: starting...');

  const config = {
    locateFile: (path) => (path.indexOf('.wasm') !== -1 && path.indexOf('.wasm.map') === -1) ? wasmUrl : path,
    listener: (line) => handleEngineOutput(line),
    print: (line) => handleEngineOutput(line),
    printErr: (line) => console.warn('[Chess Assistant] stderr:', line),
  };

  scriptEl._exports(config).then((module) => {
    engineModule = module || config;
    console.log('[Chess Assistant] Module mode: WASM ready, ccall:', typeof engineModule.ccall);
    // Defer the uci command to avoid re-entrancy
    setTimeout(() => enqueueModuleCommand('uci'), 10);
  }).catch((err) => {
    console.error('[Chess Assistant] Module init failed:', err);
    engineModule = null;
  });
}

// -----------------------------------------------------------------------------
// Module Mode — Serial Command Queue
// -----------------------------------------------------------------------------
// In module mode, commands are processed one at a time through ccall.
// 'go' commands use Asyncify (async: true) and block the queue until complete.
// All other commands are synchronous. This prevents re-entrant ccall crashes.

function enqueueModuleCommand(command) {
  moduleCommandQueue.push(command);
  processModuleQueue();
}

function processModuleQueue() {
  if (moduleCommandRunning || moduleCommandQueue.length === 0) return;
  if (!engineModule || engineModule === 'initializing') return;
  if (typeof engineModule.ccall !== 'function') return;

  moduleCommandRunning = true;
  const command = moduleCommandQueue.shift();
  console.log(`[Chess Assistant] >>> ${command}`);

  const isGoCommand = /^go\b/.test(command.trim());

  try {
    const result = engineModule.ccall(
      'command', null, ['string'], [command],
      { async: isGoCommand }
    );

    if (isGoCommand && result && typeof result.then === 'function') {
      // Async 'go' command — wait for it to complete before next command
      result.then(() => {
        moduleCommandRunning = false;
        processModuleQueue();
      }).catch((err) => {
        console.error('[Chess Assistant] go command error:', err);
        moduleCommandRunning = false;
        processModuleQueue();
      });
    } else {
      // Synchronous command — move to next immediately
      moduleCommandRunning = false;
      // Use setTimeout to avoid deep recursion and allow listener callbacks to process
      setTimeout(() => processModuleQueue(), 0);
    }
  } catch (err) {
    console.error('[Chess Assistant] ccall error:', err);
    moduleCommandRunning = false;
    setTimeout(() => processModuleQueue(), 0);
  }
}

// -----------------------------------------------------------------------------
// Send Commands (routes to Worker or Module queue)
// -----------------------------------------------------------------------------

function sendToEngine(command) {
  // Worker mode — simple postMessage
  if (stockfishWorker) {
    console.log(`[Chess Assistant] >>> ${command}`);
    stockfishWorker.postMessage(command);
    return;
  }

  // Module mode — use serial queue
  if (engineModule && engineModule !== 'initializing') {
    enqueueModuleCommand(command);
    return;
  }

  // Not ready — queue for later
  console.log(`[Chess Assistant] (queued) >>> ${command}`);
  pendingCommands.push(command);
}

// -----------------------------------------------------------------------------
// Parse Stockfish UCI Output
// -----------------------------------------------------------------------------

function handleEngineOutput(line) {
  if (typeof line !== 'string') line = String(line);

  if (line === 'uciok' || line === 'readyok' ||
      line.startsWith('info depth') || line.startsWith('bestmove') ||
      line.startsWith('id ')) {
    console.log(`[Chess Assistant] <<< ${line.substring(0, 150)}`);
  }

  if (line === 'uciok') {
    // DEFER to avoid re-entrant ccall in module mode
    setTimeout(() => {
      sendToEngine('setoption name MultiPV value 3');
      sendToEngine('setoption name Threads value 1');
      sendToEngine('isready');
    }, 0);
    return;
  }

  if (line === 'readyok') {
    isEngineReady = true;
    console.log('[Chess Assistant] ✓ Engine ready!');
    safeSendMessage({ type: 'ENGINE_READY' });

    if (pendingCommands.length > 0) {
      setTimeout(() => {
        console.log('[Chess Assistant] Draining', pendingCommands.length, 'pending commands...');
        const cmds = pendingCommands.slice();
        pendingCommands = [];
        for (const cmd of cmds) {
          sendToEngine(cmd);
        }
      }, 0);
    }
    return;
  }

  if (line.startsWith('info depth')) {
    const parsed = parseInfoLine(line);
    if (parsed && parsed.pv && parsed.pv.length) {
      // In strength-limited mode (UCI_LimitStrength on) Stockfish runs single-PV
      // and OMITS the `multipv` token. Default it to 1 so these lines are still
      // captured — otherwise pvLines stays empty and no moves are ever shown.
      const mpv = parsed.multipv || 1;
      pvLines[mpv] = parsed;
      if (mpv === 1) {
        safeSendMessage({
          type: 'ENGINE_PROGRESS',
          tabId: analysisTabId,
          data: { depth: parsed.depth, score: parsed.score, pv: parsed.pv },
        });
      }
    }
    return;
  }

  if (line.startsWith('bestmove')) {
    const bestMove = line.split(' ')[1];
    const result = { bestMove, lines: [] };

    for (let i = 1; i <= 3; i++) {
      if (pvLines[i]) {
        result.lines.push({
          rank: i,
          score: pvLines[i].score,
          pv: pvLines[i].pv,
          depth: pvLines[i].depth,
        });
      }
    }

    // Surface the engine's actual choice as the primary (rank-1) move. When the
    // engine is strength-limited its chosen `bestmove` may not be the top MultiPV
    // line — or no PV line for it was reported at all — so promote it if present,
    // otherwise synthesize a line for it. This guarantees an arrow always shows.
    // At full strength this is a no-op (bestmove === multipv 1's first move).
    if (bestMove && bestMove !== '(none)') {
      const idx = result.lines.findIndex((l) => l.pv && l.pv[0] === bestMove);
      if (idx > 0) {
        const [chosen] = result.lines.splice(idx, 1);
        result.lines.unshift(chosen);
      } else if (idx === -1) {
        result.lines.unshift({
          rank: 1,
          score: (result.lines[0] && result.lines[0].score) || { type: 'cp', value: 0 },
          pv: [bestMove],
          depth: (result.lines[0] && result.lines[0].depth) || 0,
        });
      }
      result.lines.forEach((l, i) => { l.rank = i + 1; });
    }

    console.log('[Chess Assistant] ENGINE_RESULT:', bestMove, 'lines:', result.lines.length);
    safeSendMessage({ type: 'ENGINE_RESULT', tabId: analysisTabId, data: result });
    pvLines = {};
    return;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function safeSendMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
  } catch (e) { /* service worker may be inactive */ }
}

// -----------------------------------------------------------------------------
// Engine Strength (Elo) shaping
// -----------------------------------------------------------------------------
// The UI sends a target Elo. We weaken the engine using "Skill Level" (0..20).
//
// We deliberately do NOT use UCI_LimitStrength / UCI_Elo: in this Stockfish-lite
// build that option forces single-PV mode and, in practice, sometimes never
// returns a bestmove — leaving the panel stuck on "Analyzing…". Skill Level keeps
// normal MultiPV output and reliably emits a bestmove, so it's the safe path.
//
//   • >= 3190 (or absent)  → Skill Level 20 (full strength)
//   • lower targets        → mapped down to Skill Level 0 (weakest beginner)

function eloToSkill(elo) {
  if (!elo || elo >= 3190) return 20;
  if (elo >= 2800) return 19;
  if (elo >= 2400) return 17;
  if (elo >= 2000) return 14;
  if (elo >= 1600) return 11;
  if (elo >= 1320) return 8;
  if (elo >= 1000) return 5;
  if (elo >= 800)  return 3;
  if (elo >= 600)  return 2;
  if (elo >= 400)  return 1;
  return 0;
}

function strengthCommands(elo) {
  return [
    // Ensure the official limiter is off (Skill Level is what we use).
    'setoption name UCI_LimitStrength value false',
    'setoption name Skill Level value ' + eloToSkill(elo),
  ];
}

// For lower target strengths, also shorten the search so the recommended move
// reflects shallow, human-like calculation rather than deep engine vision.
function effectiveDepth(elo, depth) {
  const d = depth || 18;
  // Only cap depth for weaker Elo levels where deep search is counterproductive.
  // At full strength, respect the user's chosen depth.
  if (elo && elo < 1320) return Math.min(d, 8);
  if (elo && elo < 2000) return Math.min(d, 12);
  return d;
}

// Hard time cap (ms) on every search. This is the key to staying responsive on
// low-end / single-thread machines: openings reach the target depth in a few ms,
// but complex mid/endgame positions can take 30s+ to reach depth 18. With a
// movetime cap the engine ALWAYS returns its best move so far within the budget,
// so the panel never lags or stalls. The depth becomes an upper bound, not a
// fixed target. Weaker levels (which don't need deep search) get a tighter cap.
// At higher user-requested depths, scale the budget so the engine actually has
// time to search deeper — otherwise selecting depth 22+ would be meaningless.
function searchTime(elo, depth) {
  if (elo && elo < 1600) return 700;
  if (elo && elo < 2400) return 1200;
  // Full strength: scale with depth. Base is 2s for depth ≤ 18, then add 1.5s
  // per extra depth level. Depth 20 → 5s, depth 22 → 8s, depth 24 → 11s.
  const d = depth || 18;
  if (d <= 18) return 2000;
  return 2000 + (d - 18) * 1500;
}

function parseInfoLine(line) {
  const tokens = line.split(' ');
  const result = {};
  let i = 0;
  while (i < tokens.length) {
    switch (tokens[i]) {
      case 'depth':    result.depth = parseInt(tokens[++i], 10); break;
      case 'seldepth': result.seldepth = parseInt(tokens[++i], 10); break;
      case 'multipv':  result.multipv = parseInt(tokens[++i], 10); break;
      case 'score':
        i++;
        if (tokens[i] === 'cp') result.score = { type: 'cp', value: parseInt(tokens[++i], 10) };
        else if (tokens[i] === 'mate') result.score = { type: 'mate', value: parseInt(tokens[++i], 10) };
        break;
      case 'nodes': result.nodes = parseInt(tokens[++i], 10); break;
      case 'nps':   result.nps = parseInt(tokens[++i], 10); break;
      case 'time':  result.time = parseInt(tokens[++i], 10); break;
      case 'pv':    result.pv = tokens.slice(i + 1); i = tokens.length; break;
    }
    i++;
  }
  return (result.depth && result.pv && result.pv.length > 0) ? result : null;
}

// -----------------------------------------------------------------------------
// Message Listener
// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_FEN') {
    const { fen, depth, tabId, elo } = message;
    analysisTabId = tabId || null;

    if (!stockfishWorker && !engineModule) initEngine();

    const strengthCmds = strengthCommands(elo);
    const goDepth = effectiveDepth(elo, depth);
    // Stop at whichever limit is hit first: the target depth OR the time cap.
    const goCmd = `go depth ${goDepth} movetime ${searchTime(elo, goDepth)}`;

    if (!isEngineReady) {
      console.log('[Chess Assistant] Not ready, queuing analysis...');
      pendingCommands = pendingCommands.filter(c =>
        !c.startsWith('position') && !c.startsWith('go') && c !== 'stop' &&
        !c.startsWith('setoption name UCI_LimitStrength') &&
        !c.startsWith('setoption name UCI_Elo') &&
        !c.startsWith('setoption name Skill Level')
      );
      pendingCommands.push('stop');
      strengthCmds.forEach((c) => pendingCommands.push(c));
      pendingCommands.push(`position fen ${fen}`);
      pendingCommands.push(goCmd);
    } else {
      // Send analysis commands (they'll be queued properly in module mode)
      sendToEngine('stop');
      strengthCmds.forEach((c) => sendToEngine(c));
      sendToEngine(`position fen ${fen}`);
      sendToEngine(goCmd);
    }

    sendResponse({ status: 'analysis_started' });
    return true;
  }

  if (message.type === 'STOP_ENGINE') {
    sendToEngine('stop');
    pvLines = {};
    pendingCommands = [];
    moduleCommandQueue = [];
    sendResponse({ status: 'stopped' });
    return true;
  }

  return false;
});

// -----------------------------------------------------------------------------
// Auto-initialize
// -----------------------------------------------------------------------------
setTimeout(() => {
  initEngine();
  console.log('[Chess Assistant] Offscreen document loaded.');
}, 100);
