#!/usr/bin/env node
// OPEN LANE #158 — exhaustive BFS solver over the SHIPPED model (model.js).
// P1 P4 · SKILL§3 (no verifier trusted until proven it can fail — see --canfail).
//
// MOVE DEFINITION (matches endDrag() in index.html):
//   1 move = one grab-drag-release that repositions a block.
//   An exit is NOT a move: endDrag() auto-fires canExit()/applyExit() on release,
//   so every exit reachable after a drag is a free consequence of that drag.
// A level's `par` is therefore the minimum number of DRAGS to clear the board.
import {
  applyDrag,
  applyExit,
  canExit,
  isClear,
  legalStep,
  loadLevel,
  snapshot,
} from "./model.js";

const key = (state) => JSON.stringify(snapshot(state));

// Every cell this block can legally walk to, one orthogonal step at a time.
// BOUNDED: legalStep() rejects out-of-grid and occupied targets, so the frontier
// can never leave the w*h grid. (The previous revision enqueued raw dx/dy without
// a legality check and grew the Set until Node threw "Set maximum size exceeded".)
function reachablePlacements(state, blockId) {
  const origin = state.blocks.find((b) => b.id === blockId);
  if (!origin) return [];
  const out = [];
  const seen = new Set([`${origin.at[0]},${origin.at[1]}`]);
  const queue = [state];
  while (queue.length) {
    const cur = queue.shift();
    const block = cur.blocks.find((b) => b.id === blockId);
    if (!block) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!legalStep(cur, blockId, dx, dy)) continue;
      const to = [block.at[0] + dx, block.at[1] + dy];
      const cellId = `${to[0]},${to[1]}`;
      if (seen.has(cellId)) continue;
      seen.add(cellId);
      const next = applyDrag(cur, blockId, to);
      out.push({ state: next, at: to });
      queue.push(next);
    }
  }
  return out;
}

// endDrag() exits ONLY the block the player just released — there is no cascade.
// Any other block that happens to sit on its gate stays put until it is itself
// tapped. Draining all exits here would have made L1/L2 "solve" in 0 drags.
function releaseOne(state, blockId) {
  const gateId = canExit(state, blockId);
  return gateId ? applyExit(state, blockId, gateId).state : state;
}

// Every move a player can make with one block: a tap in place (zero displacement
// still reaches endDrag on pointerup) plus every legal drag destination. Either
// one exits the block if it lands on a matching gate path.
export function movesFor(state, blockId) {
  const here = state.blocks.find((b) => b.id === blockId);
  const out = [{ state: releaseOne(state, blockId), at: [...here.at], tap: true }];
  for (const placement of reachablePlacements(state, blockId)) {
    out.push({ state: releaseOne(placement.state, blockId), at: placement.at, tap: false });
  }
  return out;
}

export const solve = (levelJson, maxStates = 400000) =>
  solveFrom(loadLevel(levelJson), maxStates);

// Breadth-first from an arbitrary mid-game state, so a caller can ask "is the
// board still winnable after this move?" — the question R10' (the dead-end chip)
// has to answer at runtime, and the one C5 uses to prove a level can be doomed.
export function solveFrom(start, maxStates = 400000) {
  if (isClear(start)) return { solvable: true, moves: 0, path: [], states: 1 };

  const seen = new Set([key(start)]);
  let frontier = [{ state: start, path: [] }];
  let depth = 0;

  while (frontier.length) {
    if (seen.size > maxStates) return { solvable: "unknown", moves: -1, states: seen.size };
    depth += 1;
    const next = [];
    for (const node of frontier) {
      for (const block of node.state.blocks) {
        for (const move of movesFor(node.state, block.id)) {
          const id = key(move.state);
          if (seen.has(id)) continue;
          seen.add(id);
          const label = move.tap ? `tap ${block.id}` : `${block.id}->[${move.at}]`;
          const path = [...node.path, label];
          if (isClear(move.state)) return { solvable: true, moves: depth, path, states: seen.size };
          next.push({ state: move.state, path });
        }
      }
    }
    frontier = next;
  }
  return { solvable: false, moves: -1, states: seen.size };
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

// Only run the CLI when invoked directly. Without this the whole level sweep
// re-ran on every `import { solve }`, so nothing could reuse solve() as a library.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
const args = isMain ? process.argv.slice(2) : [];

// --levels <dir> retargets the reader so the SAME instrument can score the level
// set inlined into a shipped build, not just the authoring source. The divergence
// between those two copies is the defect this flag exists to catch.
const dirFlag = args.indexOf("--levels");
const levelsDir = dirFlag >= 0 ? args[dirFlag + 1] : join(root, "levels");
if (dirFlag >= 0) args.splice(dirFlag, 2);
const readLevel = (id) => JSON.parse(readFileSync(join(levelsDir, `${id}.json`), "utf8"));

// SKILL§3 — the solver must be able to report RED. An unsolvable board is
// synthesised by walling off every gate span; if this prints SOLVABLE the
// solver is a rubber stamp and every green above it is void.
if (isMain && args[0] === "--canfail") {
  const level = readLevel(args[1] || "L1");
  const walls = new Set((level.walls || []).map((w) => `${w[0]},${w[1]}`));
  for (const gate of level.gates) {
    const [start, length] = gate.span;
    for (let i = 0; i < length; i += 1) {
      const along = start + i;
      if (gate.side === "N") walls.add(`${along},0`);
      else if (gate.side === "S") walls.add(`${along},${level.grid.h - 1}`);
      else if (gate.side === "W") walls.add(`0,${along}`);
      else walls.add(`${level.grid.w - 1},${along}`);
    }
  }
  const sealed = { ...level, walls: [...walls].map((k) => k.split(",").map(Number)) };
  sealed.blocks = level.blocks.filter(
    (b) => !sealed.walls.some(([x, y]) => x === b.at[0] && y === b.at[1]),
  );
  const result = solve(sealed);
  const red = result.solvable === false;
  console.log(`CAN-FAIL (${level.id}, gates sealed): solvable=${result.solvable} states=${result.states}`);
  console.log(red ? "CAN-FAIL PASS: solver reports UNSOLVABLE on a sealed board" : "CAN-FAIL FAIL: solver rubber-stamped a sealed board");
  process.exit(red ? 0 : 1);
}

const ids = !isMain ? [] : !args[0] || args[0] === "all" ? ["L1", "L2", "L3"] : args;
let green = true;

for (const id of ids) {
  const level = readLevel(id);
  const result = solve(level);
  const parOk = result.solvable === true && result.moves === level.par;
  // A level whose optimal line is all taps never asks the player to move a block
  // through the grid — the core verb (P2) is not exercised, whatever par says.
  const drags = (result.path || []).filter((step) => !step.startsWith("tap")).length;
  console.log(
    `${id}: ${result.solvable === true ? "SOLVABLE" : String(result.solvable).toUpperCase()} in ${result.moves} moves; par=${level.par}; ${parOk ? "PAR-OK" : "PAR-FAIL"}; drags-in-optimal=${drags}${drags === 0 ? " (TAP-ONLY — core verb unexercised)" : ""} (${result.states} states)`,
  );
  if (result.path?.length) console.log(`  optimal: ${result.path.join(" -> ")}`);
  if (!parOk) green = false;
}

if (isMain) {
  // Checking nothing is not passing. paper_check.mjs prints RESULT: PASS with no
  // file args over zero levels; this gate must never inherit that shape.
  if (ids.length === 0) {
    console.log("RESULT: FAIL — no levels checked");
    process.exit(1);
  }
  console.log(`checked ${ids.length} level(s): ${ids.join(", ")}`);
  console.log(green ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(green ? 0 : 1);
}
