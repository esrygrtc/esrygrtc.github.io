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
//
// #143 Option II — two-act session: stage 1 (cop-solve) → stage 2 (FIND thieves).
// Act 2 reuses MARK for suspect pencil-marks; double-tap accuses THIEF.

import { EMPTY, MARK, OFFICER, AUTO_X, THIEF } from './board.js';
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
    // #143 Option II — stage-2 state
    stage: 1,            // 1 = cop-solve (DAY), 2 = FIND thieves (NIGHT)
    thievesFound: 0,     // count of caught thieves in act 2
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
  //    In stage 2, AUTO_X cells are searchable — NOT blocked (§3).
  if (st === AUTO_X && session.stage === 1) return { type: 'blocked', cell: { r, c }, hearts: session.hearts, status: session.status };

  // 3. OFFICER is terminal — ack only, nothing else (both stages).
  if (st === OFFICER) return { type: 'terminal', cell: { r, c }, hearts: session.hearts, status: session.status };

  // 3b. THIEF is terminal — ack only (stage 2).
  if (st === THIEF) return { type: 'terminal', cell: { r, c }, hearts: session.hearts, status: session.stage };

  // ════════════════════════════════════════════════════════════════════
  // STAGE 2 — FIND the hidden thieves (Option II, §3)
  // ════════════════════════════════════════════════════════════════════
  if (session.stage === 2) {
    // Only AUTO_X cells are searchable (OFFICER/THIEF handled above).
    // MARK cells: single toggles back to AUTO_X (erase), double accuses.
    if (st === MARK) {
      if (gesture === 'single') {
        session.cellState[idx] = AUTO_X;
        return { type: 'erase', cell: { r, c }, hearts: session.hearts, status: session.status };
      }
      // double-tap from MARK = accuse
      return accuseThief(session, board, r, c, idx, tuning);
    }

    // st === AUTO_X (searchable)
    if (gesture === 'single') {
      session.cellState[idx] = MARK;
      return { type: 'mark', cell: { r, c }, hearts: session.hearts, status: session.status };
    }

    // double-tap on AUTO_X = accuse
    return accuseThief(session, board, r, c, idx, tuning);
  }

  // ════════════════════════════════════════════════════════════════════
  // STAGE 1 — cop-solve (DAY, original §4.2 grammar)
  // ════════════════════════════════════════════════════════════════════

  // 4. single tap — TOGGLE EMPTY ⇄ MARK. Free in either direction (AC#5).
  if (gesture === 'single') {
    if (st === EMPTY) {
      session.cellState[idx] = MARK;
      return { type: 'mark', cell: { r, c }, hearts: session.hearts, status: session.status };
    }
    // st === MARK → erase
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
    // #143: do NOT set status='won' on full solve — return solvedBoard flag
    // so main.js can run bloom→flip→enterStage2. status stays 'playing'.
    const solvedBoard = session.placedCount === n;
    return {
      type: 'place', cell: { r, c }, cascade, regionsCompleted,
      hearts: session.hearts, status: session.status,
      solvedBoard,
    };
  }

  // WRONG — costs exactly one heart; cell returns to its PRE-TAP state
  // (untouched here: we never mutated it). T2 muted feedback, never heavy.
  session.hearts--;
  if (session.hearts === 0) session.status = 'failed';
  return { type: 'wrong', cell: { r, c }, hearts: session.hearts, status: session.status };
}

// #143 §3 — thief accusation (stage 2 double-tap on searchable cell)
function accuseThief(session, board, r, c, idx, tuning) {
  const s2 = board.stage2;
  if (s2.thiefSet.has(idx)) {
    // CORRECT — thief caught!
    session.cellState[idx] = THIEF;
    session.thievesFound++;
    const remaining = s2.k - session.thievesFound;
    // find this thief's hideStep metadata for analytics
    const order = session.thievesFound; // 1-based
    const hideStep = s2.hideSteps.find(s => s.r === r && s.c === c);
    const depth = hideStep ? hideStep.depth : 0;
    const watchers = hideStep ? hideStep.watchers : 0;
    if (session.thievesFound === s2.k) {
      session.status = 'won';
    }
    return {
      type: 'thiefFound', cell: { r, c }, order, depth, watchers,
      remaining, hearts: session.hearts, status: session.status,
    };
  }

  // WRONG accusation
  if (tuning.stage2 && tuning.stage2.wrongHideoutCostsHeart) {
    session.hearts--;
    if (session.hearts === 0) session.status = 'failed';
  }
  // cell returns to pre-tap state (AUTO_X or MARK — we never mutated it)
  return {
    type: 'thiefWrong', cell: { r, c },
    hearts: session.hearts, status: session.status,
  };
}

function applyCascade(session, groups) {
  const order = ['row', 'column', 'diagonals', 'region'];
  for (let g = 0; g < order.length; g++) {
    const arr = groups[order[g]];
    for (let k = 0; k < arr.length; k++) session.cellState[arr[k]] = AUTO_X;
  }
}

// #143 §4 — enterStage2: mutates NO cell state. Flips stage flag only.
// The palette/chrome flip is handled by main.js + boardRenderer.js.
export function enterStage2(session) {
  session.stage = 2;
}

// spec §4.5 — retry: same board, full two-act reset.
export function retry(session, tuning) {
  session.cellState.fill(EMPTY);
  session.hearts = tuning.hearts;
  session.status = 'playing';
  session.placedCount = 0;
  session.announced = new Set();
  session.stage = 1;
  session.thievesFound = 0;
  return session;
}
