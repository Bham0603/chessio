// Paste this into the Chrome DevTools console on Chess.com to diagnose DOM structure
(function() {
  const out = [];
  
  // 1. Find board
  const board = document.querySelector('wc-chess-board, chess-board, .board');
  out.push('=== BOARD ===');
  out.push('Board tag: ' + (board ? board.tagName : 'NOT FOUND'));
  out.push('Board classes: ' + (board ? board.className : 'N/A'));
  out.push('Has shadowRoot: ' + (board ? !!board.shadowRoot : 'N/A'));
  
  // 2. Check pieces in various locations
  out.push('\n=== PIECE SEARCH ===');
  
  // Light DOM (direct children of board)
  if (board) {
    const lightPieces = board.querySelectorAll('.piece');
    out.push('board.querySelectorAll(".piece"): ' + lightPieces.length);
    if (lightPieces.length > 0) {
      out.push('  First piece classes: ' + lightPieces[0].className);
      out.push('  First piece tag: ' + lightPieces[0].tagName);
    }
  }
  
  // Shadow DOM
  if (board && board.shadowRoot) {
    const shadowPieces = board.shadowRoot.querySelectorAll('.piece');
    out.push('board.shadowRoot.querySelectorAll(".piece"): ' + shadowPieces.length);
    if (shadowPieces.length > 0) {
      out.push('  First shadow piece classes: ' + shadowPieces[0].className);
    }
    // Check shadow root children  
    out.push('Shadow root child count: ' + board.shadowRoot.childElementCount);
    const shadowChildren = board.shadowRoot.children;
    for (let i = 0; i < Math.min(5, shadowChildren.length); i++) {
      out.push('  Shadow child ' + i + ': <' + shadowChildren[i].tagName + '> class="' + shadowChildren[i].className + '"');
    }
  }
  
  // Global document search
  const globalPieces = document.querySelectorAll('.piece');
  out.push('document.querySelectorAll(".piece"): ' + globalPieces.length);
  if (globalPieces.length > 0) {
    for (let i = 0; i < Math.min(3, globalPieces.length); i++) {
      out.push('  Piece ' + i + ': <' + globalPieces[i].tagName + '> class="' + globalPieces[i].className + '"');
      out.push('    parent: <' + globalPieces[i].parentElement?.tagName + '> class="' + globalPieces[i].parentElement?.className + '"');
      out.push('    style: ' + globalPieces[i].getAttribute('style'));
    }
  }
  
  // 3. Board children
  if (board) {
    out.push('\n=== BOARD CHILDREN ===');
    out.push('Direct children: ' + board.children.length);
    for (let i = 0; i < Math.min(10, board.children.length); i++) {
      const child = board.children[i];
      out.push('  Child ' + i + ': <' + child.tagName + '> class="' + child.className + '" id="' + child.id + '"');
    }
  }
  
  // 4. Alternative selectors
  out.push('\n=== ALT SELECTORS ===');
  const alt1 = document.querySelectorAll('[class*="piece"]');
  out.push('[class*="piece"]: ' + alt1.length);
  const alt2 = document.querySelectorAll('[data-piece]');
  out.push('[data-piece]: ' + alt2.length);
  const alt3 = document.querySelectorAll('[class*="square-"]');
  out.push('[class*="square-"]: ' + alt3.length);
  if (alt3.length > 0) {
    for (let i = 0; i < Math.min(3, alt3.length); i++) {
      out.push('  square el ' + i + ': <' + alt3[i].tagName + '> class="' + alt3[i].className + '"');
    }
  }
  
  // 5. Board attributes
  if (board) {
    out.push('\n=== BOARD ATTRIBUTES ===');
    for (const attr of board.attributes) {
      out.push('  ' + attr.name + '="' + attr.value.substring(0, 100) + '"');
    }
  }

  console.log(out.join('\n'));
  alert(out.join('\n'));
})();
