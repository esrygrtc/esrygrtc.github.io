// sfx.js — #141 SPEC FROZEN dc5c084d. 14 mp3s from manifest.json, wired.
// Lazy-unlocked on first pointerdown (iOS autoplay policy). Mute toggle
// persisted to localStorage (Meowdoku top-5 complaint, #130 §4).
// P8: sound is information — every gameplay event gets a designed sound.

const SFX_KEYS = [
  'x_mark', 'place', 'cascade_tick', 'cascade_diag',
  'region', 'solve_rise', 'catch_spot', 'catch_rush',
  'catch_cuff', 'catch_resolve', 'heart_loss', 'fail',
  'ui_whoosh', 'morph',
];

export function createSfx() {
  const muted = localStorage.getItem('copdoku_muted') === '1';
  return { ctx: null, master: null, muted, unlocked: false, buffers: {}, gain: 0.9 };
}

/** Decode all 14 mp3s once, attach analyser chain, expose to CDP probe. */
async function _unlock(sfx) {
  if (sfx.unlocked) return;
  try {
    sfx.ctx = new (window.AudioContext || window.webkitAudioContext)();
    sfx.master = sfx.ctx.createGain();
    sfx.master.gain.value = sfx.gain;
    sfx.analyser = sfx.ctx.createAnalyser();
    sfx.analyser.fftSize = 512;
    sfx.master.connect(sfx.analyser);
    sfx.analyser.connect(sfx.ctx.destination);

    const results = await Promise.allSettled(
      SFX_KEYS.map(async (key) => {
        const resp = await fetch(`audio/sfx/${key}.mp3`);
        if (!resp.ok) throw new Error(`${key}: HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        return { key, buf };
      })
    );

    const decodes = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        decodes.push(
          sfx.ctx.decodeAudioData(r.value.buf).then((ab) => ({ key: r.value.key, ab }))
        );
      }
    }
    const decoded = await Promise.allSettled(decodes);
    for (const d of decoded) {
      if (d.status === 'fulfilled') sfx.buffers[d.value.key] = d.value.ab;
    }

    sfx.unlocked = true;
    window.__copdokuAudioProbe = sfx; // VERITY CDP probe hook
  } catch (e) {
    // audio unavailable — game must never crash on sound
  }
}

let _unlockPromise = null;
export function sfxUnlock(sfx) {
  if (!_unlockPromise && !sfx.unlocked) _unlockPromise = _unlock(sfx);
  return _unlockPromise;
}

function _play(sfx, key, gainDb = 0, delayMs = 0) {
  if (!sfx.unlocked || sfx.muted) return;
  const buf = sfx.buffers[key];
  if (!buf) return;
  const t0 = sfx.ctx.currentTime + delayMs / 1000;
  const src = sfx.ctx.createBufferSource();
  src.buffer = buf;
  const g = sfx.ctx.createGain();
  g.gain.setValueAtTime(Math.pow(10, gainDb / 20), t0);
  src.connect(g); g.connect(sfx.master);
  src.start(t0);
}

export function sfxToggleMute(sfx) {
  sfx.muted = !sfx.muted;
  localStorage.setItem('copdoku_muted', sfx.muted ? '1' : '0');
  return sfx.muted;
}

// ---- DESIGNED EVENTS (§4.6) ----
export const sfxAck = () => {}; // T0: silent (PULSE row 1) — outcome sounds carry audio

export function sfxMark(sfx)      { _play(sfx, 'x_mark'); }
export function sfxPlace(sfx)     { _play(sfx, 'place'); }
export function sfxCascade(sfx)   { _play(sfx, 'cascade_tick'); }
export const sfxBlocked = () => {}; // row 10 SILENT (PULSE v5)
export function sfxWrong(sfx)     { _play(sfx, 'heart_loss'); }
export function sfxRegion(sfx)    { _play(sfx, 'region'); }
export function sfxCatch(sfx)     { _play(sfx, 'catch_spot'); }
export function sfxUi(sfx)        { _play(sfx, 'ui_whoosh'); }

// #143 stage-2 (wired now, called when client runtime lands)
export function sfxMorph(sfx)         { _play(sfx, 'morph'); }
export function sfxCatchRush(sfx)     { _play(sfx, 'catch_rush'); }
export function sfxCatchCuff(sfx)     { _play(sfx, 'catch_cuff'); }
export function sfxCatchResolve(sfx)  { _play(sfx, 'catch_resolve'); }
export function sfxSolveRise(sfx)     { _play(sfx, 'solve_rise'); }
export function sfxFadeDiag(sfx)      { _play(sfx, 'cascade_diag'); }