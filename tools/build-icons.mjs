#!/usr/bin/env node
// Builds icons.js — an inline SVG sprite of provider brand marks, so the model
// table shows real company logos instead of coloured dots.
//
// Sources (both vendored as devDependencies, neither is a runtime dep):
//   @lobehub/icons-static-svg  — purpose-built AI/LLM brand marks (base file is
//                                a monochrome `currentColor` glyph: exactly what
//                                we want, so the logo inherits the site palette).
//   simple-icons               — fills a couple of gaps LobeHub doesn't cover.
//
// Providers with no official vector logo in either pack get no symbol; app.js
// draws a letter monogram for them at runtime (see PROV_LABEL initials).
//
// Run:  node tools/build-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LH = path.join(root, "node_modules/@lobehub/icons-static-svg/icons");
const SI = path.join(root, "node_modules/simple-icons/icons");

// Provider slug → icon base name, where the slug isn't itself the icon name.
// `null` means "no official logo exists — fall back to a monogram".
const ALIAS = {
  "meta-llama": "metaai",        // Meta's AI/Llama mark, distinct from the Meta wordmark
  "ibm-granite": "ibm",
  "amazon": "aws",               // OpenRouter's `amazon` publishes Amazon Nova (AWS)
  "bytedance-seed": "bytedance", // ByteDance Seed shares the ByteDance mark
  "cognitivecomputations": "phind",
  "inference-net": "inference",
  "aion-labs": "aionlabs",
  "dots-studio": "dotsstudio",
  "arcee-ai": "arcee",
  "x-ai": "xai",
  "z-ai": "zai",
  "mistralai": "mistral",
  "moonshotai": "moonshot",
  "rekaai": "reka",
  // no official vector logo in either pack — monogram at runtime:
  "anthracite-org": null, "apodex": null, "gryphe": null, "inclusionai": null,
  "launcher": null, "mancer": null, "nex-agi": null, "prism-ml": null,
  "sao10k": null, "stealth": null, "thedrummer": null, "thinkingmachines": null,
  "typesafe": null, "unbiased": null, "undi95": null, "writer": null,
};

function readSvg(dir, base) {
  const p = path.join(dir, base + ".svg");
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

// Candidate base names to try for a slug, most literal first.
function candidates(slug) {
  return [slug, slug.replace(/-/g, ""), slug.replace(/-org$/, ""), slug.replace(/-labs$/, "")]
    .filter((v, i, a) => v && a.indexOf(v) === i);
}

// Resolve a provider slug to { id, source } using the alias table then a
// normalised lookup across both packs. Returns null for a monogram-only slug.
function resolve(slug) {
  if (slug in ALIAS) {
    const base = ALIAS[slug];
    if (base === null) return null;
    const svg = readSvg(LH, base) || readSvg(SI, base);
    return svg ? { id: base, svg } : null;
  }
  for (const c of candidates(slug)) {
    const svg = readSvg(LH, c) || readSvg(SI, c);
    if (svg) return { id: c, svg };
  }
  return null;
}

// Turn a standalone <svg>…</svg> into a <symbol> carrying its viewBox and any
// fill / fill-rule / stroke presentation attributes, so the mark renders in the
// consuming element's currentColor. <title> is dropped — the row already names
// the model, and a title inside a <symbol> would surface as a tooltip.
function toSymbol(id, svg) {
  const open = svg.match(/<svg\b([^>]*)>/);
  const inner0 = svg.indexOf(">", open.index) + 1;
  const inner = svg.slice(inner0, svg.lastIndexOf("</svg>"));
  const attrs = open[1];
  const pick = (name) => {
    const m = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
    return m ? `${name}="${m[1]}"` : "";
  };
  const viewBox = pick("viewBox");
  if (!viewBox) throw new Error(`no viewBox in icon for ${id}`);
  const fill = pick("fill") || 'fill="currentColor"';
  const extra = [pick("fill-rule"), pick("stroke"), pick("stroke-width"), pick("stroke-linecap"), pick("stroke-linejoin")]
    .filter(Boolean).join(" ");
  const body = inner.replace(/<title>[\s\S]*?<\/title>/g, "").trim();
  return `<symbol id="pl-${id}" ${viewBox} ${fill} ${extra}>${body}</symbol>`;
}

async function providerSlugs() {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return { slugs: [...new Set(j.data.map(m => m.id.split("/")[0]).map(s => s.replace(/^~/, "")))], source: "live" };
  } catch (e) {
    // Offline / CI: fall back to the committed snapshot so the build is reproducible.
    const w = {};
    new Function("window", readFileSync(path.join(root, "snapshot.js"), "utf8"))(w);
    return { slugs: [...new Set(w.OR_SNAPSHOT.data.map(m => m.id.split("/")[0].replace(/^~/, "")))], source: "snapshot (" + e.message + ")" };
  }
}

const { slugs, source } = await providerSlugs();
const symbols = new Map();   // id -> symbol markup
const slugToId = {};         // provider slug -> symbol id

for (const slug of slugs.sort((a, b) => a.localeCompare(b))) {
  const hit = resolve(slug);
  if (!hit) continue;                       // monogram fallback at runtime
  if (!symbols.has(hit.id)) symbols.set(hit.id, toSymbol(hit.id, hit.svg));
  slugToId[slug] = hit.id;
}

const covered = Object.keys(slugToId).length;
const monogram = slugs.filter(s => !(s in slugToId)).sort();

const out = `// GENERATED by tools/build-icons.mjs — do not edit by hand.
// Provider brand marks (monochrome, inherit currentColor) as an inline sprite.
// Source catalog: ${source}. ${covered}/${slugs.length} providers have a logo;
// the rest render as a letter monogram in app.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PriceLensIcons = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // keyed by symbol id; each value is a complete <symbol> element.
  var SYMBOLS = {};
${[...symbols.keys()].sort().map(id => `  SYMBOLS[${JSON.stringify(id)}] = ${JSON.stringify(symbols.get(id))};`).join("\n")}

  // provider slug (as it appears in a model id) -> SYMBOLS key
  var SLUG_TO_ID = ${JSON.stringify(slugToId, null, 2)};

  return { SYMBOLS: SYMBOLS, SLUG_TO_ID: SLUG_TO_ID };
});
`;

writeFileSync(path.join(root, "icons.js"), out);
console.log(`icons.js: ${symbols.size} symbols covering ${covered}/${slugs.length} providers (${source}).`);
console.log(`monogram fallback for: ${monogram.join(", ")}`);
