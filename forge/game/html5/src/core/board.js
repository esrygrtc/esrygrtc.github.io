// board.js — Board model for #141 P1 greybox (spec §3.2).
// Pure: no DOM, no window, no allocation after construction.
// A Board is constructed once from a baked level and never mutated.

export const EMPTY = 0;
export const MARK = 1;    // player ✕ — free, never costs a heart
export const OFFICER = 2; // placed officer
export const AUTO_X = 3;  // system-eliminated cell

export function createBoard(level) {
  const n = level.n;
  const regions = Int8Array.from(level.regions);
  const solution = Int8Array.from(level.solution);
  return Object.freeze({
    id: level.id,
    n,
    tier: level.tier,
    teaches: level.teaches,
    thiefCell: Object.freeze({ r: level.thiefCell.r, c: level.thiefCell.c }),
    regions,
    solution,
  });
}
