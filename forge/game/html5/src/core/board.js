// board.js — Board model for #141 P1 greybox (spec §3.2).
// Pure: no DOM, no window, no allocation after construction.
// A Board is constructed once from a baked level and never mutated.
// #143: thiefCell (single) replaced with stage2 (k, thieves, thiefSet, hideSteps).

export const EMPTY = 0;
export const MARK = 1;    // player ✕ — free, never costs a heart
export const OFFICER = 2; // placed officer
export const AUTO_X = 3;  // system-eliminated cell
export const THIEF = 4;   // caught thief (terminal, stage-2 #143)

export function createBoard(level) {
  const n = level.n;
  const regions = Int8Array.from(level.regions);
  const solution = Int8Array.from(level.solution);
  const s2 = level.stage2 || {};
  const thiefFlat = (s2.thieves || []).map(t => t.r * n + t.c);
  const thiefSet = new Set(thiefFlat);
  return Object.freeze({
    id: level.id,
    n,
    tier: level.tier,
    teaches: level.teaches,
    regions,
    solution,
    stage2: Object.freeze({
      k: s2.k || 0,
      thieves: Object.freeze(thiefFlat),
      thiefSet,
      hideSteps: Object.freeze((s2.hideSteps || []).map(s => Object.freeze({ ...s }))),
      thiefRatio: s2.thiefRatio || 0.5,
    }),
  });
}
