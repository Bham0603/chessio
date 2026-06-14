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
    if (parsed && parsed.multipv) {
      pvLines[parsed.multipv] = parsed;
      if (parsed.multipv === 1) {
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

    // When the engine is strength-limited, its chosen `bestmove` may not be the
    // objectively-top MultiPV line. Promote the line that actually starts with
    // `bestmove` to rank 1 so the primary arrow shows the level-appropriate move.
    // At full strength this is a no-op (bestmove === multipv 1's first move).
    const chosenIdx = result.lines.findIndex((l) => l.pv && l.pv[0] === bestMove);
    if (chosenIdx > 0) {
      const [chosen] = result.lines.splice(chosenIdx, 1);
      result.lines.unshift(chosen);
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
// The UI sends a target Elo. We translate it into the right UCI options so the
// engine plays *at that level* instead of at full ~3600 strength.
//
//   • >= 3190 (or absent)  → full strength (UCI_LimitStrength off)
//   • 1320..3189           → UCI_LimitStrength on + UCI_Elo = target
//                            (the official Stockfish strength limiter)
//   • < 1320               → below Stockfish's UCI_Elo floor, so we weaken via
//                            "Skill Level" (0..19) which makes it deliberately
//                            pick human-like, sub-optimal beginner moves.

function strengthCommands(elo) {
  const cmds = [];
  if (!elo || elo >= 3190) {
    cmds.push('setoption name UCI_LimitStrength value false');
    cmds.push('setoption name Skill Level value 20');
  } else if (elo >= 1320) {
    cmds.push('setoption name UCI_LimitStrength value true');
    cmds.push('setoption name UCI_Elo value ' + elo);
    cmds.push('setoption name Skill Level value 20');
  } else {
    cmds.push('setoption name UCI_LimitStrength value false');
    // Map ~200..1320 onto Skill Level 0..19 (0 = weakest beginner).
    const sk = Math.max(0, Math.min(19, Math.round(((elo - 200) / (1320 - 200)) * 19)));
    cmds.push('setoption name Skill Level value ' + sk);
  }
  return cmds;
}

// For lower target strengths, also shorten the search so the recommended move
// reflects shallow, human-like calculation rather than deep engine vision.
function effectiveDepth(elo, depth) {
  const d = depth || 18;
  if (elo && elo < 1320) return Math.min(d, 8);
  if (elo && elo < 2000) return Math.min(d, 12);
  return d;
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
      pendingCommands.push(`go depth ${goDepth}`);
    } else {
      // Send analysis commands (they'll be queued properly in module mode)
      sendToEngine('stop');
      strengthCmds.forEach((c) => sendToEngine(c));
      sendToEngine(`position fen ${fen}`);
      sendToEngine(`go depth ${goDepth}`);
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
