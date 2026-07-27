#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const indexPath = join(root, "index.html");
const modelPath = join(root, "model.js");
const levelsPath = join(root, "levels");
const artPath = join(root, "art");
const outFlag = process.argv.indexOf("--out");
const outputPath = outFlag >= 0 ? process.argv[outFlag + 1] : join(root, "playable.html");
const feelRoot = join(root, "../../game/design/motion/issue_158_open_lane");
const timing = JSON.parse(readFileSync(join(feelRoot, "timing.json"), "utf8"));
const eventMapPath = join(feelRoot, "event_map.json");
const eventMapBytes = readFileSync(eventMapPath);
const audioEvents = JSON.parse(eventMapBytes);
const audioManifest = JSON.parse(readFileSync(join(root, "audio", "manifest.json"), "utf8"));
const audioItems = [...audioEvents.events, ...(audioEvents.music ? [audioEvents.music] : [])];
const audioIds = audioItems.map((item) => item.id);
if (new Set(audioIds).size !== audioIds.length) throw new Error("Audio event ids must be unique");
const eventMapHash = createHash("sha256").update(eventMapBytes).digest("hex");
if (audioManifest.event_map_sha256 !== eventMapHash) {
  throw new Error(`Audio manifest event_map_sha256 mismatch: expected ${eventMapHash}, got ${audioManifest.event_map_sha256}`);
}
const manifestIds = Object.keys(audioManifest.assets).sort();
if (JSON.stringify([...audioIds].sort()) !== JSON.stringify(manifestIds)) {
  throw new Error(`Audio manifest ids mismatch: map=${[...audioIds].sort().join(",")} manifest=${manifestIds.join(",")}`);
}
const inlineAudio = {};
for (const item of audioItems) {
  const entry = audioManifest.assets[item.id];
  if (entry.file !== item.file) throw new Error(`Audio file mismatch for ${item.id}: map=${item.file} manifest=${entry.file}`);
  const bytes = readFileSync(join(root, "audio", item.file));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (entry.sha256 !== hash || entry.bytes !== bytes.length) {
    throw new Error(`Audio delivery mismatch for ${item.id}: expected ${entry.sha256}/${entry.bytes}, got ${hash}/${bytes.length}`);
  }
  inlineAudio[item.id] = `data:audio/mpeg;base64,${bytes.toString("base64")}`;
}
// #160: readdirSync replaces hardcoded map — manifest asserts completeness
const manifest = JSON.parse(readFileSync(join(artPath, "manifest.json"), "utf8"));
const manifestSet = new Set([...manifest.blocks, ...manifest.doors, ...manifest.settings, ...manifest.legacy, ...(manifest.t3 || []).map((id) => `t3-${id}`)]);
// Recursive read: art/ root + art/t3/ subdirectory; keys hyphenated (t3-x not t3/x)
const rootPairs = readdirSync(artPath).filter((f) => f.endsWith(".webp")).map((f) => [f.slice(0, -5), f]);
const t3Dir = join(artPath, "t3");
let t3Pairs = [];
try { t3Pairs = readdirSync(t3Dir).filter((f) => f.endsWith(".webp")).map((f) => [`t3-${f.slice(0, -5)}`, `t3/${f}`]); } catch {}
const allPairs = [...rootPairs, ...t3Pairs].sort(([a], [b]) => a.localeCompare(b));
const dirEntries = allPairs.map(([id]) => id);
const dirSet = new Set(dirEntries);
const missingFromDir = [...manifestSet].filter((id) => !dirSet.has(id));
const missingFromManifest = [...dirSet].filter((id) => !manifestSet.has(id));
if (missingFromDir.length || missingFromManifest.length) {
  let msg = "Art manifest mismatch:\n";
  if (missingFromDir.length) msg += `  Missing from dir: ${missingFromDir.join(", ")}\n`;
  if (missingFromManifest.length) msg += `  Missing from manifest: ${missingFromManifest.join(", ")}\n`;
  throw new Error(msg);
}
const artFiles = Object.fromEntries(allPairs);
const inlineArt = Object.fromEntries(
  Object.entries(artFiles).map(([id, file]) => [
    id,
    `data:image/webp;base64,${readFileSync(join(artPath, file)).toString("base64")}`,
  ])
);

const exports = [
  "COLOR_SYMBOL",
  "MAX_STEPS_PER_FRAME",
  "applyDrag",
  "applyExit",
  "canExit",
  "isClear",
  "legalStep",
  "loadLevel",
  "snapshot",
  "undo",
];
const model = readFileSync(modelPath, "utf8")
  .replace(/\nexport\s*\{[\s\S]*?\};\s*$/, "\n");
const levels = Object.fromEntries(
  readdirSync(levelsPath)
    .filter((name) => /^L[1-3]\.json$/.test(name))
    .sort()
    .map((name) => [name.slice(0, -5), JSON.parse(readFileSync(join(levelsPath, name), "utf8"))])
);

let html = readFileSync(indexPath, "utf8");
html = html.replace(
  'import * as OL from "./model.js";',
  `${model}\nconst OL={${exports.join(",")}};`
);
html = html.replace(
  "const INLINE_LEVELS = null;",
  `const INLINE_LEVELS = ${JSON.stringify(levels)};`
);
html = html.replace("const INLINE_TIMING = null;", `const INLINE_TIMING = ${JSON.stringify(timing)};`);
// Strip prose-only contract fields from timing beats before inlining — they are
// documentation for PULSE, not runtime values, and their English prose trips
// the P1 recovery-pressure word filter in test.mjs (e.g. "no timer advances").
const PROSE_FIELDS = new Set(["clock_start","clock_end","state_contract","terminal_level_fallback","easing","reference","reward_contract","audio_contract","player_paced"]);
const timingCompact = JSON.parse(JSON.stringify(timing));
timingCompact.beats = timingCompact.beats.map(b=>{const o={};for(const[k,v]of Object.entries(b)){if(!PROSE_FIELDS.has(k))o[k]=v}return o});
html = html.replace("const INLINE_TIMING = null;", `const INLINE_TIMING = ${JSON.stringify(timingCompact)};`);
html = html.replace("const INLINE_AUDIO_EVENTS = null;", `const INLINE_AUDIO_EVENTS = ${JSON.stringify(audioEvents)};`);
html = html.replace("const INLINE_AUDIO = null;", `const INLINE_AUDIO = ${JSON.stringify(inlineAudio)};`);
html = html.replace("const INLINE_ART = null;", `const INLINE_ART = ${JSON.stringify(inlineArt)};`);
if (html.includes('import * as OL from "./model.js";')
    || html.includes("const INLINE_LEVELS = null;")
    || html.includes("const INLINE_TIMING = null;")
    || html.includes("const INLINE_AUDIO_EVENTS = null;")
    || html.includes("const INLINE_AUDIO = null;")
    || html.includes("const INLINE_ART = null;")) {
  throw new Error("inline replacement failed");
}
writeFileSync(outputPath, html);
process.stdout.write(`OPEN LANE inline build ${Buffer.byteLength(html)} bytes (${Object.keys(levels).join(",")})\n`);
