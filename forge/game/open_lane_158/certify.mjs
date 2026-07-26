#!/usr/bin/env node
// OPEN LANE #158 — level certifier. Scores each level against the claim it makes
// in its own `teaches` field, using the shipped model. P1 P2 P3 P4 · SKILL§3 §7.
//
// A `teaches` string is a promise to the player. This gate checks the board can
// actually keep it. It does NOT check that the level is fun — that is the owner's
// eye (P10). It checks only measurable structure:
//
//   C0 claim-present       `teaches` exists and is non-empty
//   C1 solvable            the board can be cleared at all
//   C2 par-exact           par equals the true optimal move count
//   C3 verb-exercised      the optimal line requires at least one real drag,
//                          not just taps on blocks already sitting on their gate
//   C4 echo-load-bearing   if the level claims echo, stripping echo must break it
//   C5 doom-claimed        if `teaches` claims a wrong move can doom the board,
//                          some legal first move must reach an unsolvable state
//   C6 doom-disclosed      if `teaches` does NOT claim doom, NO legal first move
//                          may doom the board — a silent trap is not a lesson
//   C7 copies-agree        levels/*.json equals EVERY inlined set shipped in *.html
//   C8 R10'-reachable      LADDER scope: the build ships the dead-end chip AND some
//                          level on the ladder can actually reach a dead end
//
// C5 and C6 are a PARTITION, and that is the point. The previous revision ran the
// doom check only when `teaches` matched /doom|wrong|order matters|trap/, so an
// author could retire the check by rewording a documentation string — and did:
// L3 went from "the wrong first exit dooms the board" to a sentence about echo,
// which silently switched C5 off while the trap stayed on the board. Now every
// level runs exactly one of the two, so rewording `teaches` SWAPS which check
// applies and can never remove both. C0 stops the same dodge by deletion.
//
// C8 closes the half of that dodge the partition does NOT close. C5/C6 make the
// prose select which way the measurement must come out, so an author can still
// satisfy C6 by DELETING the trap — reword, then flatten the board, and both
// checks go green while the ladder quietly stops teaching the one thing this
// prototype exists to ask ("is choosing which gate to fire first fun?"). That is
// not hypothetical: it is what the ladder at 3fe9343f did. Every level cleared
// with zero reachable dead ends, so `checkDeadEnd` (R10') shipped in the build as
// code no player could ever reach, and spec §C5 ORDER DECIDES was unmet with
// RESULT: PASS on screen.
//
// So C8 takes NO input the author controls: it does not read `teaches`, and it
// widens to the whole ladder inlined in the shipped build rather than the ids
// passed on argv — narrowing the arguments cannot narrow the obligation. It also
// requires the chip itself to be present, so deleting `checkDeadEnd` REDs the
// check that exists to keep it reachable instead of retiring it.
//
// NOTE ON NUMBERING: these C-codes are this gate's own and do NOT line up with the
// C1-C7 in docs/product/OPEN_LANE_158_SPEC.md (spec-C2 is BOUNDED, certify-C2 is
// par-exact; spec-C5 ORDER DECIDES is enforced here by C5+C8, not by certify-C5).
// Always say "spec-Cn" or "certify-Cn" — a bare "C5" has meant both on this issue.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { solve, solveFrom, movesFor } from "./solver.mjs";
import { isClear, loadLevel } from "./model.js";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dirFlag = args.indexOf("--levels");
const levelsDir = dirFlag >= 0 ? args[dirFlag + 1] : join(root, "levels");
if (dirFlag >= 0) args.splice(dirFlag, 2);
const ids = args.length ? args : ["L1", "L2", "L3"];
const readLevel = (id) => JSON.parse(readFileSync(join(levelsDir, `${id}.json`), "utf8"));

const claimsEcho = (level) =>
  /echo/i.test(level.teaches || "") || (level.gates || []).some((g) => g.echo);
const claimsDoom = (level) => /doom|wrong|order matters|trap|dead[- ]?end/i.test(level.teaches || "");

// Every board reachable in one legal move from the start.
function afterFirstMove(level) {
  const start = loadLevel(level);
  const out = [];
  for (const block of start.blocks) {
    for (const move of movesFor(start, block.id)) {
      out.push({ label: move.tap ? `tap ${block.id}` : `${block.id}->[${move.at}]`, state: move.state });
    }
  }
  return out;
}

function inlinedLevels(htmlPath) {
  let html;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch {
    return null;
  }
  const i = html.indexOf("const INLINE_LEVELS");
  if (i < 0) return null;
  const start = html.indexOf("{", i);
  if (start < 0 || html.slice(i, start).includes("null")) return null;
  let depth = 0;
  let j = start;
  for (; j < html.length; j += 1) {
    if (html[j] === "{") depth += 1;
    else if (html[j] === "}") {
      depth -= 1;
      if (depth === 0) { j += 1; break; }
    }
  }
  return JSON.parse(html.slice(start, j));
}

// C7 used to read the single file named "playable.html". index.html also inlines a
// level set, so a drift between levels/*.json and index.html was invisible to the
// gate that exists to catch exactly that drift. Enumerate instead of naming: every
// *.html beside this script is a candidate, and the ones carrying a real blob are
// the shipped copies. A file whose INLINE_LEVELS is null is a source build, not a
// copy to check — but if NO file ships a set, that is RED, not a free pass.
function shippedCopies() {
  const out = [];
  for (const name of readdirSync(root).filter((n) => n.endsWith(".html")).sort()) {
    const levels = inlinedLevels(join(root, name));
    // `chip` is read off the same bytes that ship the levels, so C8 can never be
    // satisfied by a dead-end detector that lives in some other file the player
    // never loads.
    if (levels) out.push({ name, levels, chip: /checkDeadEnd\s*\(/.test(readFileSync(join(root, name), "utf8")) });
  }
  return out;
}

// Only geometry decides play. `teaches` is documentation and is compared separately.
const GEOMETRY_KEYS = ["grid", "walls", "blocks", "gates", "par"];
const geometry = (level) =>
  JSON.stringify(Object.fromEntries(GEOMETRY_KEYS.map((k) => [k, level[k] ?? null])));

// Name the fields that actually differ. "(par 4 vs 4)" told the reader nothing when
// the drift was in `blocks`, which is the drift that changes the game.
const geometryDelta = (a, b) =>
  GEOMETRY_KEYS.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));

// Every legal first move, scored for "does this state still have a win in it".
// Shared by the per-level C5/C6 partition and by the ladder-scope C8 so the two
// can never disagree about what "doomed" means.
function doomProfile(level) {
  const probes = afterFirstMove(level)
    .filter((n) => !isClear(n.state))
    .map((n) => ({ ...n, verdict: solveFrom(n.state).solvable }));
  return {
    probes,
    doomed: probes.filter((p) => p.verdict === false),
    inconclusive: probes.filter((p) => p.verdict === "unknown"),
  };
}

const rows = [];
const doomByLevel = new Map();
let green = true;
const fail = (id, code, detail) => { rows.push(`  ${id} ${code} RED  — ${detail}`); green = false; };
const pass = (id, code, detail) => rows.push(`  ${id} ${code} green — ${detail}`);

const copies = shippedCopies();

for (const id of ids) {
  const level = readLevel(id);
  const result = solve(level);

  // The certifier scores a level against the claim it makes. No claim, nothing to
  // score — and every claim-conditional check below would silently self-disable.
  if (typeof level.teaches !== "string" || !level.teaches.trim()) {
    fail(id, "C0", "`teaches` is unset — the level makes no claim, so C4/C5/C6 have nothing to certify against");
  } else pass(id, "C0", `claims "${level.teaches}"`);

  if (result.solvable !== true) { fail(id, "C1", `board is ${result.solvable} (${result.states} states)`); continue; }
  pass(id, "C1", `solvable in ${result.moves}`);

  if (result.moves !== level.par) fail(id, "C2", `par=${level.par} but optimal=${result.moves}`);
  else pass(id, "C2", `par=${level.par} is exact`);

  const drags = result.path.filter((s) => !s.startsWith("tap")).length;
  if (drags === 0) {
    fail(id, "C3", `optimal line is ${result.moves} taps, 0 drags — every block starts on its own gate path, so the level never asks the player to move anything. teaches="${level.teaches || "(unset)"}"`);
  } else pass(id, "C3", `${drags} drag(s) required in the optimal line`);

  if (claimsEcho(level)) {
    const stripped = JSON.parse(JSON.stringify(level));
    for (const gate of stripped.gates) gate.echo = null;
    const without = solve(stripped);
    if (without.solvable === true && without.moves <= result.moves) {
      fail(id, "C4", `echo is decorative — board still clears in ${without.moves} with every echo stripped`);
    } else pass(id, "C4", `echo is load-bearing (stripped: ${without.solvable}/${without.moves})`);
  }

  // Doom is measured on EVERY level, unconditionally. `teaches` then decides which
  // way the measurement has to come out — it never decides whether to measure.
  const { probes, doomed, inconclusive } = doomProfile(level);
  doomByLevel.set(id, { doomed: doomed.length, inconclusive: inconclusive.length, example: doomed[0]?.label ?? null });

  if (inconclusive.length) {
    // A probe that ran out of states proves nothing in either direction. Reporting
    // green off an undecided search is how a gate becomes a rubber stamp.
    fail(id, claimsDoom(level) ? "C5" : "C6", `${inconclusive.length}/${probes.length} first-move probes hit the state cap — raise it, the result is undecided`);
  } else if (claimsDoom(level)) {
    if (doomed.length === 0) {
      fail(id, "C5", `claims a wrong move dooms the board, but all ${probes.length} legal first moves leave it solvable — teaches="${level.teaches}"`);
    } else pass(id, "C5", `${doomed.length}/${probes.length} first moves doom the board, e.g. ${doomed[0].label}`);
  } else if (doomed.length) {
    fail(id, "C6", `${doomed.length}/${probes.length} first moves doom the board (e.g. ${doomed[0].label}) but teaches="${level.teaches}" never warns of it — either claim the trap or remove it`);
  } else pass(id, "C6", `no first move dooms the board across ${probes.length} probes, matching a claim that promises no trap`);

  if (!copies.length) {
    fail(id, "C7", "no *.html beside this script inlines a level set — nothing shipped to compare against");
  } else {
    const bad = [];
    for (const copy of copies) {
      const shipped = copy.levels[id];
      if (!shipped) bad.push(`${copy.name}: level absent`);
      else if (geometry(shipped) !== geometry(level)) {
        bad.push(`${copy.name}: differs in ${geometryDelta(shipped, level).join(", ")} (par ${shipped.par} vs ${level.par})`);
      }
    }
    if (bad.length) fail(id, "C7", `${bad.join("; ")} — the build was not regenerated after the level edit`);
    else pass(id, "C7", `levels/*.json agrees with ${copies.map((c) => c.name).join(", ")}`);
  }
}

// ------------------------------------------------------------ C8, ladder scope
// Runs once, over the whole ladder, on inputs the level author does not control.
// The ladder is the union of what was certified and what the build actually ships,
// so `certify.mjs L1` cannot shrink the obligation to a level that was never meant
// to carry the trap.
const ladderIds = [...new Set([...ids, ...copies.flatMap((c) => Object.keys(c.levels))])].sort();
const chipCopies = copies.filter((c) => c.chip);

let ladderDoomed = 0;
let ladderExample = null;
const unmeasured = [];
for (const id of ladderIds) {
  let profile = doomByLevel.get(id);
  if (!profile) {
    // Certified elsewhere or not at all — measure it here rather than assume.
    try {
      const { doomed, inconclusive } = doomProfile(readLevel(id));
      profile = { doomed: doomed.length, inconclusive: inconclusive.length, example: doomed[0]?.label ?? null };
    } catch (err) {
      unmeasured.push(`${id} (${err.code === "ENOENT" ? "no levels/" + id + ".json" : err.message})`);
      continue;
    }
  }
  if (profile.inconclusive) unmeasured.push(`${id} (${profile.inconclusive} probe(s) hit the state cap)`);
  ladderDoomed += profile.doomed;
  if (!ladderExample && profile.example) ladderExample = `${id}: ${profile.example}`;
}

if (copies.length === 0) {
  fail("LADDER", "C8", `no shipped copy inlines a level set, so there is no build whose dead-end reachability can be decided (C7 above says the same thing about the levels)`);
} else if (chipCopies.length === 0) {
  fail("LADDER", "C8", `no shipped copy defines checkDeadEnd() — R10' is not on the build, so a doomed board can never tell the player it is doomed (see r10_shell_check.mjs)`);
} else if (unmeasured.length) {
  fail("LADDER", "C8", `cannot decide: ${unmeasured.join("; ")} — an undecided sweep is not a green ladder`);
} else if (ladderDoomed === 0) {
  fail(
    "LADDER",
    "C8",
    `${chipCopies.map((c) => c.name).join(", ")} ships checkDeadEnd() but NO level on the ladder (${ladderIds.join(", ")}) has a single dooming first move — the chip is unreachable code and spec §C5 ORDER DECIDES is unmet. Order cannot be the strategy on a ladder where no order is ever wrong. Put the trap back on the level that claims it.`,
  );
} else {
  pass("LADDER", "C8", `${ladderDoomed} dooming first move(s) across ${ladderIds.join(", ")} (e.g. ${ladderExample}) — ${chipCopies.map((c) => c.name).join(", ")} ships checkDeadEnd() to catch them`);
}

console.log(rows.join("\n"));
if (ids.length === 0) { console.log("RESULT: FAIL — no levels checked"); process.exit(1); }
console.log(`checked ${ids.length} level(s): ${ids.join(", ")} from ${levelsDir}`);
console.log(`shipped copies compared: ${copies.length ? copies.map((c) => c.name).join(", ") : "NONE"}`);
console.log(green ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(green ? 0 : 1);
