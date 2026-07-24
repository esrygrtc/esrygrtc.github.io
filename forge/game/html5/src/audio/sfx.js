// sfx.js — #141 SPEC FROZEN dc5c084d. 14 mp3s from manifest.json, wired.
// Lazy-unlocked on first pointerdown (iOS autoplay policy). Mute toggle
// persisted to localStorage (Meowdoku top-5 complaint, #130 §4).
// P8: sound is information — every gameplay event gets a designed sound.
// #141 R3: gapless observer via ScriptProcessorNode — no dead time.
// dutyCycle measured in _probe(), ~1.0 when observer is connected.
// R4: probe exposes loaded/failed. R5: loaded.push after decode.
// §7.2.7 can-fail wired (tools/sfx_probe_selftest.mjs).

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
    _peakRms: 0, _peakSinceLastPoll: 0, _rmsWindow: [],
    _obsNode: null, _framesObserved: 0,
  };
  return sfx;
}

function _startSampling(sfx) {
  if (sfx._obsNode) return;
  // Gapless observer on master, parallel to analyser.
  // ScriptProcessorNode(256, 1, 1) fires every ~5.3 ms at 48 kHz.
  // Must route through a zero-gain sink to ctx.destination;
  // a ScriptProcessor that reaches no destination never fires.
  const obs = sfx.ctx.createScriptProcessor(256, 1, 1);
  sfx.master.connect(obs);
  const sink = sfx.ctx.createGain();
  sink.gain.value = 0;
  obs.connect(sink);
  sink.connect(sfx.ctx.destination);

  sfx._obsNode = obs;
  sfx._framesObserved = 0;

  obs.onaudioprocess = (ev) => {
    const data = ev.inputBuffer.getChannelData(0);
    const len = data.length;
    sfx._framesObserved += len;

    // Per-block peak-abs and RMS
    let sumSq = 0;
    let peakAbs = 0;
    for (let i = 0; i < len; i++) {
      const v = data[i];
      sumSq += v * v;
      const abs = Math.abs(v);
      if (abs > peakAbs) peakAbs = abs;
    }
    const rms = Math.sqrt(sumSq / len);
    const now = performance.now();

    // Rolling 250 ms window for peakRms (same semantic as before)
    sfx._rmsWindow.push({ t: now, rms });
    const cutoff = now - WINDOW_MS;
    while (sfx._rmsWindow.length && sfx._rmsWindow[0].t < cutoff) sfx._rmsWindow.shift();
    let peak = 0;
    for (const s of sfx._rmsWindow) if (s.rms > peak) peak = s.rms;
    sfx._peakRms = peak;

    // Peak-abs since last probe read — catches transients RMS smooths out
    if (peakAbs > sfx._peakSinceLastPoll) sfx._peakSinceLastPoll = peakAbs;
  };
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

    _startSampling(sfx);

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
        // R5: push loaded only after successful decode — loaded ∩ failed === ∅
        try {
          const ab = await sfx.ctx.decodeAudioData(r.value.buf);
          sfx.buffers[r.value.key] = ab;
          sfx.loaded.push(r.value.key);
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

function _probe(sfx) {
  // R3: peakSinceLastPoll captures max peak-abs over every audio block
  // since last read, then resets. Driven by gapless ScriptProcessorNode.
  const peakSinceLastPoll = sfx._peakSinceLastPoll || 0;
  sfx._peakSinceLastPoll = 0;

  const sampleRate = sfx.ctx ? sfx.ctx.sampleRate : 0;
  const framesObserved = sfx._framesObserved || 0;
  const framesElapsed = sfx.ctx ? Math.round(sfx.ctx.currentTime * sampleRate) : 0;
  const dutyCycle = framesElapsed > 0 ? framesObserved / framesElapsed : 0;

  // R4: loaded/failed now readable from the page
  return {
    ctxState: sfx.ctx ? sfx.ctx.state : 'closed',
    sampleRate,
    peakRms: sfx._peakRms || 0,
    peakSinceLastPoll,
    framesObserved,
    framesElapsed,
    dutyCycle,
    loaded: [...sfx.loaded],
    failed: [...sfx.failed],
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