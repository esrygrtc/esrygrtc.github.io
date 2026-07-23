// core.test.mjs — #141 step-2 unit tests (spec §8.2).
// Covers: auto-eliminate set correctness, 3-state cycle, heart accounting,
// win/fail transitions, thief/region detection, retry. Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createBoard, EMPTY, MARK, OFFICER, AUTO_X } from '../src/core/board.js';
import { isLegal, eliminationGroups, recomputeElimination, completedRegions } from '../src/core/rules.js';
import { createSession, onTap, retry } from '../src/core/session.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(readFileSync(join(HERE, '../src/data/levels.p1.json'), 'utf8'));
const tuning = JSON.parse(readFileSync(join(HERE, '../src/data/tuning.json'), 'utf8'));

const L4 = createBoard(pack.levels[0]); // 4x4
const L5 = createBoard(pack.levels[1]); // 5x5
const L6 = createBoard(pack.levels[2]); // 6x6

test('pack shape: 3 levels, teaching order 4→5→6, tiers L0/L1 (spec §7.1)', () => {
  assert.equal(pack.levels.length, 3);
  assert.deepEqual(pack.levels.map(l => l.n), [4, 5, 6]);
  for (const l of pack.levels) {
    assert.ok(l.tier === 'L0' || l.tier === 'L1', `${l.id} tier ${l.tier}`);
    assert.ok(l.solution[l.thiefCell.r] !== l.thiefCell.c, 'thief not on officer');
    assert.equal(l.regions.length, l.n * l.n);
  }
});

test('auto-eliminate set correctness: row ∪ col ∪ region ∪ 8-nbhd, grouped, EMPTY only (spec §4.3)', () => {
  const b = L4;
  const n = b.n;
  const s = createSession(b, tuning);
  const r = 0, c = b.solution[0];
  const ev = onTap(s, r, c, tuning); // EMPTY → MARK
  assert.equal(ev.type, 'mark');
  const place = onTap(s, r, c, tuning); // MARK → OFFICER (correct)
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
  onTap(s, r, c, tuning); onTap(s, r, c, tuning); // place correct officer
  // every cell sharing row/col/region/8-nbhd is now AUTO_X or the officer — and isLegal must refuse them
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const st = s.cellState[i * n + j];
      if (st === AUTO_X) assert.equal(isLegal(b, s.cellState, i, j), false, `(${i},${j}) AUTO_X must be illegal`);
    }
  }
  assert.equal(isLegal(b, s.cellState, r, c), false, 'occupied cell illegal');
});

test('3-state cycle: EMPTY → MARK → OFFICER → EMPTY, unplace frees AUTO_X (spec §4.1)', () => {
  const b = L4;
  const s = createSession(b, tuning);
  const r = 0, c = b.solution[0];
  const idx = r * b.n + c;
  assert.equal(s.cellState[idx], EMPTY);
  assert.equal(onTap(s, r, c, tuning).type, 'mark');
  assert.equal(s.cellState[idx], MARK);
  assert.equal(onTap(s, r, c, tuning).type, 'place');
  assert.equal(s.cellState[idx], OFFICER);
  const autoBefore = countState(s, AUTO_X);
  assert.ok(autoBefore > 0, 'placement eliminated cells');
  const un = onTap(s, r, c, tuning);
  assert.equal(un.type, 'unplace');
  assert.equal(s.cellState[idx], EMPTY);
  assert.equal(countState(s, AUTO_X), 0, 'removing the only officer frees all AUTO_X');
  assert.equal(s.placedCount, 0);
});

test('heart accounting: MARK free, blocked free, wrong costs exactly 1 (spec §4.5)', () => {
  const b = L4;
  const s = createSession(b, tuning);
  // MARK is free
  onTap(s, 1, (b.solution[1] + 1) % b.n, tuning);
  assert.equal(s.hearts, 3);
  // place a correct officer, then tap an AUTO_X cell — blocked, free
  const r = 0, c = b.solution[0];
  onTap(s, r, c, tuning); onTap(s, r, c, tuning);
  const autoIdx = s.cellState.findIndex(v => v === AUTO_X);
  assert.ok(autoIdx >= 0);
  const blocked = onTap(s, Math.floor(autoIdx / b.n), autoIdx % b.n, tuning);
  assert.equal(blocked.type, 'blocked');
  assert.equal(s.hearts, 3, 'blocked tap never costs a heart');
  // wrong placement costs exactly one
  const wr = 1, wc = (b.solution[1] + 1) % b.n;
  assert.equal(s.cellState[wr * b.n + wc], MARK, 'cell was MARKed earlier');
  const wrong = onTap(s, wr, wc, tuning);
  assert.equal(wrong.type, 'wrong');
  assert.equal(s.hearts, 2);
  assert.equal(s.cellState[wr * b.n + wc], MARK, 'wrong cell returns to MARK');
  assert.equal(s.status, 'playing');
});

test('fail: 3 wrongs → failed; taps ignored after; retry restores (spec §4.5)', () => {
  const b = L4;
  const s = createSession(b, tuning);
  for (let k = 0; k < 3; k++) {
    const r = k, c = (b.solution[k] + 1) % b.n;
    onTap(s, r, c, tuning); // MARK
    const ev = onTap(s, r, c, tuning); // wrong OFFICER attempt
    assert.equal(ev.type, 'wrong');
    assert.equal(s.hearts, 2 - k);
  }
  assert.equal(s.status, 'failed');
  assert.equal(onTap(s, 0, b.solution[0], tuning).type, 'ignored', 'taps ignored when failed');
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
      const m = onTap(s, r, c, tuning);
      assert.equal(m.type, 'mark');
      const p = onTap(s, r, c, tuning);
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
    onTap(s, r, c, tuning);
    const p = onTap(s, r, c, tuning);
    for (const g of p.regionsCompleted) {
      assert.ok(!announced.has(g), `region ${g} announced twice`);
      announced.add(g);
    }
  }
  assert.equal(s.status, 'won');
  assert.equal(announced.size, b.n, 'all regions completed by full solve');
});

test('recomputeElimination is idempotent and never touches MARK', () => {
  const b = L4;
  const s = createSession(b, tuning);
  const r = 0, c = b.solution[0];
  onTap(s, r, c, tuning); onTap(s, r, c, tuning); // place
  // manual MARK on a still-empty cell (find one that survived — none at 4x4 after one place; use 5x5)
  const b5 = L5;
  const s5 = createSession(b5, tuning);
  const r5 = 0, c5 = b5.solution[0];
  onTap(s5, r5, c5, tuning); onTap(s5, r5, c5, tuning); // place on 5x5
  let markIdx = -1;
  for (let i = 0; i < b5.n * b5.n; i++) if (s5.cellState[i] === EMPTY) { markIdx = i; break; }
  if (markIdx >= 0) {
    onTap(s5, Math.floor(markIdx / b5.n), markIdx % b5.n, tuning); // manual MARK
    recomputeElimination(b5, s5.cellState);
    assert.equal(s5.cellState[markIdx], MARK, 'recompute never overrides manual MARK');
  }
  const snapshot = Array.from(s5.cellState);
  recomputeElimination(b5, s5.cellState);
  assert.deepEqual(Array.from(s5.cellState), snapshot, 'idempotent');
});

function countState(s, v) {
  let k = 0;
  for (let i = 0; i < s.cellState.length; i++) if (s.cellState[i] === v) k++;
  return k;
}
