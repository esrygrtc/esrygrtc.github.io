// layout.js — 390-width layout solver (spec §5, AD-1).
// Pure, no DOM. Computed ONCE per level load into pre-allocated typed arrays;
// the render loop reads it and never recomputes geometry (AC#7).

// Cell rect slots per cell: [x, y, w, h] in logical 390×844 space.
export const RECT_SLOTS = 4;

export function computeLayout(tuning, n) {
  const w = tuning.designWidthPx;
  const h = tuning.designHeightPx;
  const margin = tuning.sideMarginPx;
  const gap = tuning.gridGapPx;

  const hudH = 84;                       // hearts + level label strip
  const captionH = 132;                  // room below board for status/caught/retry
  const boardSize = Math.min(w - margin * 2, h - hudH - captionH);
  const cellPx = (boardSize - gap * (n - 1)) / n;
  const boardX = (w - boardSize) / 2;
  const boardY = hudH + 24;

  const cell = new Float32Array(n * n * RECT_SLOTS);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = (r * n + c) * RECT_SLOTS;
      cell[i] = boardX + c * (cellPx + gap);
      cell[i + 1] = boardY + r * (cellPx + gap);
      cell[i + 2] = cellPx;
      cell[i + 3] = cellPx;
    }
  }

  // AC#1 evidence: computed tap-target px, logged at load.
  const tapTargetPx = cellPx;
  console.log(`[layout] ${n}x${n} cell=${tapTargetPx.toFixed(1)}px (min ${tuning.minTapTargetPx}) board=${boardSize.toFixed(0)}px @${w}x${h}`);

  return { w, h, boardX, boardY, boardSize, cellPx, hudH, captionH, cell, tapTargetPx };
}

// HUD hit zones (logical space) — mute top-right, action (retry/next) bottom-center.
export function hudZones(tuning) {
  const w = tuning.designWidthPx;
  const h = tuning.designHeightPx;
  return {
    mute: { x: w - 60, y: 20, w: 44, h: 44 },
    action: { x: (w - 200) / 2, y: h - 96, w: 200, h: 56 },
  };
}
