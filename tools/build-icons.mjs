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
const LU = path.join(root, "node_modules/lucide-static/icons");

// Interface icons (Lucide: a real 24×24 stroke system, not emoji). Keyed by what
// the control *does*, so app.js and index.html reference them by meaning.
const UI_ICONS = {
  brand: "scan-search",            // a lens frame with a magnifier: "price lens"
  refresh: "refresh-cw",
  search: "search",
  import: "clipboard-paste",
  preset: "bot",                   // the preset is a heavy *agent* workload
  share: "link",
  reset: "rotate-ccw",
  all: "layout-grid",              // the "All providers" chip
  star: "star",
  plus: "plus",
  check: "check",
  close: "x",
  arrow: "arrow-right",
  more: "chevron-down",
  less: "chevron-up",
  enter: "corner-down-left",       // ⏎ on the parse button
  alert: "triangle-alert",
  dashCheapest: "circle-dollar-sign",
  dashSpread: "arrow-left-right",
  dashCache: "database",
  dashModels: "layers"
};

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

// Lucide icons are stroke-based (fill="none" stroke="currentColor"). Keep those
// presentation attributes so the mark inherits currentColor and matches the
// provider marks' weight. Stripped of the license comment and the class attr.
function toUiSymbol(alias, lucideName) {
  const svg = readFileSync(path.join(LU, lucideName + ".svg"), "utf8");
  const open = svg.match(/<svg\b([^>]*)>/);
  if (!open) throw new Error(`no <svg> for lucide icon ${lucideName}`);
  const inner0 = svg.indexOf(">", open.index) + 1;
  const inner = svg.slice(inner0, svg.lastIndexOf("</svg>"));
  const attrs = open[1];
  const pick = (n) => {
    const m = attrs.match(new RegExp(`${n}\\s*=\\s*"([^"]*)"`));
    return m ? `${n}="${m[1]}"` : "";
  };
  const viewBox = pick("viewBox");
  if (!viewBox) throw new Error(`no viewBox in lucide icon ${lucideName}`);
  const parts = [viewBox, pick("fill") || 'fill="none"', pick("stroke") || 'stroke="currentColor"',
    pick("stroke-width"), pick("stroke-linecap"), pick("stroke-linejoin")].filter(Boolean).join(" ");
  const body = inner.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
  return `<symbol id="ui-${alias}" ${parts}>${body}</symbol>`;
}

async function providerSlugs() {
  // Always cover the committed snapshot's providers — the offline page and
  // test/site.test.js need every one of them — and add whatever the live
  // catalog has gained since, so the sprite is a superset of both and a
  // rebuild never drops a provider the snapshot still lists.
  const w = {};
  new Function("window", readFileSync(path.join(root, "snapshot.js"), "utf8"))(w);
  const slugs = new Set(w.OR_SNAPSHOT.data.map(m => m.id.split("/")[0].replace(/^~/, "")));
  let source = "snapshot";
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    for (const m of j.data) slugs.add(m.id.split("/")[0].replace(/^~/, ""));
    source = "snapshot + live";
  } catch (e) {
    console.warn(`live catalog unavailable (${e.message}); building from the snapshot alone`);
  }
  return { slugs: [...slugs], source };
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

// Build the interface sprite. Every entry must exist in lucide-static — a typo
// here fails the build rather than shipping a blank glyph.
const uiSymbols = {};
for (const [name, lucideName] of Object.entries(UI_ICONS)) {
  uiSymbols[name] = toUiSymbol(name, lucideName);
}

// Favicon = the brand mark on the site's ink background, as a data URI so it
// needs no extra file and stays inside the CSP (img-src data:). It is pasted
// into index.html's <link rel="icon"> by hand, so it is printed, not shipped.
const brandPaths = uiSymbols.brand.replace(/^<symbol[^>]*>/, "").replace(/<\/symbol>$/, "");
const FAVICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0a09"/><g transform="translate(4 4)" fill="none" stroke="#f0c75e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${brandPaths}</g></svg>`
);

const out = `// GENERATED by tools/build-icons.mjs — do not edit by hand.
// Two inline SVG sprites in one file:
//   SYMBOLS  provider brand marks (monochrome, inherit currentColor)
//   UI       interface icons from lucide-static (stroke system, currentColor)
// Source catalog: ${source}. ${covered}/${slugs.length} providers have a logo;
// the rest render as a letter monogram in app.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PriceLensIcons = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // provider symbol id -> <symbol> markup
  var SYMBOLS = {};
${[...symbols.keys()].sort().map(id => `  SYMBOLS[${JSON.stringify(id)}] = ${JSON.stringify(symbols.get(id))};`).join("\n")}

  // provider slug (as it appears in a model id) -> SYMBOLS key
  var SLUG_TO_ID = ${JSON.stringify(slugToId, null, 2)};

  // interface icon name -> <symbol> markup (referenced as <use href="#ui-NAME">)
  var UI = {};
${Object.keys(uiSymbols).sort().map(name => `  UI[${JSON.stringify(name)}] = ${JSON.stringify(uiSymbols[name])};`).join("\n")}

  // Inject both sprites once into the document (aria-hidden, zero-size) so any
  // <use href="#pl-…"> or <use href="#ui-…"> resolves. Safe to call repeatedly.
  var injected = false;
  function inject() {
    if (injected || typeof document === "undefined" || !document.body) return;
    injected = true;
    var all = Object.keys(SYMBOLS).map(function (k) { return SYMBOLS[k]; })
      .concat(Object.keys(UI).map(function (k) { return UI[k]; }));
    var wrap = document.createElement("div");
    wrap.setAttribute("aria-hidden", "true");
    wrap.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
    wrap.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + all.join("") + "</svg>";
    document.body.insertBefore(wrap, document.body.firstChild);
  }
  // Self-inject as soon as the script runs in a browser, before the rest of the
  // page paints, so static header glyphs never flash empty.
  try { inject(); } catch (e) {}

  return { SYMBOLS: SYMBOLS, SLUG_TO_ID: SLUG_TO_ID, UI: UI, inject: inject };
});
`;

writeFileSync(path.join(root, "icons.js"), out);
console.log(`icons.js: ${symbols.size} symbols covering ${covered}/${slugs.length} providers (${source}).`);
console.log(`monogram fallback for: ${monogram.join(", ")}`);
console.log(`favicon data URI for index.html <link rel="icon">:\n${FAVICON}`);
