#!/usr/bin/env node
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
const audioEvents = JSON.parse(readFileSync(join(feelRoot, "event_map.json"), "utf8"));
const inlineAudio = Object.fromEntries(
  audioEvents.events.map((event) => [
    event.id,
    `data:audio/mpeg;base64,${readFileSync(join(root, "audio", event.file)).toString("base64")}`,
  ])
);
const artFiles = {
  background: "background.webp",
  "tile-a": "tile-a.webp",
  "tile-b": "tile-b.webp",
  "frame-corner": "frame-corner.webp",
  "frame-h": "frame-h.webp",
  "frame-v": "frame-v.webp",
  amber: "amber.webp",
  teal: "teal.webp",
  violet: "violet.webp",
  lime: "lime.webp",
};
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
