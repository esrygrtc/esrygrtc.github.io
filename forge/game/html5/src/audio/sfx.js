// sfx.js — WebAudio placeholder synthesis (spec §4.6, P8: sound = information).
// Oscillators only — no audio files in P1. Six designed events, named by tier.
// Lazily unlocked on first pointerdown (iOS autoplay policy). Mute toggle
// persisted to localStorage (Meowdoku top-5 complaint, #130 §4).

const DB = (db) => Math.pow(10, db / 20);

export function createSfx() {
  const muted = localStorage.getItem('copdoku_muted') === '1';
  return { ctx: null, master: null, muted, unlocked: false };
}

export function sfxUnlock(sfx) {
  if (sfx.unlocked) return;
  try {
    sfx.ctx = new (window.AudioContext || window.webkitAudioContext)();
    sfx.master = sfx.ctx.createGain();
    sfx.master.gain.value = 0.9;
    sfx.analyser = sfx.ctx.createAnalyser();
    sfx.analyser.fftSize = 512;
    sfx.master.connect(sfx.analyser);
    sfx.analyser.connect(sfx.ctx.destination);
    sfx.unlocked = true;
    // runtime-verification hook (VERITY advisory #3, msg 18801): real context
    // state + output energy, readable by the CDP probe. Not used by gameplay.
    window.__copdokuSfx = sfx;
  } catch (e) {
    // audio unavailable — the game must never crash on sound
  }
}

export function sfxToggleMute(sfx) {
  sfx.muted = !sfx.muted;
  localStorage.setItem('copdoku_muted', sfx.muted ? '1' : '0');
  return sfx.muted;
}

function tone(sfx, type, f0, f1, durMs, gainDb, delayMs = 0) {
  if (!sfx.unlocked || sfx.muted) return;
  const t0 = sfx.ctx.currentTime + delayMs / 1000;
  const dur = durMs / 1000;
  const osc = sfx.ctx.createOscillator();
  const g = sfx.ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  g.gain.setValueAtTime(DB(gainDb), t0);
  g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
  osc.connect(g); g.connect(sfx.master);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

// spec §4.6 table — one function per designed event
export const sfxAck = () => {}; // T0: ack is SILENT (PULSE row 1) — outcome sounds carry audio
export function sfxMark(sfx) { tone(sfx, 'square', 900, 900, 40, -18); }                    // T1
export function sfxPlace(sfx) { tone(sfx, 'sine', 220, 180, 90, -8); }                     // T2 two-tone thunk
export function sfxCascade(sfx, ring, rings) {                                             // T1 rising ladder
  tone(sfx, 'square', 520 + ring * 90, 520 + ring * 90, 30, -20 + ring * 2);
}
export function sfxBlocked(sfx) { tone(sfx, 'square', 200, 180, 30, -22); }                // ≤T1
export function sfxWrong(sfx) {                                                            // T2 heavy, dull
  tone(sfx, 'sawtooth', 160, 70, 160, -12);
  tone(sfx, 'sine', 90, 60, 120, -8, 30);
}
export function sfxRegion(sfx) { tone(sfx, 'sine', 440, 554, 120, -12); }                  // T2 rising third
export function sfxCatch(sfx) {                                                            // T3 — the peak
  tone(sfx, 'triangle', 330, 660, 500, -4);
  tone(sfx, 'sine', 165, 330, 500, -8, 40);
  tone(sfx, 'square', 660, 990, 180, -14, 320);
}
export function sfxUi(sfx) { tone(sfx, 'sine', 600, 600, 20, -22); }                       // T1 optional
