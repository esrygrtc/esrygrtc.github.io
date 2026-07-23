// rules.js — COPDOKU rules for #141 P1 greybox (spec §2, §4.3).
// Pure: no DOM. isLegal · autoEliminate (grouped cascade) · coverage.
// Wrong-placement detection itself is AD-4: cell.c !== solution[cell.r]
// (direct comparison, O(1), no solver) — that check lives in session.js.

import { EMPTY, MARK, OFFICER, AUTO_X } from './board.js';

// True if an officer at (r,c) violates no rule against the officers already
// on the board (row ∪ column ∪ region ∪ 8-neighbourhood). Rule predicate for
// tests/verifier equivalence — the session's wrong-placement path is AD-4.
export function isLegal(board, cellState, r, c) {
  const n = board.n;
  const reg = board.regions[r * n + c];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (cellState[i * n + j] !== OFFICER) continue;
      if (i === r || j === c) return false;
      if (board.regions[i * n + j] === reg) return false;
      let dr = i - r; if (dr < 0) dr = -dr;
      let dc = j - c; if (dc < 0) dc = -dc;
      if ((dr > dc ? dr : dc) === 1) return false;
    }
  }
  return true;
}

// Cells NEWLY eliminated by an officer placed at (r,c), grouped for the
// cascade animation. Ring order is PULSE's sequence grammar:
// row → column → diagonals (emphasized) → region remainder.
// Only EMPTY cells are taken (manual MARKs and officers are never overridden).
export function eliminationGroups(board, cellState, r, c) {
  const n = board.n;
  const reg = board.regions[r * n + c];
  const groups = { row: [], column: [], diagonals: [], region: [] };
  const seen = new Set([r * n + c]);
  const take = (arr, i) => {
    if (cellState[i] === EMPTY && !seen.has(i)) { seen.add(i); arr.push(i); }
  };
  for (let j = 0; j < n; j++) take(groups.row, r * n + j);
  for (let i = 0; i < n; i++) take(groups.column, i * n + c);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const i = r + dr, j = c + dc;
      if (i >= 0 && i < n && j >= 0 && j < n) take(groups.diagonals, i * n + j);
    }
  }
  for (let i = 0; i < n * n; i++) {
    if (board.regions[i] === reg) take(groups.region, i);
  }
  return groups;
}

// Recompute ALL AUTO_X from the placed officers. AUTO_X is derived state:
// removing an officer frees the cells it alone eliminated (spec §4.3 model).
// MARK and OFFICER cells are never touched.
// recomputeElimination removed (AMENDMENT 2 §2.2): OFFICER is terminal in P1,
// so there is no unplace path and nothing to recompute.

// Per-region coverage: a cell counts as resolved when it is not EMPTY
// (officer, manual ✕, or auto ✕). Region complete ⇒ resolved === total.
export function regionCoverage(board, cellState, out) {
  const n = board.n;
  for (let r = 0; r < n; r++) { out.total[r] = 0; out.resolved[r] = 0; }
  for (let i = 0; i < n * n; i++) {
    const reg = board.regions[i];
    out.total[reg]++;
    if (cellState[i] !== EMPTY) out.resolved[reg]++;
  }
  return out;
}

export function makeCoverage(n) {
  return { total: new Array(n).fill(0), resolved: new Array(n).fill(0) };
}

export function completedRegions(board, cellState) {
  const cov = regionCoverage(board, cellState, makeCoverage(board.n));
  const out = [];
  for (let r = 0; r < cov.total.length; r++) {
    if (cov.total[r] > 0 && cov.resolved[r] === cov.total[r]) out.push(r);
  }
  return out;
}
