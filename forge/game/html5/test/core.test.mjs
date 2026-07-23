// core.test.mjs — #141 step-2 unit tests (spec §8.2, AMENDMENT 2 grammar).
// Covers: auto-eliminate set correctness, toggle-mark grammar (single tap
// EMPTY⇄MARK free both ways, double-tap commits, OFFICER terminal), heart
// accounting, win/fail transitions, thief/region detection, retry.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createBoard, EMPTY, MARK, OFFICER, AUTO_X } from '../src/core/board.js';
import { isLegal, eliminationGroups, completedRegions } from '../src/core/rules.js';
import { createSession, onTap, retry } from '../src/core/session.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(HERE, '../src/data/levels.p1.json'), 'utf8'));
const tuning = JSON.parse(readFileSync(join(HERE, '../src/data/tuning.json'), 'utf8'));

const L4 = createBoard(pack.levels[0]); // 4x4
const L5 = createBoard(pack.levels[1]); // 5x5
const L6 = createBoard(pack.levels[2]); // 6x6

test('pack shape: 3 levels, teaching order 4→5→6, tiers L0/L1, min-region-1 (spec §7.1 + AMENDMENT 2 §2.4)', () => {
  assert.equal(pack.levels.length, 3);
  assert.deepEqual(pack.levels.map(l => l.id), ['4x4#3', '5x5#6', '6x6#16']);
  assert.deepEqual(pack.levels.map(l => l.n), [4, 5, 6]);
  for (const l of pack.levels) {
    assert.ok(l.tier === 'L0' || l.tier === 'L1', `${l.id} tier ${l.tier}`);
    assert.ok(l.solution[l.thiefCell.r] !== l.thiefCell.c, 'thief not on officer');
    assert.equal(l.regions.length, l.n * l.n);
    const sizes = {};
    for (const reg of l.regions) sizes[reg] = (sizes[reg] || 0) + 1;
    assert.equal(Math.min(...Object.values(sizes)), 1, `${l.id} has a 1-cell region`);
  }
});

test('auto-eliminate set correctness: row ∪ col ∪ region ∪ 8-nbhd, grouped, EMPTY only (spec §4.3)', () => {
  const b = L4;
  const n = b.n;
  const s = createSession(b, tuning);
  const r = 0, c = b.solution[0];
  const ev = onTap(s, r, c, 'single', tuning); // EMPTY → MARK
  assert.equal(ev.type, 'mark');
  const place = onTap(s, r, c, 'double', tuning); // double-tap → OFFICER (correct)
  assert.equal(place.type, 'place');

  const cas = place.cascade;
  const all = [...cas.row, ...cas.column, ...cas.diagonals, ...cas.region];
  // no dupes across groups
  assert.equal(new Set(all).size, all.length);
  // placed cell itself never appears
  assert.ok(!all.includes(r * n + c));
  // every cascaded cell is AUTO_X now; every AUTO_X is in the cascade
  for (const i of all) assert.equal(s.cellState[i], AUTO_X);
  for (let i = 0; i < n * n; i++) {
    if (s.cellState[i] === AUTO_X) assert.ok(all.includes(i), `AUTO_X cell ${i} traced to cascade`);
  }
  // row group = exactly the other cells of row r
  assert.equal(cas.row.length, n - 1);
  for (const i of cas.row) assert.equal(Math.floor(i / n), r);
  // column cells all share column c
  for (const i of cas.column) assert.equal(i % n, c);
  // diagonal cells are all king-adjacent
  for (const i of cas.diagonals) {
    const dr = Math.abs(Math.floor(i / n) - r), dc = Math.abs((i % n) - c);
    assert.equal(Math.max(dr, dc), 1);
  }
  // region cells all share the placed cell's region
  for (const i of cas.region) assert.equal(b.regions[i], b.regions[r * n + c]);
});

test('isLegal agrees with rules: same row/col/region/adjacent officers are illegal', () => {
  const b = L4;
  const n = b.n;
  const s = createSession(b, tuning);
  const r = 0, c = b.solution[0];
  onTap(s, r, c, 'double', tuning); // place correct officer directly from EMPTY
  // every cell sharing row/col/region/8-nbhd is now AUTO_X or the officer — and isLegal must refuse them
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const st = s.cellState[i * n + j];
      if (st === AUTO_X) assert.equal(isLegal(b, s.cellState, i, j), false, `(${i},${j}) AUTO_X must be illegal`);
    }
  }
  assert.equal(isLegal(b, s.cellState, r, c), false, 'occupied cell illegal');
});

test('AMENDMENT 2 grammar: single toggles EMPTY⇄MARK free both ways; double commits; OFFICER terminal', () => {
  const b = L4;
  const s = createSession(b, tuning);
  const r = 0, c = b.solution[0];
  const idx = r * b.n + c;
  assert.equal(s.cellState[idx], EMPTY);
  // single: EMPTY → MARK (free)
  assert.equal(onTap(s, r, c, 'single', tuning).type, 'mark');
  assert.equal(s.cellState[idx], MARK);
  assert.equal(s.hearts, 3);
  // single: MARK → EMPTY (the erase transition the retired cycle deleted —
  // a revised ✕ must NEVER cost a heart)
  assert.equal(onTap(s, r, c, 'single', tuning).type, 'erase');
  assert.equal(s.cellState[idx], EMPTY);
  assert.equal(s.hearts, 3);
  // double from EMPTY commits directly
  assert.equal(onTap(s, r, c, 'double', tuning).type, 'place');
  assert.equal(s.cellState[idx], OFFICER);
  // OFFICER is terminal: any further gesture acks and changes nothing
  assert.equal(onTap(s, r, c, 'single', tuning).type, 'terminal');
  assert.equal(onTap(s, r, c, 'double', tuning).type, 'terminal');
  assert.equal(s.cellState[idx], OFFICER);
  assert.equal(s.placedCount, 1);
});

test('double from MARK commits; wrong attempt returns cell to its PRE-TAP state', () => {
  const b = L4;
  const s = createSession(b, tuning);
  const r = 0, c = b.solution[0];
  onTap(s, r, c, 'single', tuning); // MARK
  assert.equal(onTap(s, r, c, 'double', tuning).type, 'place', 'double from MARK commits');
});

test('wrong double preserves pre-tap MARK (AMENDMENT 2: pre-tap state restored)', () => {
  const b = L4;
  const s = createSession(b, tuning);
  const wr = 1, wc = (b.solution[1] + 1) % b.n;
  onTap(s, wr, wc, 'single', tuning);
  assert.equal(s.cellState[wr * b.n + wc], MARK);
  const wrong = onTap(s, wr, wc, 'double', tuning);
  assert.equal(wrong.type, 'wrong');
  assert.equal(s.cellState[wr * b.n + wc], MARK, 'wrong attempt preserves pre-tap MARK');
  assert.equal(s.hearts, 2);
});

test('heart accounting: MARK free, erase free, blocked free, wrong costs exactly 1 (spec §4.5)', () => {
  const b = L4;
  const s = createSession(b, tuning);
  // MARK + erase are free in both directions
  const mr = 1, mc = (b.solution[1] + 1) % b.n;
  onTap(s, mr, mc, 'single', tuning);
  onTap(s, mr, mc, 'single', tuning); // erase
  onTap(s, mr, mc, 'single', tuning); // re-mark
  assert.equal(s.hearts, 3);
  // place a correct officer, then tap an AUTO_X cell — blocked, free, both gestures
  const r = 0, c = b.solution[0];
  onTap(s, r, c, 'double', tuning);
  const autoIdx = s.cellState.findIndex(v => v === AUTO_X);
  assert.ok(autoIdx >= 0);
  assert.equal(onTap(s, Math.floor(autoIdx / b.n), autoIdx % b.n, 'single', tuning).type, 'blocked');
  assert.equal(onTap(s, Math.floor(autoIdx / b.n), autoIdx % b.n, 'double', tuning).type, 'blocked');
  assert.equal(s.hearts, 3, 'blocked taps never cost a heart');
  // single tap NEVER loses a heart, even off-solution — only a committed double does
  const offR = 2, offC = (b.solution[2] + 1) % b.n;
  if (s.cellState[offR * b.n + offC] === EMPTY) {
    onTap(s, offR, offC, 'single', tuning);
    assert.equal(s.hearts, 3, 'single tap on off-solution cell is free');
  }
  // wrong double costs exactly one
  const wrong = onTap(s, mr, mc, 'double', tuning);
  assert.equal(wrong.type, 'wrong');
  assert.equal(s.hearts, 2);
  assert.equal(s.status, 'playing');
});

test('fail: 3 wrongs → failed; taps ignored after; retry restores (spec §4.5)', () => {
  const b = L4;
  const s = createSession(b, tuning);
  for (let k = 0; k < 3; k++) {
    const r = k, c = (b.solution[k] + 1) % b.n;
    const ev = onTap(s, r, c, 'double', tuning); // wrong OFFICER attempt
    assert.equal(ev.type, 'wrong');
    assert.equal(s.hearts, 2 - k);
  }
  assert.equal(s.status, 'failed');
  assert.equal(onTap(s, 0, b.solution[0], 'double', tuning).type, 'ignored', 'taps ignored when failed');
  retry(s, tuning);
  assert.equal(s.status, 'playing');
  assert.equal(s.hearts, 3);
  assert.equal(s.placedCount, 0);
  assert.equal(countState(s, EMPTY), b.n * b.n);
});

test('win: full correct solve → won; thief cell is a real non-officer cell', () => {
  for (const b of [L4, L5, L6]) {
    const s = createSession(b, tuning);
    for (let r = 0; r < b.n; r++) {
      const c = b.solution[r];
      const p = onTap(s, r, c, 'double', tuning);
      assert.equal(p.type, 'place');
    }
    assert.equal(s.status, 'won', `${b.id} solved`);
    assert.equal(s.placedCount, b.n);
    const ti = b.thiefCell.r * b.n + b.thiefCell.c;
    assert.notEqual(s.cellState[ti], OFFICER, 'thief cell is not an officer');
    // after solve every non-officer cell is eliminated
    for (let i = 0; i < b.n * b.n; i++) {
      if (s.cellState[i] !== OFFICER) assert.equal(s.cellState[i], AUTO_X, `${b.id} cell ${i} resolved`);
    }
  }
});

test('region completion announced exactly once per region (spec §4.6/PULSE row 5)', () => {
  const b = L4;
  const s = createSession(b, tuning);
  const announced = new Set();
  for (let r = 0; r < b.n; r++) {
    const c = b.solution[r];
    const p = onTap(s, r, c, 'double', tuning);
    for (const g of p.regionsCompleted) {
      assert.ok(!announced.has(g), `region ${g} announced twice`);
      announced.add(g);
    }
  }
  assert.equal(s.status, 'won');
  assert.equal(announced.size, b.n, 'all regions completed by full solve');
});

function countState(s, v) {
  let k = 0;
  for (let i = 0; i < s.cellState.length; i++) if (s.cellState[i] === v) k++;
  return k;
}
