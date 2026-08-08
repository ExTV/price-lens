#!/usr/bin/env node
// Regenerates snapshot.js — the offline fallback catalog served when the live
// OpenRouter fetch fails. Applies the same filters as pick() in app.js so the
// offline catalog matches the live one: text→text only, no :free tiers, and no
// meta-routers (whose "-1" rates can't be costed).
//
//   node tools/build-snapshot.mjs
//
// Keep this in sync with pick()/isTextModel()/isFreeTier()/isUncostable().

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API = "https://openrouter.ai/api/v1/models";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "snapshot.js");

const FREE_RX = /(^|[^a-z])free([^a-z]|$)/i;
const rate = v => { const n = parseFloat(v); return isFinite(n) && n >= 0 ? n : NaN; };

const isText = m => {
  const o = m.architecture && m.architecture.output_modalities;
  return Array.isArray(o) ? o.length === 1 && o[0] === "text" : true;
};
const isFree = m => FREE_RX.test(m.id || "") || FREE_RX.test(m.name || "");
const isUncostable = m => {
  const p = m.pricing || {};
  return !isFinite(rate(p.prompt)) || !isFinite(rate(p.completion));
};

const res = await fetch(API, { headers: { Accept: "application/json" } });
if (!res.ok) throw new Error(`${API} → HTTP ${res.status}`);
const { data } = await res.json();
if (!Array.isArray(data) || !data.length) throw new Error("empty catalog");

const kept = data
  .filter(m => isText(m) && !isFree(m) && !isUncostable(m))
  .map(({ id, name, context_length, pricing, architecture }) => ({
    id, name, context_length, pricing,
    architecture: {
      input_modalities: (architecture && architecture.input_modalities) || ["text"],
      output_modalities: (architecture && architecture.output_modalities) || ["text"]
    }
  }))
  .sort((a, b) => a.id.localeCompare(b.id));   // stable order → readable diffs

const generated = new Date().toISOString().slice(0, 10);
writeFileSync(OUT,
  "// Auto-generated fallback snapshot of OpenRouter pricing (all chat-completion models).\n" +
  "// Live fetch from https://openrouter.ai/api/v1/models is primary; this is used only if that request fails.\n" +
  "// Regenerate with: node tools/build-snapshot.mjs\n" +
  `window.OR_SNAPSHOT = ${JSON.stringify({ generated, data: kept })};\n`);

console.log(`snapshot.js → ${kept.length} models (from ${data.length} live), generated ${generated}`);
