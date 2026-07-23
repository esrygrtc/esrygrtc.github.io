// boardRenderer.js — Canvas2D renderer (spec §5). Dirty-region redraw: a
// static board costs ~0 draws. All geometry read from layout.cell (computed
// once per level load); the frame path allocates nothing.

import { EMPTY, MARK, OFFICER, AUTO_X } from '../core/board.js';
import { RECT_SLOTS } from './layout.js';
import {
  FX_SCALE, FX_GLYPH_OPACITY, FX_BRIGHT, FX_SHAKEX, FX_RIM, FX_SLOTS,
  BF_BLOOM, BF_FAIL_FADE, BF_SPOT, BF_CONVERGE, BF_SNAP, BF_HEART,
  boardFxValue,
} from './fx.js';

// Greybox visual language (spec §5 + CANVAS R1 sketch sheet, ef51bebd — the
// renderer contract): region = fill + border pattern, NEVER hue alone.
// 6 double-coded regions A–F; 3px stroke inset 1.5px inside own cells;
// shared edge = two parallel patterned strokes (one per region, never overlap).
const REGION_STYLE = [
  { fill: '#E4EEFB', edge: '#4A7FDB', dash: [] },                 // A — solid
  { fill: '#FBE7E7', edge: '#D95B5B', dash: [10, 6] },            // B — dashed
  { fill: '#E6F5EA', edge: '#45A866', dash: [0.5, 8], dot: true },// C — dotted
  { fill: '#FBF2DC', edge: '#D9A52E', dash: [], double: true },   // D — double
  { fill: '#F0EAFB', edge: '#8B5CF6', dash: [12, 4, 2, 4] },      // E — dash-dot
  { fill: '#DFF3F5', edge: '#2AA5B3', dash: [18, 7] },            // F — long-dash
];
const COL = {
  bg: '#EEF1F6',
  gridGap: '#EEF1F6',
  mark: '#5A6472',     // player ✕: 2.5–3px, 56% cell
  autoX: '#9AA4B0',    // system ✕: 2px, 44% — visibly quieter
  officer: '#2B3A55',  // disc + white star, 60% cell
  officerStar: '#FFFFFF',
  heart: '#E8443A',
  heartLost: '#D8DDE3', // outline only
  text: '#2B3A55',
  textDim: '#7A8496',
  rim: '#ff4d4d',
  thief: '#3A3F4A',
  thiefMask: '#e8e8e8',
  thiefRing: '#F2B33C', // 3px spotlight ring
  caught: '#B8860B',
};

export function createRenderer(canvas, board, session, layout, zones) {
  const ctx = canvas.getContext('2d');
  // Precompute region perimeter edge segments at load (allowed allocation):
  // for every cell, edges facing a different region or the board boundary.
  // Contract: 3px stroke inset 1.5px INSIDE the owning cell → each segment
  // carries an inward unit normal (nx, ny) so shared edges become two
  // parallel strokes 3px apart, and the "double" pattern can offset its
  // second line further inward.
  const n = board.n;
  const INSET = 1.5;
  const segs = []; // load-time only: reg, x1, y1, x2, y2, nx, ny
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const reg = board.regions[i];
      const x = layout.cell[i * RECT_SLOTS], y = layout.cell[i * RECT_SLOTS + 1];
      const s = layout.cell[i * RECT_SLOTS + 2];
      if (r === 0 || board.regions[i - n] !== reg) segs.push(reg, x, y + INSET, x + s, y + INSET, 0, 1);
      if (r === n - 1 || board.regions[i + n] !== reg) segs.push(reg, x, y + s - INSET, x + s, y + s - INSET, 0, -1);
      if (c === 0 || board.regions[i - 1] !== reg) segs.push(reg, x + INSET, y, x + INSET, y + s, 1, 0);
      if (c === n - 1 || board.regions[i + 1] !== reg) segs.push(reg, x + s - INSET, y, x + s - INSET, y + s, -1, 0);
    }
  }
  return {
    ctx, board, session, layout, zones,
    edges: Float32Array.from(segs),
    label: `${board.id} · ${board.tier} · teaches: ${board.teaches}`, // cached at load: no per-frame string allocs
    dirty: true,
  };
}

export function markDirty(R) { R.dirty = true; }

// Returns true if it drew. Caller decides whether to rAF again.
export function draw(R, fx, ui, muted) {
  if (!R.dirty && fx.activeCount === 0 && !ui.animating) return false;
  R.dirty = false;

  const { ctx, board, session, layout } = R;
  const n = board.n;
  const W = layout.w, H = layout.h;
  const cellFx = fx.cellFx;

  // ---- board-global fx values
  const bloom = boardFxValue(fx, BF_BLOOM);
  const failFade = boardFxValue(fx, BF_FAIL_FADE);
  const spot = boardFxValue(fx, BF_SPOT);
  const converge = boardFxValue(fx, BF_CONVERGE);
  const snap = boardFxValue(fx, BF_SNAP);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- cells
  for (let i = 0; i < n * n; i++) {
    const x = layout.cell[i * RECT_SLOTS], y = layout.cell[i * RECT_SLOTS + 1];
    const s = layout.cell[i * RECT_SLOTS + 2];
    const style = REGION_STYLE[board.regions[i] % REGION_STYLE.length];
    const bright = cellFx[i * FX_SLOTS + FX_BRIGHT];

    ctx.fillStyle = style.fill;
    ctx.fillRect(x, y, s, s);
    if (bright > 1.001) {
      ctx.globalAlpha = Math.min(0.35, (bright - 1) * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, s, s);
      ctx.globalAlpha = 1;
    }

    const st = session.cellState[i];
    if (st === EMPTY) continue;

    const scale = cellFx[i * FX_SLOTS + FX_SCALE];
    const gop = cellFx[i * FX_SLOTS + FX_GLYPH_OPACITY];
    const shx = cellFx[i * FX_SLOTS + FX_SHAKEX];
    const cx = x + s / 2 + shx;
    const cy = y + s / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.globalAlpha = gop;

    if (st === MARK) {
      ctx.strokeStyle = COL.mark;
      ctx.lineWidth = Math.min(3, Math.max(2.5, s * 0.035));
      ctx.lineCap = 'round';
      const a = s * 0.28; // 56% cell
      ctx.beginPath();
      ctx.moveTo(-a, -a); ctx.lineTo(a, a);
      ctx.moveTo(a, -a); ctx.lineTo(-a, a);
      ctx.stroke();
    } else if (st === AUTO_X) {
      ctx.strokeStyle = COL.autoX;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      const a = s * 0.22; // 44% cell — visibly quieter
      ctx.beginPath();
      ctx.moveTo(-a, -a); ctx.lineTo(a, a);
      ctx.moveTo(a, -a); ctx.lineTo(-a, a);
      ctx.stroke();
    } else if (st === OFFICER) {
      // converge: lerp officer glyph toward the thief cell (catch row 7)
      let dx = 0, dy = 0;
      if (converge > 0) {
        const ti = board.thiefCell.r * n + board.thiefCell.c;
        const tx = layout.cell[ti * RECT_SLOTS] + s / 2;
        const ty = layout.cell[ti * RECT_SLOTS + 1] + s / 2;
        dx = (tx - cx) * converge;
        dy = (ty - cy) * converge;
      }
      ctx.translate(dx, dy);
      const rad = s * 0.30; // 60% cell
      ctx.fillStyle = COL.officer;
      ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.officerStar;
      starPath(ctx, 0, 0, rad * 0.58, rad * 0.25, 5);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // heart-loss rim flash (row 8)
    const rim = cellFx[i * FX_SLOTS + FX_RIM];
    if (rim > 0.001) {
      ctx.strokeStyle = COL.rim;
      ctx.globalAlpha = rim;
      ctx.lineWidth = Math.max(2, s * 0.06);
      ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
      ctx.globalAlpha = 1;
    }
  }

  // ---- region perimeters (CANVAS R1: 3px, inset 1.5px, pattern per region)
  const E = R.edges;
  for (let k = 0; k < E.length; k += 7) {
    const style = REGION_STYLE[E[k] % REGION_STYLE.length];
    ctx.strokeStyle = style.edge;
    ctx.lineWidth = 3;
    ctx.lineCap = style.dot ? 'round' : 'butt';
    ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.moveTo(E[k + 1], E[k + 2]);
    ctx.lineTo(E[k + 3], E[k + 4]);
    ctx.stroke();
    if (style.double) {
      // second thin line 3px further inward — the "double" pattern
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(E[k + 1] + E[k + 5] * 3.5, E[k + 2] + E[k + 6] * 3.5);
      ctx.lineTo(E[k + 3] + E[k + 5] * 3.5, E[k + 4] + E[k + 6] * 3.5);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.lineCap = 'butt';

  // ---- board-solve bloom (row 6)
  if (bloom > 0.001) {
    const pulse = bloom < 0.5 ? 2 * bloom : 2 * (1 - bloom);
    ctx.globalAlpha = 0.20 * pulse * (fx.feel.boardSolveBloom.brightnessPeak - 1) * 5;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(layout.boardX, layout.boardY, layout.boardSize, layout.boardSize);
    ctx.globalAlpha = 1;
  }

  // ---- thief catch overlay (row 7): spotlight hole over thiefCell
  if (ui.phase === 'catch' || ui.phase === 'won') {
    const ti = board.thiefCell.r * n + board.thiefCell.c;
    const s = layout.cell[ti * RECT_SLOTS + 2];
    const tx = layout.cell[ti * RECT_SLOTS] + s / 2;
    const ty = layout.cell[ti * RECT_SLOTS + 1] + s / 2;
    if (spot < 1) {
      ctx.globalAlpha = 0.62 * spot;
      ctx.fillStyle = '#080a10';
      ctx.beginPath();
      ctx.rect(layout.boardX, layout.boardY, layout.boardSize, layout.boardSize);
      ctx.arc(tx, ty, s * (0.4 + 0.8 * spot), 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.globalAlpha = 1;
    }
    if (snap > 0) {
      // thief glyph revealed at the snap
      ctx.save();
      ctx.translate(tx, ty);
      const tr = s * 0.26 * (0.6 + 0.4 * snap);
      ctx.fillStyle = COL.thief;
      ctx.beginPath(); ctx.arc(0, 0, tr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COL.thiefMask;
      ctx.fillRect(-tr, -tr * 0.35, tr * 2, tr * 0.5);
      ctx.fillStyle = COL.thief;
      ctx.beginPath();
      ctx.arc(-tr * 0.35, -tr * 0.1, tr * 0.1, 0, Math.PI * 2);
      ctx.arc(tr * 0.35, -tr * 0.1, tr * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // thief ring: 3px #F2B33C spotlight converged on cell (CANVAS R1)
      ctx.strokeStyle = COL.thiefRing;
      ctx.lineWidth = 3;
      ctx.globalAlpha = snap;
      ctx.strokeRect(layout.cell[ti * RECT_SLOTS] + 1.5, layout.cell[ti * RECT_SLOTS + 1] + 1.5, s - 3, s - 3);
      ctx.globalAlpha = 1;
      if (snap > 0.4) {
        ctx.globalAlpha = (snap - 0.4) * 0.8;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(layout.boardX, layout.boardY, layout.boardSize, layout.boardSize);
        ctx.globalAlpha = 1;
      }
    }
  }

  // ---- fail desaturate + settle (§4.5: dignity, not punishment)
  if (ui.phase === 'failed') {
    ctx.globalAlpha = 0.55 * failFade;
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  drawHud(R, fx, ui, muted);
  return true;
}

function drawHud(R, fx, ui, muted) {
  const { ctx, layout, zones, board } = R;
  const W = layout.w;

  // hearts (spec §4.5) — heart-loss dim/drop per row 8
  const heartB = BF_HEART * 4;
  const heartStart = fx.boardFx[heartB + 1];
  const heartDur = fx.boardFx[heartB + 2];
  const heartIdx = fx.boardFx[heartB + 3] | 0;
  let heartProg = 1;
  if (heartDur > 0 && fx.now >= heartStart) {
    heartProg = Math.min(1, (fx.now - heartStart) / heartDur);
  }
  for (let h = 0; h < 3; h++) {
    const hx = 28 + h * 34, hy = 40;
    const alive = h < R.session.hearts;
    let dy = 0, dim = alive ? 0 : 1;
    if (h === heartIdx && heartProg < 1 && !alive) {
      dy = heartProg * 10;
      dim = heartProg;
    }
    ctx.save();
    ctx.translate(hx, hy + dy);
    ctx.scale(0.9, 0.9);
    if (alive) {
      ctx.fillStyle = COL.heart;
      heartPath(ctx, 0, 0, 11);
      ctx.fill();
    } else {
      // lost heart: outline only (CANVAS R1: #D8DDE3)
      ctx.globalAlpha = 1 - dim * 0.4;
      ctx.strokeStyle = COL.heartLost;
      ctx.lineWidth = 2;
      heartPath(ctx, 0, 0, 11);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // level label
  ctx.fillStyle = COL.textDim;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(R.label, W / 2, 46);

  // mute toggle (P9: audio is never untoggleable) — drawn speaker, no emoji
  // font dependency (headless/older devices render tofu otherwise)
  const mz = zones.mute;
  ctx.fillStyle = 'rgba(43,58,85,0.10)';
  roundRect(ctx, mz.x, mz.y, mz.w, mz.h, 8);
  ctx.fill();
  const mx = mz.x + mz.w / 2, my = mz.y + mz.h / 2;
  ctx.fillStyle = COL.text;
  ctx.beginPath();
  ctx.moveTo(mx - 9, my - 4); ctx.lineTo(mx - 4, my - 4); ctx.lineTo(mx + 1, my - 9);
  ctx.lineTo(mx + 1, my + 9); ctx.lineTo(mx - 4, my + 4); ctx.lineTo(mx - 9, my + 4);
  ctx.closePath(); ctx.fill();
  if (muted) {
    ctx.strokeStyle = COL.text; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(mx + 4, my - 5); ctx.lineTo(mx + 11, my + 5);
    ctx.moveTo(mx + 11, my - 5); ctx.lineTo(mx + 4, my + 5);
    ctx.stroke();
  } else {
    ctx.strokeStyle = COL.text; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(mx + 2, my, 6, -Math.PI / 3, Math.PI / 3);
    ctx.arc(mx + 2, my, 10, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();
  }

  // status / action row
  const az = zones.action;
  if (ui.phase === 'won') {
    ctx.fillStyle = COL.caught;
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText('THIEF CAUGHT!', W / 2, az.y - 18);
    ctx.fillStyle = '#2f7d4f';
    roundRect(ctx, az.x, az.y, az.w, az.h, 12);
    ctx.fill();
    ctx.fillStyle = '#eafff2';
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.fillText(ui.hasNext ? 'NEXT BOARD' : 'REPLAY PACK', W / 2, az.y + az.h / 2 + 6);
  } else if (ui.phase === 'failed') {
    ctx.fillStyle = COL.text;
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText('OUT OF HEARTS', W / 2, az.y - 18);
    ctx.fillStyle = '#7d4a2f';
    roundRect(ctx, az.x, az.y, az.w, az.h, 12);
    ctx.fill();
    ctx.fillStyle = '#ffeee4';
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.fillText('RETRY — SAME BOARD', W / 2, az.y + az.h / 2 + 6);
  } else {
    ctx.fillStyle = COL.textDim;
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('tap = ✕ mark · tap ✕ = erase · double-tap = officer', W / 2, az.y + az.h / 2);
  }
}

function starPath(ctx, x, y, ro, ri, points) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = (i * Math.PI) / points - Math.PI / 2;
    const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function heartPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.9);
  ctx.bezierCurveTo(x - s * 1.4, y, x - s * 0.7, y - s, x, y - s * 0.35);
  ctx.bezierCurveTo(x + s * 0.7, y - s, x + s * 1.4, y, x, y + s * 0.9);
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
