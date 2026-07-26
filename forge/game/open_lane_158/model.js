// OPEN LANE #158 — pure deterministic model. No DOM, clocks, RNG, or globals.

const COLOR_SYMBOL = Object.freeze({
  amber: "circle",
  teal: "triangle",
  violet: "square",
  lime: "cross",
});

const DIR = Object.freeze({
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
});

const MAX_STEPS_PER_FRAME = 4;

const copyPoint = ([x, y]) => [x, y];
const copyBlock = (block) => ({
  ...block,
  cells: block.cells.map(copyPoint),
  at: copyPoint(block.at),
});
const copyGate = (gate) => ({
  ...gate,
  span: [...gate.span],
  echo: gate.echo
    ? { ...gate.echo, cells: gate.echo.cells.map(copyPoint) }
    : null,
});
const copyFrame = (frame) => ({
  blocks: frame.blocks.map(copyBlock),
  walls: frame.walls.map(copyPoint),
  gateFired: { ...frame.gateFired },
});

function frameOf(state) {
  return {
    blocks: state.blocks.map(copyBlock),
    walls: state.walls.map(copyPoint),
    gateFired: { ...state.gateFired },
  };
}

function cloneState(state) {
  return {
    level: {
      ...state.level,
      grid: { ...state.level.grid },
      initialWalls: state.level.initialWalls.map(copyPoint),
      gates: state.level.gates.map(copyGate),
    },
    blocks: state.blocks.map(copyBlock),
    walls: state.walls.map(copyPoint),
    gateFired: { ...state.gateFired },
    history: state.history.map(copyFrame),
    lastAction: state.lastAction ? { ...state.lastAction } : null,
  };
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function blockFootprint(block, at = block.at) {
  return block.cells.map(([dx, dy]) => [at[0] + dx, at[1] + dy]);
}

function occupiedKeys(state, exceptBlockId = null) {
  const occupied = new Set(state.walls.map(([x, y]) => cellKey(x, y)));
  for (const block of state.blocks) {
    if (block.id === exceptBlockId) continue;
    for (const [x, y] of blockFootprint(block)) occupied.add(cellKey(x, y));
  }
  return occupied;
}

function isInside(state, x, y) {
  return x >= 0 && y >= 0 && x < state.level.grid.w && y < state.level.grid.h;
}

function loadLevel(json) {
  const level = {
    id: json.id,
    grid: { w: json.grid.w, h: json.grid.h },
    initialWalls: (json.walls || []).map(copyPoint),
    gates: (json.gates || []).map(copyGate),
    par: json.par,
  };
  return {
    level,
    blocks: json.blocks.map(copyBlock),
    walls: level.initialWalls.map(copyPoint),
    gateFired: Object.fromEntries(level.gates.map((gate) => [gate.id, false])),
    history: [],
    lastAction: null,
  };
}

function legalStep(state, blockId, dx, dy) {
  if (Math.abs(dx) + Math.abs(dy) !== 1) return false;
  const block = state.blocks.find((candidate) => candidate.id === blockId);
  if (!block) return false;
  const to = [block.at[0] + dx, block.at[1] + dy];
  const occupied = occupiedKeys(state, blockId);
  for (const [x, y] of blockFootprint(block, to)) {
    if (!isInside(state, x, y) || occupied.has(cellKey(x, y))) return false;
  }
  return true;
}

function applyDrag(state, blockId, toAt) {
  const next = cloneState(state);
  const block = next.blocks.find((candidate) => candidate.id === blockId);
  if (!block || !Array.isArray(toAt) || toAt.length !== 2) return next;

  const before = frameOf(state);
  let remainingX = Math.trunc(toAt[0]) - block.at[0];
  let remainingY = Math.trunc(toAt[1]) - block.at[1];
  let steps = 0;

  while ((remainingX !== 0 || remainingY !== 0) && steps < MAX_STEPS_PER_FRAME) {
    const xFirst = Math.abs(remainingX) >= Math.abs(remainingY);
    const primary = xFirst
      ? [Math.sign(remainingX), 0]
      : [0, Math.sign(remainingY)];
    const secondary = xFirst
      ? [0, Math.sign(remainingY)]
      : [Math.sign(remainingX), 0];

    let moved = false;
    for (const [dx, dy] of [primary, secondary]) {
      if (dx === 0 && dy === 0) continue;
      if (legalStep(next, blockId, dx, dy)) {
        block.at[0] += dx;
        block.at[1] += dy;
        remainingX -= dx;
        remainingY -= dy;
        moved = true;
        break;
      }
    }
    if (!moved) break;
    steps += 1;
  }

  if (block.at[0] !== state.blocks.find((b) => b.id === blockId)?.at[0]
      || block.at[1] !== state.blocks.find((b) => b.id === blockId)?.at[1]) {
    if (!(state.lastAction?.type === "drag" && state.lastAction.blockId === blockId)) {
      next.history.push(before);
    }
    next.lastAction = { type: "drag", blockId };
  }
  return next;
}

function gateAllowsCrossing(gate, x, y) {
  const [start, len] = gate.span;
  const edgeCoordinate = gate.side === "N" || gate.side === "S" ? x : y;
  return edgeCoordinate >= start && edgeCoordinate < start + len;
}

function pathClearsGate(state, block, gate) {
  const [dx, dy] = DIR[gate.side];
  const occupied = occupiedKeys(state, block.id);
  let at = copyPoint(block.at);
  const max = state.level.grid.w + state.level.grid.h
    + Math.max(...block.cells.flatMap(([x, y]) => [x, y])) + 4;

  for (let step = 0; step < max; step += 1) {
    const previous = blockFootprint(block, at);
    at = [at[0] + dx, at[1] + dy];
    const footprint = blockFootprint(block, at);
    let anyInside = false;

    for (let i = 0; i < footprint.length; i += 1) {
      const [x, y] = footprint[i];
      const [oldX, oldY] = previous[i];
      if (isInside(state, x, y)) {
        anyInside = true;
        if (occupied.has(cellKey(x, y))) return false;
      } else if (isInside(state, oldX, oldY) && !gateAllowsCrossing(gate, oldX, oldY)) {
        return false;
      }
    }
    if (!anyInside) return true;
  }
  return false;
}

function canExit(state, blockId) {
  const block = state.blocks.find((candidate) => candidate.id === blockId);
  if (!block) return null;
  for (const gate of state.level.gates) {
    if (gate.color === block.color && pathClearsGate(state, block, gate)) return gate.id;
  }
  return null;
}

function applyExit(state, blockId, gateId) {
  const block = state.blocks.find((candidate) => candidate.id === blockId);
  const gate = state.level.gates.find((candidate) => candidate.id === gateId);
  if (!block || !gate || gate.color !== block.color || !pathClearsGate(state, block, gate)) {
    return { state: cloneState(state), echoDelta: [] };
  }

  const next = cloneState(state);
  if (!(state.lastAction?.type === "drag" && state.lastAction.blockId === blockId)) {
    next.history.push(frameOf(state));
  }
  next.blocks = next.blocks.filter((candidate) => candidate.id !== blockId);
  const echoDelta = [];

  if (gate.echo && !next.gateFired[gate.id]) {
    const walls = new Set(next.walls.map(([x, y]) => cellKey(x, y)));
    const occupied = occupiedKeys(next);
    for (const [x, y] of gate.echo.cells) {
      const key = cellKey(x, y);
      if (gate.echo.type === "RETRACT") {
        const before = walls.has(key) ? "WALL" : "EMPTY";
        walls.delete(key);
        echoDelta.push({ cell: [x, y], before, after: "EMPTY" });
      } else if (gate.echo.type === "EXTEND" && !occupied.has(key)) {
        const before = walls.has(key) ? "WALL" : "EMPTY";
        walls.add(key);
        echoDelta.push({ cell: [x, y], before, after: "WALL" });
      }
    }
    next.walls = [...walls].map((key) => key.split(",").map(Number));
    next.gateFired[gate.id] = true;
  }
  next.lastAction = { type: "exit", blockId, gateId };
  return { state: next, echoDelta };
}

function undo(state) {
  if (state.history.length === 0) return cloneState(state);
  const next = cloneState(state);
  const previous = next.history.pop();
  next.blocks = previous.blocks.map(copyBlock);
  next.walls = previous.walls.map(copyPoint);
  next.gateFired = { ...previous.gateFired };
  next.lastAction = { type: "undo" };
  return next;
}

function isClear(state) {
  return state.blocks.length === 0;
}

function snapshot(state) {
  return {
    levelId: state.level.id,
    blocks: state.blocks
      .map((block) => ({ id: block.id, at: copyPoint(block.at) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    walls: state.walls.map(copyPoint).sort(([ax, ay], [bx, by]) => ay - by || ax - bx),
    gateFired: Object.fromEntries(Object.entries(state.gateFired).sort()),
  };
}

export {
  COLOR_SYMBOL,
  MAX_STEPS_PER_FRAME,
  applyDrag,
  applyExit,
  canExit,
  isClear,
  legalStep,
  loadLevel,
  snapshot,
  undo,
};
