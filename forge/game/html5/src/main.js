// main.js — bootstrap: load data → Session → rAF loop (spec §2, §5).
// Fixed tween clock in ms, dt clamped to 32ms so a background tab cannot
// fling animations. Single rAF loop; draws only when something changed.

import { createBoard } from './core/board.js';
import { createSession, retry } from './core/session.js';
import { computeLayout, hudZones } from './render/layout.js';
import { createRenderer, draw, markDirty } from './render/boardRenderer.js';
import {
  createFx, fxLoadLevel, fxUpdate, fxBloom, fxThiefCatchStart, fxThiefCatchSkip,
  fxFailFade, noteCatchStart,
} from './render/fx.js';
import { createSfx, sfxToggleMute, sfxCatch } from './audio/sfx.js';
import { attachTapRouter } from './input/tapRouter.js';

const t0 = performance.now();

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return res.json();
}

// #141: preload painted button sprites (CANVAS source art, shipped bytes).
// Greybox loaded NO images before — these are the first shipped assets.
async function preloadImages() {
  const specs = [
    ['primary', 'assets/ui/btn_primary_default.webp'],
    ['primaryPressed', 'assets/ui/btn_primary_pressed.webp'],
    ['secondary', 'assets/ui/btn_secondary_default.webp'],
    ['secondaryPressed', 'assets/ui/btn_secondary_pressed.webp'],
  ];
  const imgs = {};
  await Promise.all(specs.map(([key, src]) => {
    const img = new Image();
    img.src = src;
    return img.decode().then(() => { imgs[key] = img; }).catch(() => {});
  }));
  return imgs;
}

async function boot() {
  const [pack, feel, tuning, images] = await Promise.all([
    loadJson('src/data/levels.p1.json'),
    loadJson('src/data/feel.json'),
    loadJson('src/data/tuning.json'),
    preloadImages(),
  ]);

  const canvas = document.getElementById('game');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = tuning.designWidthPx * dpr;
  canvas.height = tuning.designHeightPx * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const G = {
    pack, feel, tuning,
    canvas, dpr,
    sfx: createSfx(),
    fx: createFx(feel),
    zones: hudZones(tuning),
    images,
    levelIndex: 0,
    board: null, session: null, layout: null, renderer: null,
    ui: { phase: 'play', animating: false, hasNext: true, phaseT0: 0 },
    clock: 0,
    lastTs: 0,
  };

  loadLevel(G, 0);

  G.onMute = () => {
    const muted = sfxToggleMute(G.sfx);
    G.muted = muted;
    markDirty(G.renderer);
  };
  G.onAction = () => {
    if (G.ui.phase === 'won') {
      loadLevel(G, (G.levelIndex + 1) % G.pack.levels.length);
    } else if (G.ui.phase === 'failed') {
      retry(G.session, G.tuning);
      G.ui.phase = 'play';
      markDirty(G.renderer);
    }
  };
  G.onSolve = () => {
    fxBloom(G.fx);
    G.ui.phase = 'bloom';
    G.ui.phaseT0 = G.clock;
    G.ui.animating = true;
  };
  G.onCatchStart = () => {
    fxThiefCatchStart(G.fx);
    noteCatchStart(G.fx);
    sfxCatch(G.sfx);
    G.ui.phase = 'catch';
    G.ui.phaseT0 = G.clock;
  };
  G.onCatchTap = () => {
    if (G.clock - G.ui.phaseT0 >= G.feel.thiefCatch.skippableAfterMs) {
      fxThiefCatchSkip(G.fx);
      G.ui.phase = 'won';
      markDirty(G.renderer);
    }
  };
  G.onFail = () => {
    fxFailFade(G.fx);
    G.ui.phase = 'failed';
    G.ui.animating = true;
    markDirty(G.renderer);
  };
  G.muted = G.sfx.muted;

  attachTapRouter(canvas, G);

  const loop = (ts) => {
    const dt = G.lastTs === 0 ? 0 : Math.min(ts - G.lastTs, 32); // dt clamp 32ms
    G.lastTs = ts;
    G.clock += dt;
    fxUpdate(G.fx, G.clock);

    // phase machine: bloom → catch → won (rows 6→7 are one continuous beat)
    if (G.ui.phase === 'bloom' && G.clock - G.ui.phaseT0 >= G.feel.boardSolveBloom.totalMs) {
      G.onCatchStart();
    } else if (G.ui.phase === 'catch' && G.clock - G.ui.phaseT0 >= G.feel.thiefCatch.totalMs) {
      G.ui.phase = 'won';
      markDirty(G.renderer);
    } else if (G.ui.phase === 'failed' && G.fx.activeCount === 0) {
      G.ui.animating = false;
    }
    if (G.ui.phase === 'won' || G.ui.phase === 'play') G.ui.animating = false;

    draw(G.renderer, G.fx, G.ui, G.muted);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  console.log(`[boot] first frame queued in ${(performance.now() - t0).toFixed(0)}ms · ${pack.levels.length} levels · seed ${pack.meta.source_seed}`);
}

function loadLevel(G, index) {
  G.levelIndex = index;
  const level = G.pack.levels[index];
  G.board = createBoard(level);
  G.session = createSession(G.board, G.tuning);
  G.layout = computeLayout(G.tuning, G.board.n);
  G.renderer = createRenderer(G.canvas, G.board, G.session, G.layout, G.zones);
  G.renderer.images = G.images;
  fxLoadLevel(G.fx, G.board.n);
  G.ui.phase = 'play';
  G.ui.hasNext = index < G.pack.levels.length - 1;
  markDirty(G.renderer);
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="color:#f66;padding:20px">BOOT FAIL\n${e.stack}</pre>`;
});
