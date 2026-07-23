// session.js — the only mutable state in the greybox (spec §3.3, §4.2, §4.5).
// Pure state machine: no DOM, no timers. Render/audio consume the event
// objects returned by onTap. Timing lives in feel.json, never here.

import { EMPTY, MARK, OFFICER, AUTO_X } from './board.js';
import { eliminationGroups, recomputeElimination, completedRegions } from './rules.js';

export function createSession(board, tuning) {
  return {
    board,
    cellState: new Uint8Array(board.n * board.n), // all EMPTY
    hearts: tuning.hearts,
    status: 'playing', // 'playing' | 'won' | 'failed'
    placedCount: 0,
    seedLog: board.id, // provenance: pool id of the baked board
    announced: new Set(), // regions already announced complete
  };
}

// spec §4.2 — exact placement resolution order. The ack (step 1) is fired by
// the input layer BEFORE calling onTap; this function starts at step 2.
export function onTap(session, r, c, tuning) {
  const board = session.board;
  const n = board.n;
  const idx = r * n + c;

  if (session.status !== 'playing') return { type: 'ignored', hearts: session.hearts, status: session.status };

  const st = session.cellState[idx];

  // step 3 — BLOCKED: system-crossed cell. No heart, ever (P7 legibility).
  if (st === AUTO_X) return { type: 'blocked', cell: { r, c }, hearts: session.hearts, status: session.status };

  // step 4 — EMPTY → MARK. No heart, ever (AC#5).
  if (st === EMPTY) {
    session.cellState[idx] = MARK;
    return { type: 'mark', cell: { r, c }, hearts: session.hearts, status: session.status };
  }

  // cycle close — OFFICER → EMPTY. Frees the elimination this officer caused.
  if (st === OFFICER) {
    session.cellState[idx] = EMPTY;
    session.placedCount--;
    recomputeElimination(board, session.cellState);
    session.announced = new Set(completedRegions(board, session.cellState));
    return { type: 'unplace', cell: { r, c }, hearts: session.hearts, status: session.status };
  }

  // step 5/6 — MARK → attempt OFFICER. AD-4: direct comparison to solution.
  if (c === board.solution[r]) {
    session.cellState[idx] = OFFICER;
    session.placedCount++;
    const cascade = eliminationGroups(board, session.cellState, r, c);
    applyCascade(session, cascade);
    const done = completedRegions(board, session.cellState);
    const regionsCompleted = [];
    for (let i = 0; i < done.length; i++) {
      if (!session.announced.has(done[i])) { session.announced.add(done[i]); regionsCompleted.push(done[i]); }
    }
    if (session.placedCount === n) session.status = 'won';
    return {
      type: 'place', cell: { r, c }, cascade, regionsCompleted,
      hearts: session.hearts, status: session.status,
    };
  }

  // WRONG — costs exactly one heart; cell returns to MARK (it was MARK).
  session.hearts--;
  if (session.hearts === 0) session.status = 'failed';
  return { type: 'wrong', cell: { r, c }, hearts: session.hearts, status: session.status };
}

function applyCascade(session, groups) {
  const order = ['row', 'column', 'diagonals', 'region'];
  for (let g = 0; g < order.length; g++) {
    const arr = groups[order[g]];
    for (let k = 0; k < arr.length; k++) session.cellState[arr[k]] = AUTO_X;
  }
}

// spec §4.5 — single-tap instant retry: same board, cellState cleared.
export function retry(session, tuning) {
  session.cellState.fill(EMPTY);
  session.hearts = tuning.hearts;
  session.status = 'playing';
  session.placedCount = 0;
  session.announced = new Set();
  return session;
}
