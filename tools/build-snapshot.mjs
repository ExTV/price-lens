#!/usr/bin/env node
// Regenerates snapshot.js — the offline fallback catalog served when the live
// OpenRouter fetch fails. Uses the same pick() as the page (engine.js), so the
// offline catalog can't drift from the live one: text→text only, no :free
// tiers, no :batch variants, no OpenRouter routers / rolling aliases.
//
//   node tools/build-snapshot.mjs        (or: npm run snapshot)
//
// Leaves snapshot.js untouched when the model data is unchanged, so a scheduled
// run only commits when something actually moved.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pick } = require("../engine.js");

const API = "https://openrouter.ai/api/v1/models";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "snapshot.js");

const res = await fetch(API, { headers: { Accept: "application/json" } });
if (!res.ok) throw new Error(`${API} → HTTP ${res.status}`);
const { data } = await res.json();
if (!Array.isArray(data) || !data.length) throw new Error("empty catalog");

const kept = pick(data).sort((a, b) => a.id.localeCompare(b.id));   // stable order → readable diffs
if (!kept.length) throw new Error("pick() kept nothing — refusing to write an empty snapshot");

let prev = null;
try {
  const m = readFileSync(OUT, "utf8").match(/window\.OR_SNAPSHOT = (\{[\s\S]*\});\s*$/);
  prev = m && JSON.parse(m[1]);
} catch { /* no usable previous snapshot — write a fresh one */ }

if (prev && JSON.stringify(prev.data) === JSON.stringify(kept)) {
  console.log(`snapshot.js unchanged (${kept.length} models, generated ${prev.generated})`);
  process.exit(0);
}

const generated = new Date().toISOString().slice(0, 10);
writeFileSync(OUT,
  "// Auto-generated fallback snapshot of OpenRouter pricing (all chat-completion models).\n" +
  "// Live fetch from https://openrouter.ai/api/v1/models is primary; this is used only if that request fails.\n" +
  "// Regenerate with: node tools/build-snapshot.mjs\n" +
  `window.OR_SNAPSHOT = ${JSON.stringify({ generated, data: kept })};\n`);

console.log(`snapshot.js → ${kept.length} models (from ${data.length} live), generated ${generated}`);
