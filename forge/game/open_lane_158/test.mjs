#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDrag,
  applyExit,
  canExit,
  isClear,
  legalStep,
  loadLevel,
  snapshot,
  undo,
} from "./model.js";

const schema = JSON.parse(readFileSync(new URL("./schema/level.schema.json", import.meta.url)));
assert.equal(schema.title, "OPEN LANE P1 level");

const base = {
  id: "L1",
  grid: { w: 4, h: 4 },
  walls: [[0, 2]],
  blocks: [
    { id: "a", color: "amber", symbol: "circle", cells: [[0, 0]], at: [1, 1] },
    { id: "t", color: "teal", symbol: "triangle", cells: [[0, 0]], at: [3, 2] }
  ],
  gates: [
    { id: "ga", side: "S", span: [1, 1], color: "amber", echo: { type: "RETRACT", cells: [[0, 2]] } },
    { id: "gt", side: "E", span: [2, 1], color: "teal", echo: null }
  ],
  par: 2
};

function validateLevel(level) {
  const errors = [];
  const colors = new Set(["amber", "teal", "violet", "lime"]);
  const symbols = { amber: "circle", teal: "triangle", violet: "square", lime: "cross" };
  const pointKey = ([x, y]) => `${x},${y}`;
  const inGrid = ([x, y]) => x >= 0 && y >= 0 && x < level.grid.w && y < level.grid.h;
  const wallSet = new Set(level.walls.map(pointKey));
  const occupied = new Set(wallSet);
  const gateColors = new Set(level.gates.map((gate) => gate.color));

  if (!/^L[1-3]$/.test(level.id)) errors.push("id");
  for (const block of level.blocks) {
    if (!colors.has(block.color) || symbols[block.color] !== block.symbol) errors.push(`symbol:${block.id}`);
    if (!gateColors.has(block.color)) errors.push(`gate-color:${block.id}`);
    for (const [dx, dy] of block.cells) {
      const point = [block.at[0] + dx, block.at[1] + dy];
      const key = pointKey(point);
      if (!inGrid(point)) errors.push(`block-bounds:${block.id}`);
      if (occupied.has(key)) errors.push(`block-overlap:${block.id}`);
      occupied.add(key);
    }
  }
  for (const gate of level.gates) {
    const edgeLength = gate.side === "N" || gate.side === "S" ? level.grid.w : level.grid.h;
    if (gate.span[0] < 0 || gate.span[1] < 1 || gate.span[0] + gate.span[1] > edgeLength) {
      errors.push(`gate-span:${gate.id}`);
    }
    for (const point of gate.echo?.cells || []) {
      if (!inGrid(point)) errors.push(`echo-bounds:${gate.id}`);
      if (gate.echo.type === "RETRACT" && !wallSet.has(pointKey(point))) errors.push(`retract:${gate.id}`);
      if (gate.echo.type === "EXTEND" && wallSet.has(pointKey(point))) errors.push(`extend:${gate.id}`);
    }
  }
  return errors;
}

assert.deepEqual(validateLevel(base), [], "schema constraints accept the valid fixture");
const invalid = structuredClone(base);
invalid.blocks[0].symbol = "cross";
invalid.gates[0].span = [4, 1];
invalid.gates[0].echo.cells = [[2, 2]];
assert.deepEqual(
  validateLevel(invalid).sort(),
  ["gate-span:ga", "retract:ga", "symbol:a"],
  "schema constraints fail independently"
);

let state = loadLevel(base);
assert.equal(legalStep(state, "a", -1, 0), true);
assert.equal(legalStep(state, "a", 0, 1), true);
assert.equal(legalStep(state, "a", -2, 0), false);

const beforeDrag = snapshot(state);
state = applyDrag(state, "a", [1, 3]);
assert.deepEqual(state.blocks.find((block) => block.id === "a").at, [1, 3]);
assert.equal(state.history.length, 1, "one drag is one undo entry");
assert.equal(canExit(state, "a"), "ga");

const exited = applyExit(state, "a", "ga");
state = exited.state;
assert.deepEqual(exited.echoDelta, [{ cell: [0, 2], before: "WALL", after: "EMPTY" }]);
assert.equal(state.blocks.some((block) => block.id === "a"), false);
assert.equal(state.walls.length, 0);
assert.equal(state.history.length, 1, "release exit coalesces with the drag undo entry");

state = undo(state);
assert.deepEqual(snapshot(state), beforeDrag, "undo restores drag, exit, and echo exactly");

state = applyDrag(state, "t", [3, 2]);
assert.equal(canExit(state, "t"), "gt");
state = applyExit(state, "t", "gt").state;
state = applyDrag(state, "a", [1, 3]);
state = applyExit(state, "a", "ga").state;
assert.equal(isClear(state), true);

const wrongColor = structuredClone(base);
wrongColor.gates[0].color = "violet";
assert.equal(canExit(loadLevel(wrongColor), "a"), null, "colour matching is enforced");

const levelFiles = ["L1.json"];
for (const name of levelFiles) {
  const level = JSON.parse(readFileSync(new URL(`./levels/${name}`, import.meta.url)));
  assert.deepEqual(validateLevel(level), [], `${name} passes enforced schema constraints`);
}
const l1 = JSON.parse(readFileSync(new URL("./levels/L1.json", import.meta.url)));
assert.equal(l1.gates.every((gate) => gate.echo === null), true, "L1 is echo-free");

// The inline builder writes playable.html as a side-effect of its real job
// (producing a self-contained HTML).  Running it in-place used to rewrite the
// shipped build during a read-only assertion — the test passed while silently
// mutating the artifact it was checking.  Build to a throwaway temp path and
// compare bytes against the shipped copy instead.
const playableUrl = new URL("./playable.html", import.meta.url);
assert.equal(existsSync(playableUrl), true, "generated playable exists");
const shipped = readFileSync(playableUrl);
const tmpDir = mkdtempSync(join(tmpdir(), "open-lane-test-"));
const tmpOut = join(tmpDir, "playable.html");
execFileSync(process.execPath, [fileURLToPath(new URL("./build_inline.mjs", import.meta.url)), "--out", tmpOut], { stdio: "pipe" });
const rebuilt = readFileSync(tmpOut);
assert.deepEqual(rebuilt, shipped, "inline builder reproduces playable byte-for-byte");
// Single-file preview ceiling. #160 intentionally inlines the sha-bound 480,698-byte
// music bed plus seven event sounds so the owner URL cannot point at an HTML/audio
// mixture from different commits. The 1.4 MB ceiling leaves <13% headroom over the
// measured 1,241,589-byte atomic build; cold start remains gated by the real
// boot_to_actionable timing probe, not inferred from file size.
assert.ok(rebuilt.length <= 1_500_000, "playable stays under 1.5 MB (#160 atomic audio + T14 art ceiling)");
const html = rebuilt.toString("utf8");
assert.equal(/(?:src|href)=["'](?!data:|#)/.test(html), false, "playable has no external references");
// Scan the CODE, not the payloads: base64 art/audio blobs contain runs like "/Ad/"
// that \bads?\b matches, so scanning the whole file made this P1 check fire on the
// art kit instead of on a recovery-pressure surface. Strip data URIs first.
const codeOnly = html.replace(/data:(?:image|audio)\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, "data:<stripped>");
assert.equal(/\b(timer|lives|ads?|purchase)\b/i.test(codeOnly), false, "P1 recovery-pressure surfaces are absent");
// #160 D-a: count of inlined art assets must match manifest directory
const manifestJson = JSON.parse(readFileSync(new URL("./art/manifest.json", import.meta.url), "utf8"));
const expectedArtCount = [...manifestJson.blocks, ...manifestJson.doors, ...manifestJson.settings, ...(manifestJson.shell||[]), ...manifestJson.legacy].length;
const actualArtCount = (html.match(/data:image\/webp;base64,/g) || []).length;
assert.equal(actualArtCount, expectedArtCount, `D-a: ${expectedArtCount} art assets from manifest are embedded`);
assert.ok(html.includes('source:"CANVAS R2 signal-yard"'), "debug surface identifies the real-art lineage");
assert.ok(html.includes("var(--art-tile-a)"), "board tile art is wired");
// #160 D-d: byte ceiling checked above. D-e: ack invariance
assert.ok(html.includes(".block.grabbed{scale:1.04"), "D-e: grabbed scale rule survives");
assert.ok(html.includes(".block.grabbed .block-cell{outline:3px solid #fff}"), "D-e: grabbed outline rule survives");
// #160: block-skin and door-thickness tokens present
assert.ok(html.includes("--door-thickness:calc(0.625"), "D: door thickness token scales with cell");
assert.ok(html.includes("block-skin"), "D: block-skin element class is in the build");

const feelRoot = new URL("../../game/design/motion/issue_158_open_lane/", import.meta.url);
const timing = JSON.parse(readFileSync(new URL("timing.json", feelRoot), "utf8"));
// Assert COVERAGE, not a tally: the old `beats.length === 10` red the moment PULSE
// added the #160 blocked_fail row (9d1deec0), which is exactly the kind of legitimate
// growth a count punishes. Name the rows #158 depends on instead — adding a row is
// free, dropping one that the build reads is not.
const REQUIRED_BEATS = [
  "boot_to_actionable", "pointerdown_ack", "drag_follow", "illegal_push", "exit_slide_out",
  "gate_flare", "echo_apply", "exit_echo_playable", "undo", "clear",
];
for (const id of REQUIRED_BEATS) {
  assert.ok(timing.beats.some((beat) => beat.id === id), `PULSE row ${id} is transcribed`);
}
const timingById = Object.fromEntries(timing.beats.map((beat) => [beat.id, beat]));
assert.equal(Object.keys(timingById).length, timing.beats.length, "PULSE timing row IDs are unique");
assert.equal(timing.easeOutCubic, "cubic-bezier(0.33, 1, 0.68, 1)");
assert.equal(timingById.boot_to_actionable.boot_to_actionable_max_ms, 300, "PLAY→board actionable ceiling is 300 ms");
assert.equal(timingById.boot_to_actionable.clock_start, "accepted PLAY pointerdown", "entry budget starts on accepted PLAY");
assert.equal(timingById.boot_to_actionable.code_segment_max_ms, 100, "DCL→PLAY-tappable ceiling is 100 ms");
assert.equal(timingById.boot_to_actionable.code_segment_start, "PerformanceNavigationTiming.domContentLoadedEventEnd", "code segment starts at DCL");
assert.match(timingById.boot_to_actionable.network_segment, /REPORTED_NOT_GATED/, "the navigation term is reported, never gated");
assert.match(timingById.boot_to_actionable.audio_contract, /ready === true/, "audio must be decoded before the board is actionable");
assert.equal(timingById.exit_echo_playable.duration_ms, 540, "exit→echo→playable chain is exactly 540 ms");

const ack = timingById.pointerdown_ack;
assert.equal(ack.first_visible_change_max_ms, 16.7, "ack budget is 16.7 ms");
assert.match(ack.measurement_ownership.headless, /STRUCTURAL_ONLY/, "headless owns the structural property only");
assert.match(ack.measurement_ownership.headless, /never pass or fail the 16\.7ms number/, "headless must not verdict the number");
assert.match(ack.measurement_ownership.numeric, /OWNER_DEVICE_ONLY/, "the number is an owner-device measurement");

// The structural substitute is only valid while the ack-carrying component is
// transition-free. Pin .block-cell, not .block: the block legitimately carries
// the 48 ms grabbed-scale transition.
const ackRule = html.match(/\.block\.grabbed \.block-cell\{([^}]*)\}/);
assert.ok(ackRule, "the shipped ack rule .block.grabbed .block-cell exists");
assert.match(ackRule[1], /outline:3px solid #fff/, "the ack is a 3px white outline");
const cellBase = html.match(/\n\.block-cell\{([^}]*)\}/);
assert.ok(cellBase, ".block-cell base rule exists");
assert.doesNotMatch(cellBase[1], /transition/, "the ack-carrying component must stay transition-free");
assert.doesNotMatch(ackRule[1], /transition/, "the ack rule itself must stay transition-free");

assert.ok(html.includes(`const INLINE_TIMING = ${JSON.stringify(timing)};`), "generated playable embeds timing.json verbatim");

const manifest = JSON.parse(readFileSync(new URL("./audio/manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.schema, "forge.open-lane-audio-manifest.v2");
const eventMapBytes = readFileSync(new URL("event_map.json", feelRoot));
assert.equal(
  createHash("sha256").update(eventMapBytes).digest("hex"),
  manifest.event_map_sha256,
  "audio manifest binds the exact event_map bytes"
);
const audioMap = JSON.parse(eventMapBytes);
const mappedAudio = [...audioMap.events, audioMap.music];
assert.deepEqual(
  Object.keys(manifest.assets).sort(),
  mappedAudio.map((item)=>item.id).sort(),
  "manifest covers every mapped event and the music bed"
);
for (const [id, entry] of Object.entries(manifest.assets)) {
  const bytes = readFileSync(new URL(`./audio/${entry.file}`, import.meta.url));
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, entry.sha256, `${id} delivery hash`);
  assert.equal(bytes.length, entry.bytes, `${id} delivery byte count`);
  assert.ok(html.includes(`data:audio/mpeg;base64,${bytes.toString("base64")}`), `${id} is embedded`);
}
assert.equal(Object.keys(manifest.assets).length, 8, "8/8 runtime audio hashes are bound");

// AUDIO INPUT CONTRACT (#158, added 2026-07-27 after 9d1deec0 renamed every event id
// in event_map.json without touching the shell that plays them or moving the bytes).
// Nothing scored the link between the ids the SHELL asks for and the ids the DATA
// provides: the map went to {grab, illegal_nudge, slide_tick, exit_door,
// level_complete, fail}, the shell kept asking for {grab_tick, exit_whoosh,
// echo_thunk}, and every gameplay sound would have shipped silent. The build only
// escaped because it died on a missing file first. Assert the contract, not the file.
const playedIds = [...new Set([...html.matchAll(/audioBus\.play\("([^"]+)"\)/g)].map((m) => m[1]))];
assert.deepEqual(
  playedIds.sort(),
  audioMap.events.map((event)=>event.id).sort(),
  "the shell schedules every mapped gameplay event"
);
const mappedIds = new Set(audioMap.events.map((event) => event.id));
for (const id of playedIds) {
  assert.ok(mappedIds.has(id), `audioBus.play("${id}") resolves to an event in event_map.json`);
  const file = audioMap.events.find((event) => event.id === id).file;
  const bytes = readFileSync(new URL(`./audio/${file}`, import.meta.url));
  assert.ok(html.includes(`data:audio/mpeg;base64,${bytes.toString("base64")}`), `${id} audio is inlined in the build`);
}
for (const functionName of ["startDrag", "commitExitChain", "endDrag"]) {
  const match = html.match(new RegExp(`function ${functionName}\\([^]*?\\n}`));
  assert.ok(match, `${functionName} input path exists`);
  assert.equal(/\bawait\b/.test(match[0]), false, `${functionName} input path never awaits audio`);
}

// #160 win-timing gate (PULSE db9979fb) — celebration present + advance ≤1200 ms
const gateDir = new URL("../../game/design/motion/issue_160_open_lane_refs/", import.meta.url);
execFileSync(process.execPath, [fileURLToPath(new URL("win_timing_gate.mjs", gateDir))], { stdio: "inherit" });
execFileSync(process.execPath, [fileURLToPath(new URL("win_timing_gate_can_fail.mjs", gateDir))], { stdio: "inherit" });

// #160 T13 provenance gate. `--check` must be read-only and stand alone:
// `--write` is an authoring command that would refresh hashes from tampered
// working-tree bytes before this suite had a chance to reject them.
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("../../docs/art/open_lane/provenance_manifest.mjs", import.meta.url)),
    "--check",
  ],
  { stdio: "inherit" },
);

process.stdout.write("OPEN LANE S1/S2 PASS — model + schema + deterministic inline playable\n");
