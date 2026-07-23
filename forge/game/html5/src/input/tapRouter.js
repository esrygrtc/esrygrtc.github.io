// tapRouter.js — pointer → cell; ack dispatch; AMENDMENT 2 grammar (§4.1/§4.2).
// The ack fires from the pointerdown handler BEFORE gesture classification and
// BEFORE any rules work: every tap acknowledges ≤50ms, including rejected
// taps. The double-tap window delays the OUTCOME, never the acknowledgement.

import { RECT_SLOTS } from '../render/layout.js';
import { fxAck, fxMark, fxPlace, fxCascade, fxRegionPulse, fxShake, fxHeartLoss } from '../render/fx.js';
import { markDirty } from '../render/boardRenderer.js';
import {
  sfxMark, sfxPlace, sfxCascade, sfxBlocked, sfxWrong, sfxRegion, sfxUi, sfxUnlock,
} from '../audio/sfx.js';
import { onTap } from '../core/session.js';

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

    // gesture classification (feel.doubleTapWindowMs — never hard-coded)
    const now = performance.now();
    let gesture = 'single';
    if (cellIdx === lastCell && now - lastDownMs <= G.feel.doubleTapWindowMs) {
      gesture = 'double';
      lastDownMs = -1e9; // a third tap inside the window starts fresh
      lastCell = -1;
    } else {
      lastDownMs = now;
      lastCell = cellIdx;
    }

    const ev = onTap(G.session, r, c, gesture, G.tuning);
    routeEvent(G, ev, cellIdx);
    markDirty(G.renderer);
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
      // mark erased (free revision): instant disappear + T1 click — same
      // sound as make (spec §4.6: "✕ mark (make or erase)")
      sfxMark(G.sfx);
      buzz(10);
      break;
    case 'terminal':
      // OFFICER is terminal in P1 — ack already fired; nothing else.
      break;
    case 'place': {
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
      fxShake(G.fx, cellIdx);
      sfxBlocked(G.sfx); // never above tier 1
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
