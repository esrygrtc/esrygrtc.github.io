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

import { RECT_SLOTS } from '../render/layout.js';
import { fxAck, fxMark, fxUnmark, fxPlace, fxCascade, fxRegionPulse, fxShake, fxBlockedPulse, fxHeartLoss, killTweenByCell, TW_MARK } from '../render/fx.js';
import { markDirty } from '../render/boardRenderer.js';
import {
  sfxMark, sfxPlace, sfxCascade, sfxBlocked, sfxWrong, sfxRegion, sfxUi, sfxUnlock,
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
  // On tap 1 on a MARK cell, we do NOT erase immediately: the player might
  // be starting a double-tap (which commits from MARK). The erase fires only
  // when the double-tap window expires without a second tap.
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

    // catch cutscene: skippable after skippableAfterMs (row 7; lock ≤600ms)
    if (G.ui.phase === 'catch') { G.onCatchTap(); return; }
    if (G.ui.phase !== 'play') return;

    // board hit-test
    const cellIdx = hitCell(G.layout, G.board.n, x, y);
    if (cellIdx < 0) return;

    const r = (cellIdx / G.board.n) | 0;
    const c = cellIdx % G.board.n;

    // spec §4.2 — ACK FIRST, unconditional, before classification: visual pop
    // + light haptic, SILENT (row 1: a sounded ack would double-fire on a
    // double-tap).
    fxAck(G.fx, cellIdx);
    buzz(8);
    markDirty(G.renderer);

    // spec §4.5: heart-loss input pause (1500ms, tunable) — ack still fired
    // (every input acknowledged), rules work is gated.
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

    if (st === EMPTY) {
      // Mark appears IMMEDIATELY (PULSE v4: "row 2's tween ALWAYS starts on
      // tap 1 within the ≤50ms ack budget — NEVER wait for window expiry")
      const ev = onTap(G.session, r, c, 'single', G.tuning);
      routeEvent(G, ev, cellIdx);
      markDirty(G.renderer);
    } else if (st === MARK) {
      // AMENDMENT 6 — DEFER erase to window-expiry (toggle-commit). If tap 2
      // arrives inside the window, the double-tap commits from MARK and the
      // erase is canceled (supersede). Mark stays visible until expiry.
      if (eraseTimerId !== null) { clearTimeout(eraseTimerId); eraseCell = -1; }
      eraseCell = cellIdx;
      eraseTimerId = setTimeout(firePendingErase, G.feel.doubleTapWindowMs);
    } else {
      // OFFICER (terminal) or AUTO_X (blocked) — fire immediately
      const ev = onTap(G.session, r, c, 'single', G.tuning);
      routeEvent(G, ev, cellIdx);
      markDirty(G.renderer);
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
      // AMENDMENT 6 — toggle-commit mark-off: 90ms reversed tween (ONLY on
      // window-expiry; supersede-cancel kills the mark same-frame with no tween)
      fxUnmark(G.fx, cellIdx);
      sfxMark(G.sfx);
      buzz(10);
      break;
    case 'terminal':
      // OFFICER is terminal in P1 — ack already fired; nothing else.
      break;
    case 'place': {
      // SUPERSEDE: kill any in-flight mark tween on this cell (≤16ms same-frame)
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
      if (ev.status === 'won') G.onSolve();
      break;
    }
    case 'blocked':
      // PULSE v4 row 10 — neutral scale pulse; NO shake, NO rim, NO heart
      fxBlockedPulse(G.fx, cellIdx);
      sfxBlocked(G.sfx); // T0 sub-light, SILENT per v4
      break;
    case 'wrong':
      fxHeartLoss(G.fx, cellIdx, ev.hearts);
      sfxWrong(G.sfx);
      buzz([24, 40, 24]);
      G.inputLockedUntil = G.clock + G.tuning.heartLossPauseMs;
      if (ev.status === 'failed') G.onFail();
      break;
    case 'ignored':
    default:
      break;
  }
}
