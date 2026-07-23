// fx.js — envelope/tween runner driven by feel.json (spec §6, game-feel §6).
// PULSE's timing table transcribed verbatim: every ms/easing value is read
// from the feel data passed in — no timing constant is hard-coded here.
// Zero per-frame allocation: a fixed tween pool is recycled; per-frame work is
// indexed loops over typed arrays only.

// ---------------------------------------------------------------- easing
// cubic-bezier solver (standard); easings built once at load from feel.json.
function makeBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return function (x) {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (e > -1e-6 && e < 1e-6) return sy(t);
      const d = dx(t);
      if (d > -1e-6 && d < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1; t = x;
    while (hi - lo > 1e-6) {
      const v = sx(t);
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

// ------------------------------------------------------------- tween kinds
export const TW_ACK = 0;        // tap-ack scale pop (PULSE row 1)
export const TW_MARK = 1;       // x-mark fade+pop in (row 2)
export const TW_PLACE = 2;      // officer drop + overshoot (row 3)
export const TW_CASCADE = 3;    // auto-x pop per ring cell (row 4)
export const TW_REGION = 4;     // region-complete brightness pulse (row 5)
export const TW_SHAKE = 5;      // invalid/blocked/heart-loss shake (rows 8)
export const TW_RIM = 6;        // heart-loss red rim flash (row 8)

// board-level fx ids (not per-cell)
export const BF_BLOOM = 0;      // board-solve bloom (row 6)
export const BF_FAIL_FADE = 1;  // fail desaturate+settle (§4.5)
export const BF_SPOT = 2;       // thief spotlight progress (row 7)
export const BF_CONVERGE = 3;   // officers converge progress (row 7)
export const BF_SNAP = 4;       // cuff snap flash (row 7)
export const BF_HEART = 5;      // heart dim/drop (row 8) — slot per heart

const MAX_TW = 192;             // ≥ cells + headroom; recycled
const BOARD_FX = 6;

// per-cell output slots
export const FX_SCALE = 0;
export const FX_GLYPH_OPACITY = 1;
export const FX_BRIGHT = 2;
export const FX_SHAKEX = 3;
export const FX_RIM = 4;
export const FX_SLOTS = 5;

export function createFx(feel) {
  const eB = feel.easing.board;
  const eI = feel.easing.uiIn;
  const eO = feel.easing.uiOut;
  const easeBoard = makeBezier(eB[0], eB[1], eB[2], eB[3]);
  const easeUiIn = makeBezier(eI[0], eI[1], eI[2], eI[3]);
  const easeUiOut = makeBezier(eO[0], eO[1], eO[2], eO[3]);

  return {
    feel,
    easeBoard,
    easeUiIn,
    easeUiOut,
    now: 0,
    // tween pool: [active, kind, cellIdx, start, dur, delay, param0, param1]
    pool: new Float32Array(MAX_TW * 8),
    poolKind: new Int16Array(MAX_TW),
    poolCell: new Int16Array(MAX_TW),
    activeCount: 0,
    // outputs
    cellFx: null, // Float32Array(n*n*FX_SLOTS) — allocated per level load
    boardFx: new Float32Array(BOARD_FX * 4), // [value, start, dur, delay] per slot
  };
}

export function fxLoadLevel(fx, n) {
  fx.cellFx = new Float32Array(n * n * FX_SLOTS);
  // baseline: scale 1, glyph opacity 1, brightness 1
  for (let i = 0; i < n * n; i++) {
    fx.cellFx[i * FX_SLOTS + FX_SCALE] = 1;
    fx.cellFx[i * FX_SLOTS + FX_GLYPH_OPACITY] = 1;
    fx.cellFx[i * FX_SLOTS + FX_BRIGHT] = 1;
  }
  fx.boardFx.fill(0);
  fx.poolKind.fill(-1);
  fx.activeCount = 0;
}

function allocTween(fx, kind, cell, start, dur, delay, aux) {
  for (let t = 0; t < MAX_TW; t++) {
    if (fx.poolKind[t] === -1) {
      const b = t * 8;
      fx.poolKind[t] = kind;
      fx.poolCell[t] = cell;
      fx.pool[b] = start;
      fx.pool[b + 1] = dur;
      fx.pool[b + 2] = delay;
      fx.pool[b + 3] = aux || 0;
      fx.activeCount++;
      return t;
    }
  }
  return -1; // pool exhausted — drop the tween (visual only, never gameplay)
}

function freeTween(fx, t) {
  fx.poolKind[t] = -1;
  fx.activeCount--;
}

// ------------------------------------------------------------- triggers
export function fxAck(fx, cellIdx) {
  allocTween(fx, TW_ACK, cellIdx, fx.now, fx.feel.tapAck.totalMs, 0);
}
export function fxMark(fx, cellIdx) {
  allocTween(fx, TW_MARK, cellIdx, fx.now, fx.feel.xMark.totalMs, 0);
}
export function fxPlace(fx, cellIdx) {
  allocTween(fx, TW_PLACE, cellIdx, fx.now, fx.feel.officerPlace.settleMs, 0);
}
export function fxCascade(fx, groups, ringOrder) {
  const f = fx.feel.cascade;
  let ring = 0;
  for (let g = 0; g < ringOrder.length; g++) {
    const arr = groups[ringOrder[g]];
    if (arr.length === 0) continue;
    const isDiag = ringOrder[g] === 'diagonals';
    const delay = ring * f.ringStepMs + (isDiag ? f.diagonalEmphasisDelayMs : 0);
    for (let k = 0; k < arr.length; k++) {
      const t = allocTween(fx, TW_CASCADE, arr[k], fx.now, f.cellPopMs, delay);
      if (t >= 0) fx.pool[t * 8 + 3] = isDiag ? f.diagonalPopScaleBoost : 1; // param: pop scale boost
    }
    ring++;
  }
  return ring; // rings fired (for sfx ladder)
}
export function fxRegionPulse(fx, board, regionId, n) {
  for (let i = 0; i < n * n; i++) {
    if (board.regions[i] === regionId) {
      allocTween(fx, TW_REGION, i, fx.now, fx.feel.regionComplete.totalMs, 0);
    }
  }
}
export function fxShake(fx, cellIdx) {
  // blocked tap — interim FABLE row (AMENDMENT 2 §2.3): 80ms shake ±3px,
  // 2 cycles, NO rim flash and NO heart animation (must not read as a heart)
  const f = fx.feel.blockedTap;
  allocTween(fx, TW_SHAKE, cellIdx, fx.now, f.shakeMs, 0, f.shakeAmplitudePx * 100 + f.shakeCycles);
}
export function fxHeartLoss(fx, cellIdx, heartIndex) {
  const f = fx.feel.heartLoss;
  allocTween(fx, TW_RIM, cellIdx, fx.now, f.rimFlashMs, 0);
  allocTween(fx, TW_SHAKE, cellIdx, fx.now, f.shakeMs, 0, f.shakeAmplitudePx * 100 + f.shakeCycles);
  const b = BF_HEART * 4;
  fx.boardFx[b] = 0; // progress 0..1
  fx.boardFx[b + 1] = fx.now + f.heartDimDropDelayMs;
  fx.boardFx[b + 2] = f.heartDimDropMs;
  fx.boardFx[b + 3] = heartIndex; // which heart pip
}
export function fxBloom(fx) {
  const b = BF_BLOOM * 4;
  fx.boardFx[b] = 0;
  fx.boardFx[b + 1] = fx.now;
  fx.boardFx[b + 2] = fx.feel.boardSolveBloom.totalMs;
}
export function fxFailFade(fx) {
  const b = BF_FAIL_FADE * 4;
  fx.boardFx[b] = 0;
  fx.boardFx[b + 1] = fx.now;
  fx.boardFx[b + 2] = 250; // §4.5: 200–300 desaturate + settle
}
// Thief catch timeline (row 7): spotlight → converge → snap → settle.
// Skippable after skippableAfterMs; skip commits final state instantly.
export function fxThiefCatchStart(fx) {
  const f = fx.feel.thiefCatch;
  setBoardFx(fx, BF_SPOT, f.spotlightMs, 0);
  setBoardFx(fx, BF_CONVERGE, f.convergeMs, f.spotlightMs);
  setBoardFx(fx, BF_SNAP, f.cuffSnapMs, f.spotlightMs + f.convergeMs);
}
export function fxThiefCatchSkip(fx) {
  setBoardFxDone(fx, BF_SPOT);
  setBoardFxDone(fx, BF_CONVERGE);
  setBoardFxDone(fx, BF_SNAP);
}
function setBoardFx(fx, slot, dur, delay) {
  const b = slot * 4;
  fx.boardFx[b] = 0;
  fx.boardFx[b + 1] = fx.now + delay;
  fx.boardFx[b + 2] = dur;
}
function setBoardFxDone(fx, slot) {
  const b = slot * 4;
  fx.boardFx[b] = 1;
  fx.boardFx[b + 1] = 0;
  fx.boardFx[b + 2] = 1;
}
export function boardFxValue(fx, slot) {
  const b = slot * 4;
  const dur = fx.boardFx[b + 2];
  if (dur <= 0) return fx.boardFx[b];
  const start = fx.boardFx[b + 1];
  if (fx.now <= start) return 0;
  const t = (fx.now - start) / dur;
  const v = t >= 1 ? 1 : fx.easeBoard(t);
  fx.boardFx[b] = v;
  return v;
}
export function thiefCatchSkippable(fx) {
  return fx.now >= 0 && (fx.now - catchStart(fx)) >= fx.feel.thiefCatch.skippableAfterMs;
}
let _catchStart = 0;
function catchStart() { return _catchStart; }
export function noteCatchStart(fx) { _catchStart = fx.now; }

// ------------------------------------------------------------- update
// Called once per rAF with the tween clock (dt clamped to 32ms by main).
export function fxUpdate(fx, nowMs) {
  fx.now = nowMs;
  const cellFx = fx.cellFx;
  if (!cellFx) return;
  const feel = fx.feel;

  // reset per-frame outputs for cells with active tweens only (cheap pass)
  for (let t = 0; t < MAX_TW; t++) {
    const kind = fx.poolKind[t];
    if (kind === -1) continue;
    const b = t * 8;
    const start = fx.pool[b], dur = fx.pool[b + 1], delay = fx.pool[b + 2];
    const local = nowMs - start - delay;
    if (local < 0) continue;
    const cell = fx.poolCell[t];
    const cb = cell * FX_SLOTS;

    if (local >= dur) {
      // tween done: restore baseline values
      if (kind === TW_ACK || kind === TW_PLACE || kind === TW_CASCADE) cellFx[cb + FX_SCALE] = 1;
      if (kind === TW_MARK || kind === TW_CASCADE) cellFx[cb + FX_GLYPH_OPACITY] = 1;
      if (kind === TW_REGION) cellFx[cb + FX_BRIGHT] = 1;
      if (kind === TW_SHAKE) cellFx[cb + FX_SHAKEX] = 0;
      if (kind === TW_RIM) cellFx[cb + FX_RIM] = 0;
      freeTween(fx, t);
      continue;
    }

    const p = local / dur;
    if (kind === TW_ACK) {
      // 1.00→1.06 by scaleUpMs, back by totalMs (row 1)
      const up = feel.tapAck.scaleUpMs / dur;
      const peak = feel.tapAck.scalePeak;
      const v = p <= up ? fx.easeBoard(p / up) : 1 - fx.easeBoard((p - up) / (1 - up));
      cellFx[cb + FX_SCALE] = 1 + (peak - 1) * v;
    } else if (kind === TW_MARK) {
      const e = fx.easeBoard(p);
      cellFx[cb + FX_SCALE] = feel.xMark.scaleFrom + (feel.xMark.scaleTo - feel.xMark.scaleFrom) * e;
      cellFx[cb + FX_GLYPH_OPACITY] = feel.xMark.opacityFrom + (feel.xMark.opacityTo - feel.xMark.opacityFrom) * e;
    } else if (kind === TW_PLACE) {
      // drop in by dropMs, overshoot 1.12 @overshootAt, settle 1.00 @settleMs (row 3)
      const oAt = feel.officerPlace.overshootAt / dur;
      const peak = feel.officerPlace.overshootScale;
      if (p <= oAt) {
        cellFx[cb + FX_SCALE] = 1 + (peak - 1) * fx.easeBoard(p / oAt);
      } else {
        cellFx[cb + FX_SCALE] = peak - (peak - 1) * fx.easeBoard((p - oAt) / (1 - oAt));
      }
    } else if (kind === TW_CASCADE) {
      const boost = fx.pool[b + 3] || 1;
      const e = fx.easeBoard(p);
      const back = p < 0.5 ? 2 * e : 2 * (1 - e);
      cellFx[cb + FX_SCALE] = 1 + 0.25 * boost * back;
      cellFx[cb + FX_GLYPH_OPACITY] = e;
    } else if (kind === TW_REGION) {
      const peak = feel.regionComplete.brightnessPeak;
      const v = p < 0.5 ? 2 * fx.easeBoard(p) : 2 * (1 - fx.easeBoard(p));
      cellFx[cb + FX_BRIGHT] = 1 + (peak - 1) * v;
    } else if (kind === TW_SHAKE) {
      // amp/cycles packed at alloc from the OWNING feel row (blockedTap vs
      // heartLoss) — never cross-read a sibling row's constants (§11.2)
      const packed = fx.pool[b + 3];
      const amp = Math.floor(packed / 100), cycles = packed - amp * 100;
      cellFx[cb + FX_SHAKEX] = amp * Math.sin(p * cycles * 2 * Math.PI) * (1 - p);
    } else if (kind === TW_RIM) {
      cellFx[cb + FX_RIM] = 1 - fx.easeBoard(p);
    }
  }
}
