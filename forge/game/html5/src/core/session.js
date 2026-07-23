// session.js — the only mutable state in the greybox (spec §3.3, §4.2, §4.5).
// Pure state machine: no DOM, no timers. Render/audio consume the event
// objects returned by onTap. Timing lives in feel.json, never here.
//
// AMENDMENT 2 §2.2 grammar (replaces the retired 3-state cycle):
//   single tap  — EMPTY ⇄ MARK toggle, free in BOTH directions, never a heart
//   double-tap  — commits OFFICER from EMPTY or MARK (mis-tap guard: a single
//                 tap can never lose a heart)
//   AUTO_X      — rejects both gestures (blocked), no heart ever
//   OFFICER     — terminal in P1: ack-only, no transitions
// unplace/recomputeElimination are gone — only correct officers ever land.

import { EMPTY, MARK, OFFICER, AUTO_X } from './board.js';
import { eliminationGroups, completedRegions } from './rules.js';

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

// spec §4.2 (AMENDMENT 2) — exact placement resolution order. The ack is
// fired by the input layer BEFORE gesture classification and BEFORE calling
// onTap; this function starts at step 1 with gesture ∈ 'single' | 'double'.
export function onTap(session, r, c, gesture, tuning) {
  const board = session.board;
  const n = board.n;
  const idx = r * n + c;

  // 1. not playing → ignored
  if (session.status !== 'playing') return { type: 'ignored', hearts: session.hearts, status: session.status };

  const st = session.cellState[idx];

  // 2. BLOCKED: system-crossed cell rejects both gestures. No heart, ever.
  if (st === AUTO_X) return { type: 'blocked', cell: { r, c }, hearts: session.hearts, status: session.status };

  // 3. OFFICER is terminal in P1 — ack only, nothing else.
  if (st === OFFICER) return { type: 'terminal', cell: { r, c }, hearts: session.hearts, status: session.status };

  // 4. single tap — TOGGLE EMPTY ⇄ MARK. Free in either direction (AC#5).
  if (gesture === 'single') {
    if (st === EMPTY) {
      session.cellState[idx] = MARK;
      return { type: 'mark', cell: { r, c }, hearts: session.hearts, status: session.status };
    }
    session.cellState[idx] = EMPTY;
    return { type: 'erase', cell: { r, c }, hearts: session.hearts, status: session.status };
  }

  // 5. double-tap — attempt OFFICER from EMPTY or MARK (AD-4: direct compare)
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

  // WRONG — costs exactly one heart; cell returns to its PRE-TAP state
  // (untouched here: we never mutated it). T2 muted feedback, never heavy.
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
