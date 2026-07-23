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

const WINDOW_MS = 250;

export function createSfx() {
  const muted = localStorage.getItem('copdoku_muted') === '1';
  const sfx = {
    ctx: null, master: null, muted, unlocked: false, buffers: {}, gain: 0.9,
    loaded: [], failed: [],
    _lastEventTag: '', _eventCount: 0,
    _peakRms: 0, _peakTs: 0,
  };
  return sfx;
}

/** Decode all 14 mp3s once, attach analyser chain, expose callable probe. */
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

    for (const r of results) {
      if (r.status === 'fulfilled') {
        sfx.loaded.push(r.value.key);
        try {
          const ab = await sfx.ctx.decodeAudioData(r.value.buf);
          sfx.buffers[r.value.key] = ab;
        } catch (e) {
          sfx.failed.push(r.value.key);
        }
      } else {
        const key = SFX_KEYS.find((k) => r.reason.message.startsWith(`${k}:`)) || r.reason.message;
        sfx.failed.push(key);
      }
    }

    sfx.unlocked = true;
    window.__copdokuAudioProbe = () => _probe(sfx);
  } catch (e) {
    // audio unavailable — game must never crash on sound
    window.__copdokuAudioProbe = () => _probe(sfx); // probe still callable
  }
}

let _unlockPromise = null;
export function sfxUnlock(sfx) {
  if (!_unlockPromise && !sfx.unlocked) _unlockPromise = _unlock(sfx);
  return _unlockPromise;
}

function _readRms(sfx) {
  if (!sfx.analyser) return 0;
  const data = new Float32Array(sfx.analyser.fftSize);
  sfx.analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

function _probe(sfx) {
  const now = performance.now();
  // push new sample
  if (!sfx._rmsWindow) sfx._rmsWindow = [];
  sfx._rmsWindow.push({ t: now, rms: _readRms(sfx) });
  // discard samples older than 250ms
  const cutoff = now - WINDOW_MS;
  while (sfx._rmsWindow.length && sfx._rmsWindow[0].t < cutoff) sfx._rmsWindow.shift();
  // peak over the window
  let peak = 0;
  for (const s of sfx._rmsWindow) if (s.rms > peak) peak = s.rms;
  sfx._peakRms = peak;
  sfx._peakTs = now;
  return {
    ctxState: sfx.ctx ? sfx.ctx.state : 'closed',
    sampleRate: sfx.ctx ? sfx.ctx.sampleRate : 0,
    peakRms: sfx._peakRms,
    lastEventTag: sfx._lastEventTag,
    eventCount: sfx._eventCount,
  };
}

function _tag(sfx, tag) {
  sfx._lastEventTag = tag;
  sfx._eventCount++;
}

function _play(sfx, key, tag, gainDb = 0, delayMs = 0) {
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
  _tag(sfx, tag);
}

export function sfxToggleMute(sfx) {
  sfx.muted = !sfx.muted;
  localStorage.setItem('copdoku_muted', sfx.muted ? '1' : '0');
  return sfx.muted;
}

// ---- DESIGNED EVENTS (§4.6) ----
export const sfxAck = () => {}; // T0: silent (PULSE row 1) — outcome sounds carry audio

export function sfxMark(sfx)      { _play(sfx, 'x_mark', 'mark'); }
export function sfxPlace(sfx)     { _play(sfx, 'place', 'place'); }
export function sfxCascade(sfx)   { _play(sfx, 'cascade_tick', 'cascade'); }
export const sfxBlocked = () => {}; // row 10 SILENT (PULSE v5)
export function sfxWrong(sfx)     { _play(sfx, 'heart_loss', 'wrong'); }
export function sfxRegion(sfx)    { _play(sfx, 'region', 'region'); }
export function sfxCatch(sfx)     { _play(sfx, 'catch_spot', 'catch'); }
export function sfxUi(sfx)        { _play(sfx, 'ui_whoosh', 'ui'); }

// #143 stage-2 (wired now, called when client runtime lands)
export function sfxMorph(sfx)         { _play(sfx, 'morph', 'morph'); }
export function sfxCatchRush(sfx)     { _play(sfx, 'catch_rush', 'catch_rush'); }
export function sfxCatchCuff(sfx)     { _play(sfx, 'catch_cuff', 'catch_cuff'); }
export function sfxCatchResolve(sfx)  { _play(sfx, 'catch_resolve', 'catch_resolve'); }
export function sfxSolveRise(sfx)     { _play(sfx, 'solve_rise', 'solve_rise'); }
export function sfxFadeDiag(sfx)      { _play(sfx, 'cascade_diag', 'cascade_diag'); }