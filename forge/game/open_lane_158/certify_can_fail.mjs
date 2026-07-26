#!/usr/bin/env node
// OPEN LANE #158 — can-fail proof for certify.mjs. P1 P4 · SKILL§3.
//
// A gate nobody has driven RED is a rubber stamp, and every green it ever printed
// is worth nothing. This spawns the REAL certifier CLI as a subprocess against
// synthesised level sets and asserts each check reports RED on demand.
//
// Two rules this file obeys, both learned the hard way:
//   - Mutate a synthesised-CORRECT fixture, never the live defect. A proof built by
//     replace(<today's bug>, <fix>) dies the day the bug is fixed, taking the
//     evidence with it.
//   - Spawn the CLI, assert on stdout AND exit code. An import-only driver never
//     notices the CLI stopped executing; a silent no-op exits 0 and reads as PASS.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const TMP = join(root, ".certify_canfail");

// ---------------------------------------------------------------- the fixture
// A 5x5 board built to satisfy every check, from scratch — not a copy of L1/L2/L3.
// If the shipped levels change, this fixture does not, so the proof keeps its
// meaning. b1 sits OFF its gate column (so C3 sees a real drag), b2 sits on its
// own gate path (so par stays small), and nothing can be doomed in one move.
const BASE = {
  id: "CF",
  grid: { w: 5, h: 5 },
  walls: [],
  blocks: [
    { id: "b1", color: "amber", symbol: "circle", cells: [[0, 0]], at: [0, 2] },
    { id: "b2", color: "teal", symbol: "triangle", cells: [[0, 0]], at: [3, 4] },
  ],
  gates: [
    { id: "g1", side: "N", span: [1, 1], color: "amber", echo: null },
    { id: "g2", side: "S", span: [3, 1], color: "teal", echo: null },
  ],
  par: 2,
  teaches: "colour matching + slide-and-release",
};

// A second board that CAN be doomed, so the fixture ladder satisfies the
// ladder-scope C8 while the cases below mutate BASE. Row y=1 is walled shut;
// violet's RETRACT is the only way to open teal's route down column 2, and
// amber's EXTEND seals it for good — tap amber first and teal is stranded.
// It never appears on argv, so its own C0-C7 are never scored; C8 reads it off
// the shipped build, which is exactly the widening C8 exists to do.
const TRAP = {
  id: "CFT",
  grid: { w: 4, h: 4 },
  walls: [[0, 1], [1, 1], [2, 1], [3, 1]],
  blocks: [
    { id: "b1", color: "amber", symbol: "circle", cells: [[0, 0]], at: [0, 0] },
    { id: "b2", color: "violet", symbol: "square", cells: [[0, 0]], at: [3, 0] },
    { id: "b3", color: "teal", symbol: "triangle", cells: [[0, 0]], at: [2, 0] },
  ],
  gates: [
    { id: "gA", side: "N", span: [0, 1], color: "amber", echo: { type: "EXTEND", cells: [[2, 2]] } },
    { id: "gV", side: "N", span: [3, 1], color: "violet", echo: { type: "RETRACT", cells: [[2, 1]] } },
    { id: "gT", side: "S", span: [2, 1], color: "teal", echo: null },
  ],
  par: 3,
  teaches: "order matters — the wrong first exit dooms the board",
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// `trap` and `chip` are the two inputs C8 reads. Everything else about a case is
// a per-level concern, so they live here rather than in each fixture.
function run(levels, htmlLevels, { trap = true, chip = true } = {}) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "levels"), { recursive: true });
  const onDisk = trap ? [...levels, clone(TRAP)] : levels;
  for (const level of onDisk) {
    writeFileSync(join(TMP, "levels", `${level.id}.json`), JSON.stringify(level, null, 2));
  }
  // The certifier finds shipped copies by scanning *.html beside ITSELF, so the
  // fixture needs its own certifier next to its own build. Copy the real modules;
  // never reimplement them here, or this proves a gate that is not the shipped one.
  for (const f of ["certify.mjs", "solver.mjs", "model.js"]) copyFileSync(join(root, f), join(TMP, f));
  const inlined = htmlLevels === null ? null : (trap ? [...htmlLevels, clone(TRAP)] : htmlLevels);
  const inline = inlined === null
    ? "null"
    : JSON.stringify(Object.fromEntries(inlined.map((l) => [l.id, l])));
  // The chip is a real call site, not a mention in a comment: C8 must be reading
  // the shipped shell, and a stub that only names the function proves that.
  const shell = chip ? `function checkDeadEnd(){ /* R10' */ }\ncheckDeadEnd();\n` : "";
  writeFileSync(join(TMP, "playable.html"), `<script>\nconst INLINE_LEVELS = ${inline};\n${shell}</script>\n`);

  // argv stays the CASE's levels only. C8 must widen to the shipped set by itself.
  const r = spawnSync(process.execPath, [join(TMP, "certify.mjs"), ...levels.map((l) => l.id)], {
    cwd: TMP, encoding: "utf8",
  });
  return { out: `${r.stdout}${r.stderr}`, code: r.status };
}

const cases = [];
const add = (code, what, build) => cases.push({ code, what, build });

// -------- positive control. If this is not green, every RED below is meaningless:
// the fixture would be failing for reasons of its own and proving nothing.
add("S+", "the synthesised fixture certifies green and the CLI exits 0", () => {
  const l = clone(BASE);
  return { levels: [l], html: [l], expect: (r) => r.code === 0 && /RESULT: PASS/.test(r.out) };
});

// -------- C0: delete the claim. The old certifier answered this with silence —
// C4/C5 simply stopped running and the level passed. That is the hole VERITY found.
add("C0", "`teaches` deleted => C0 RED (not a silent skip)", () => {
  const l = clone(BASE);
  delete l.teaches;
  return { levels: [l], html: [l], expect: (r) => r.code === 1 && /C0 RED/.test(r.out) };
});

// -------- C2: par off by one.
add("C2", "par overstated by 1 => C2 RED", () => {
  const l = clone(BASE);
  l.par += 1;
  return { levels: [l], html: [l], expect: (r) => r.code === 1 && /C2 RED/.test(r.out) };
});

// -------- C3: park every block on its own gate path so the board clears by tapping.
// This is the regression VERITY measured on the shipped ladder, reproduced from a
// correct fixture rather than borrowed from the broken levels.
add("C3", "every block parked on its gate => C3 RED (tap-only, core verb dead)", () => {
  const l = clone(BASE);
  l.blocks[0].at = [1, 0];
  l.par = 2;
  return { levels: [l], html: [l], expect: (r) => r.code === 1 && /C3 RED/.test(r.out) };
});

// -------- C4: an echo that retracts a wall nobody was blocked by. The gate must
// notice the echo is decoration, not mechanism.
add("C4", "echo that changes nothing => C4 RED (decorative)", () => {
  const l = clone(BASE);
  l.walls = [[4, 0]];
  l.gates[0].echo = { type: "RETRACT", cells: [[4, 0]] };
  l.teaches = "gate echo changes the board";
  return { levels: [l], html: [l], expect: (r) => r.code === 1 && /C4 RED/.test(r.out) };
});

// -------- C5: claim a trap on a board that has none. Under the old revision this
// check only existed when the prose happened to match; now the prose SELECTS it.
add("C5", "claims doom on an untrappable board => C5 RED", () => {
  const l = clone(BASE);
  l.teaches = "exit order matters — the wrong first exit dooms the board";
  return { levels: [l], html: [l], expect: (r) => r.code === 1 && /C5 RED/.test(r.out) };
});

// -------- C6: the mirror, and the check that closes the reword escape. Same board
// carrying a real trap, described by a sentence that never mentions it. Under the
// old revision this was a silent PASS — the level shipped a trap it never taught.
add("C6", "a real trap the claim never warns of => C6 RED", () => {
  // Doom needs an EXTEND echo — exits only ever remove blocks, and drags are
  // reversible, so nothing else in the model can strand a piece. That is exactly
  // the TRAP board, put on argv under a sentence that never mentions the trap.
  const l = { ...clone(TRAP), id: "CF", teaches: "colour matching + slide-and-release" };
  return { levels: [l], html: [l], expect: (r) => r.code === 1 && /C6 RED/.test(r.out) };
});

// -------- C7: the shipped build drifts from the source. This is the check that was
// reading ONE named file while TWO shipped a level set.
add("C7", "playable.html ships stale geometry => C7 RED naming the field", () => {
  const l = clone(BASE);
  const stale = clone(BASE);
  stale.blocks[0].at = [4, 4];
  return {
    levels: [l], html: [stale],
    expect: (r) => r.code === 1 && /C7 RED/.test(r.out) && /blocks/.test(r.out),
  };
});

// -------- C7 by deletion: blank the inlined set entirely. A gate that treats "no
// build to compare" as "nothing to disagree with" can be silenced by one edit.
add("C7n", "INLINE_LEVELS = null => C7 RED (absence is not agreement)", () => {
  const l = clone(BASE);
  return { levels: [l], html: null, expect: (r) => r.code === 1 && /C7 RED/.test(r.out) };
});

// -------- C8, the ladder-scope check, driven RED both ways it can be defeated.
//
// This is the regression the C5/C6 partition could not see. Every per-level check
// stays green here: BASE certifies clean and honestly promises no trap, so C6
// passes. It is only the LADDER that is broken — nothing anywhere can be doomed,
// so the dead-end chip shipped in the build is code no player can reach. That is
// the exact shape the real ladder had at 3fe9343f while printing RESULT: PASS.
add("C8", "flatten the ladder — no board anywhere can be doomed => C8 RED", () => {
  const l = clone(BASE);
  return {
    levels: [l], html: [l], opts: { trap: false },
    expect: (r) => r.code === 1 && /C8 RED/.test(r.out) && /unreachable code/.test(r.out) && !/C6 RED/.test(r.out),
  };
});

// The other half: keep the trap, delete the chip. A check that only fires when the
// feature is present can be retired by deleting the feature it protects.
add("C8x", "trap intact but the build ships no checkDeadEnd => C8 RED", () => {
  const l = clone(BASE);
  return {
    levels: [l], html: [l], opts: { chip: false },
    expect: (r) => r.code === 1 && /C8 RED/.test(r.out) && /checkDeadEnd/.test(r.out),
  };
});

let failures = 0;
console.log("OPEN LANE #158 — certify.mjs can-fail proof (spawned CLI, synthesised fixtures)\n");
for (const c of cases) {
  const { levels, html, expect, opts } = c.build();
  const r = run(levels, html, opts);
  const ok = expect(r);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.code}  ${c.what}   [exit=${r.code}]`);
  if (!ok) console.log(r.out.split("\n").map((s) => `        | ${s}`).join("\n"));
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ndrove ${cases.length} case(s): ${cases.map((c) => c.code).join(", ")}`);
console.log(failures === 0 ? "RESULT: PASS — every check can report RED" : `RESULT: FAIL — ${failures} case(s) did not behave as specified`);
process.exit(failures === 0 ? 0 : 1);
