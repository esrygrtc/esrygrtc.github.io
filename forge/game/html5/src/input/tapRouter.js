// tapRouter.js — pointer → cell; ack dispatch; AMENDMENT 2+6 grammar (§4.1/§4.2).
// The ack fires from the pointerdown handler BEFORE gesture classification and
// BEFORE any rules work: every tap acknowledges ≤50ms, including rejected
// taps. The double-tap window delays the OUTCOME, never the acknowledgement.
//
// AMENDMENT 6 (SUPERSEDE grammar, PULSE v4):
//   Tap 1 on EMPTY → mark tween starts immediately (≤50ms ack budget).
//   Tap 1 on MARK  → erase DEFERRED to window-expiry (toggle-commit).
//     Tap 2 within window → double-tap from MARK (supersede; erase canceled).
//     Window expires → erase fires, 90ms reversed tween plays.
//   Supersede-cancel (tap 2 inside window on a just-marked cell):
//     in-flight mark tween killed same-frame (≤16ms, no penalty tween).
//
// #143 Option II — stage-2 routing: mark/erase on AUTO_X cells, thiefFound/
// thiefWrong on double-tap accuse. Gates during bloom/flip (ack-only).

import { RECT_SLOTS } from '../render/layout.js';
import {
  fxAck, fxMark, fxUnmark, fxPlace, fxCascade, fxRegionPulse,
  fxBlockedPulse, fxHeartLoss, fxWrongCell, fxThiefFound,
  killTweenByCell, TW_MARK,
} from '../render/fx.js';
import { markDirty } from '../render/boardRenderer.js';
import {
  sfxMark, sfxPlace, sfxCascade, sfxBlocked, sfxWrong, sfxRegion, sfxUi, sfxUnlock,
  sfxCatchCuff,
} from '../audio/sfx.js';
import { onTap } from '../core/session.js';
import { EMPTY, MARK, OFFICER, AUTO_X } from '../core/board.js';

function buzz(pattern) {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (e) { /* no-op */ }
  }
}

export function attachTapRouter(canvas, G) {
  // gesture classification state (AMENDMENT 2 §4.1): same cell + second
  // pointerdown within feel.doubleTapWindowMs → 'double'.
  let lastCell = -1;
  let lastDownMs = -1e9;

  // AMENDMENT 6 — deferred toggle-commit erase for MARK cells.
  let eraseTimerId = null;
  let eraseCell = -1;

  function firePendingErase() {
    eraseTimerId = null;
    if (eraseCell < 0) return;
    // Guard: cell must still be MARK (a double-tap may have consumed it)
    if (G.session.cellState[eraseCell] !== MARK) { eraseCell = -1; return; }
    const n = G.board.n;
    const r = (eraseCell / n) | 0;
    const c = eraseCell % n;
    const ev = onTap(G.session, r, c, 'single', G.tuning);
    routeEvent(G, ev, eraseCell);
    markDirty(G.renderer);
    eraseCell = -1;
  }

  const handler = (e) => {
    e.preventDefault();
    sfxUnlock(G.sfx); // iOS autoplay policy: unlock inside first pointerdown

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (390 / rect.width);
    const y = (e.clientY - rect.top) * (844 / rect.height);

    // HUD: mute toggle (always live)
    const mz = G.zones.mute;
    if (x >= mz.x && x <= mz.x + mz.w && y >= mz.y && y <= mz.y + mz.h) {
      G.onMute();
      return;
    }

    // HUD: action button (won → next / failed → retry) — tappable instantly
    if (G.ui.phase === 'won' || G.ui.phase === 'failed') {
      const az = G.zones.action;
      if (x >= az.x && x <= az.x + az.w && y >= az.y && y <= az.y + az.h) {
        sfxUi(G.sfx);
        G.onAction();
        return;
      }
    }

    // #143: gate during bloom/flip — ack only, no board taps
    if (G.ui.phase !== 'play' && G.ui.phase !== 'find') return;

    // board hit-test
    const cellIdx = hitCell(G.layout, G.board.n, x, y);
    if (cellIdx < 0) return;

    const r = (cellIdx / G.board.n) | 0;
    const c = cellIdx % G.board.n;

    // spec §4.2 — ACK FIRST, unconditional, before classification
    fxAck(G.fx, cellIdx);
    buzz(8);
    markDirty(G.renderer);

    // spec §4.5: heart-loss input pause (1500ms, tunable) — ack still fired
    if (G.clock < (G.inputLockedUntil || 0)) return;

    const now = performance.now();
    const n = G.board.n;

    // --- gesture classification (feel.doubleTapWindowMs — never hard-coded) ---
    if (cellIdx === lastCell && now - lastDownMs <= G.feel.doubleTapWindowMs) {
      // DOUBLE-TAP — cancel any pending erase (supersede)
      if (eraseTimerId !== null) { clearTimeout(eraseTimerId); eraseTimerId = null; eraseCell = -1; }
      lastDownMs = -1e9; // a third tap inside the window starts fresh
      lastCell = -1;
      const ev = onTap(G.session, r, c, 'double', G.tuning);
      routeEvent(G, ev, cellIdx);
      markDirty(G.renderer);
      return;
    }

    // FIRST TAP (potential single)
    lastDownMs = now;
    lastCell = cellIdx;

    const st = G.session.cellState[cellIdx];
    const stage = G.session.stage;

    if (stage === 1) {
      // ════════════════════════════════════════════════════════════════
      // STAGE 1 — original AMENDMENT 2+6 grammar
      // ════════════════════════════════════════════════════════════════
      if (st === EMPTY) {
        const ev = onTap(G.session, r, c, 'single', G.tuning);
        routeEvent(G, ev, cellIdx);
        markDirty(G.renderer);
      } else if (st === MARK) {
        // AMENDMENT 6 — DEFER erase to window-expiry (toggle-commit)
        if (eraseTimerId !== null) { clearTimeout(eraseTimerId); eraseCell = -1; }
        eraseCell = cellIdx;
        eraseTimerId = setTimeout(firePendingErase, G.feel.doubleTapWindowMs);
      } else {
        // OFFICER (terminal) or AUTO_X (blocked) — fire immediately
        const ev = onTap(G.session, r, c, 'single', G.tuning);
        routeEvent(G, ev, cellIdx);
        markDirty(G.renderer);
      }
    } else {
      // ════════════════════════════════════════════════════════════════
      // STAGE 2 — FIND grammar (§3): AUTO_X ⇄ MARK, double = accuse
      // ════════════════════════════════════════════════════════════════
      if (st === AUTO_X) {
        // single → mark (suspect pencil), double → accuse (handled above)
        const ev = onTap(G.session, r, c, 'single', G.tuning);
        routeEvent(G, ev, cellIdx);
        markDirty(G.renderer);
      } else if (st === MARK) {
        // same deferred logic as stage 1: erase on window expiry, accuse on double
        if (eraseTimerId !== null) { clearTimeout(eraseTimerId); eraseCell = -1; }
        eraseCell = cellIdx;
        eraseTimerId = setTimeout(firePendingErase, G.feel.doubleTapWindowMs);
      } else {
        // OFFICER / THIEF (terminal) — fire immediately
        const ev = onTap(G.session, r, c, 'single', G.tuning);
        routeEvent(G, ev, cellIdx);
        markDirty(G.renderer);
      }
    }
  };
  canvas.addEventListener('pointerdown', handler, { passive: false });
  return handler;
}

function hitCell(layout, n, x, y) {
  for (let i = 0; i < n * n; i++) {
    const cx = layout.cell[i * RECT_SLOTS], cy = layout.cell[i * RECT_SLOTS + 1];
    const s = layout.cell[i * RECT_SLOTS + 2];
    if (x >= cx && x <= cx + s && y >= cy && y <= cy + s) return i;
  }
  return -1;
}

function routeEvent(G, ev, cellIdx) {
  const n = G.board.n;
  switch (ev.type) {
    case 'mark':
      fxMark(G.fx, cellIdx);
      sfxMark(G.sfx);
      buzz(10);
      break;
    case 'erase':
      fxUnmark(G.fx, cellIdx);
      sfxMark(G.sfx);
      buzz(10);
      break;
    case 'terminal':
      // OFFICER/THIEF is terminal — ack already fired; nothing else.
      break;
    case 'place': {
      killTweenByCell(G.fx, cellIdx, TW_MARK);
      fxPlace(G.fx, cellIdx);
      sfxPlace(G.sfx);
      buzz(18);
      const rings = fxCascade(G.fx, ev.cascade, G.feel.cascade.ringOrder);
      for (let ring = 0; ring < rings; ring++) sfxCascade(G.sfx, ring, rings);
      for (const reg of ev.regionsCompleted) {
        fxRegionPulse(G.fx, G.board, reg, n);
        sfxRegion(G.sfx);
      }
      // #143: stage-1 solve → bloom→flip (NOT 'won')
      if (ev.solvedBoard) G.onSolve();
      break;
    }
    case 'blocked':
      fxBlockedPulse(G.fx, cellIdx);
      sfxBlocked(G.sfx);
      break;
    case 'wrong':
      fxHeartLoss(G.fx, cellIdx, ev.hearts);
      sfxWrong(G.sfx);
      buzz([24, 40, 24]);
      G.inputLockedUntil = G.clock + G.tuning.heartLossPauseMs;
      if (ev.status === 'failed') G.onFail();
      break;
    // ════════════════════════════════════════════════════════════════
    // #143 Option II — stage-2 events
    // ════════════════════════════════════════════════════════════════
    case 'thiefFound':
      killTweenByCell(G.fx, cellIdx, TW_MARK);
      fxThiefFound(G.fx, cellIdx);
      sfxCatchCuff(G.sfx);
      buzz([20, 30, 20]);
      if (ev.status === 'won') G.onStage2Clear();
      break;
    case 'thiefWrong':
      // Row 15 — amber rim + gentle ±2px shake
      fxWrongCell(G.fx, cellIdx);
      sfxWrong(G.sfx);
      buzz([15, 30, 15]);
      G.inputLockedUntil = G.clock + G.tuning.heartLossPauseMs;
      if (ev.status === 'failed') G.onFail();
      break;
    case 'ignored':
    default:
      break;
  }
}
