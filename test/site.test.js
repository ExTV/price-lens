"use strict";
// Consistency checks across the static site: the offline snapshot must be
// exactly what pick() would keep, and index.html must load the scripts in the
// right order with one cache-bust version across every asset.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const E = require("../engine.js");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

function loadSnapshot() {
  const window = {};
  new Function("window", read("snapshot.js"))(window);
  return window.OR_SNAPSHOT;
}

test("snapshot.js is a filtered, priced catalog that pick() leaves unchanged", () => {
  const snap = loadSnapshot();
  assert.match(snap.generated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(snap.data.length > 200, `only ${snap.data.length} models`);
  assert.deepEqual(E.pick(snap.data), snap.data, "snapshot contains entries the live page would drop");
  for (const m of snap.data) {
    assert.ok(Number.isFinite(E.cost(m, { input: 1, output: 1, cache_read: 1, cache_write: 1 }).total), m.id);
    assert.ok(!m.id.startsWith("~") && !/:batch$/.test(m.id) && !/latest/i.test(m.id), m.id);
  }
  const ids = snap.data.map(m => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)), "snapshot must be sorted by id");
  assert.equal(new Set(ids).size, ids.length, "duplicate ids in snapshot");
});

test("index.html loads engine → snapshot → icons → app with one shared ?v= version", () => {
  const html = read("index.html");
  const versions = [...html.matchAll(/\?v=([\w.-]+)/g)].map(m => m[1]);
  assert.equal(versions.length, 5, "expected style.css + 4 scripts to be versioned");
  assert.equal(new Set(versions).size, 1, `mixed cache-bust versions: ${versions.join(", ")}`);
  const order = [...html.matchAll(/<script src="([\w.-]+)\?v=/g)].map(m => m[1]);
  assert.deepEqual(order, ["engine.js", "snapshot.js", "icons.js", "app.js"]);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /connect-src https:\/\/openrouter\.ai/);
});

// icons.js is generated, so guard the two ways it can silently rot: a stale
// build that no longer covers the committed snapshot, and markup that would
// break when every symbol is concatenated into one sprite.
test("icons.js covers every provider in the snapshot and is sprite-safe", () => {
  const I = require("../icons.js");
  const snap = loadSnapshot();
  const slugs = new Set(snap.data.map(m => m.id.split("/")[0].replace(/^~/, "")));
  for (const slug of slugs) {
    const id = I.SLUG_TO_ID[slug];
    if (!id) continue;                       // monogram fallback is legitimate
    assert.ok(I.SYMBOLS[id], `icons.js maps ${slug} to ${id} but has no symbol`);
  }
  // every provider either has a logo or is a known monogram-only lab
  const monogramOnly = new Set(["anthracite-org", "apodex", "gryphe", "inclusionai",
    "mancer", "nex-agi", "prism-ml", "sao10k", "stealth", "thedrummer",
    "thinkingmachines", "typesafe", "unbiased", "undi95", "writer"]);
  for (const slug of slugs) {
    assert.ok(I.SLUG_TO_ID[slug] || monogramOnly.has(slug),
      `${slug} has neither a logo nor a monogram allowance — rebuild icons.js`);
  }

  const ids = Object.keys(I.SYMBOLS);
  assert.ok(ids.length >= 40, `only ${ids.length} symbols — icon pack coverage regressed`);
  const symbolIds = new Set();
  for (const key of ids) {
    const s = I.SYMBOLS[key];
    assert.ok(s.startsWith("<symbol ") && s.endsWith("</symbol>"), `${key} is not a symbol`);
    assert.match(s, /viewBox="[^"]+"/, `${key} has no viewBox`);
    assert.ok(/fill="currentColor"/.test(s), `${key} is not monochrome`);
    assert.ok(!/<title>/.test(s), `${key} carries a <title> that would surface as a tooltip`);
    const id = (s.match(/<symbol id="([^"]+)"/) || [])[1];
    assert.equal(id, `pl-${key}`, `${key} has the wrong symbol id`);
    assert.ok(!symbolIds.has(id), `duplicate symbol id ${id}`);
    symbolIds.add(id);
    // inner ids must be unique across the whole sprite, or url(#…) refs cross-talk
    const inner = s.slice(s.indexOf(">") + 1, s.lastIndexOf("</symbol>"));
    for (const m of inner.matchAll(/\sid="([^"]+)"/g)) {
      assert.ok(m[1].startsWith(`lobe-icons-${key}`), `${key} has an un-namespaced inner id ${m[1]}`);
      assert.ok(!symbolIds.has(m[1]), `inner id collision: ${m[1]}`);
      symbolIds.add(m[1]);
    }
  }
});

test("app.js only uses engine exports that exist", () => {
  const src = read("app.js");
  const m = src.match(/const \{([^}]+)\} = window\.PriceLens;/);
  assert.ok(m, "app.js must destructure window.PriceLens");
  const wanted = m[1].split(",").map(s => s.trim()).filter(Boolean);
  for (const name of wanted) assert.equal(typeof E[name], "function", `engine.js does not export ${name}`);
});

// The UI glyph set (Lucide stroke icons) is also generated. Guard both halves:
// every icon the page asks for must exist in the sprite, and every symbol must
// be a well-formed, currentColor stroke icon that is safe to concatenate.
test("every UI icon referenced by the page exists in the sprite", () => {
  const I = require("../icons.js");
  const referenced = new Set();
  for (const f of ["index.html", "app.js"]) {
    const src = read(f);
    for (const m of src.matchAll(/#ui-([a-zA-Z0-9]+)/g)) referenced.add(m[1]);
    for (const m of src.matchAll(/uiIcon\(\s*"([a-zA-Z0-9]+)"/g)) referenced.add(m[1]);
    for (const m of src.matchAll(/uiIcon\(\s*pinned \? "(\w+)" : "(\w+)"/g)) { referenced.add(m[1]); referenced.add(m[2]); }
  }
  assert.ok(referenced.size >= 12, `only found ${referenced.size} UI refs — parser regressed`);
  for (const name of referenced) {
    assert.ok(I.UI[name], `page references #ui-${name} but icons.js has no such icon — rebuild icons.js`);
  }
});

test("icons.js UI symbols are well-formed stroke icons and sprite-safe", () => {
  const I = require("../icons.js");
  const names = Object.keys(I.UI);
  assert.ok(names.length >= 20, `only ${names.length} UI icons — UI set regressed`);
  const symbolIds = new Set();
  for (const name of names) {
    const s = I.UI[name];
    assert.ok(s.startsWith("<symbol ") && s.endsWith("</symbol>"), `${name} is not a symbol`);
    assert.match(s, /viewBox="[^"]+"/, `${name} has no viewBox`);
    assert.ok(/stroke="currentColor"/.test(s), `${name} is not a currentColor stroke icon`);
    assert.ok(/fill="none"/.test(s), `${name} is not fill:none — Lucide stroke set`);
    assert.ok(!/<!--/.test(s), `${name} carries a comment that would bloat the sprite`);
    const id = (s.match(/<symbol id="([^"]+)"/) || [])[1];
    assert.equal(id, `ui-${name}`, `${name} has the wrong symbol id`);
    assert.ok(!symbolIds.has(id), `duplicate UI symbol id ${id}`);
    symbolIds.add(id);
  }
  // The favicon is a self-contained data URI usable in a <link rel="icon">.
  assert.ok(I.FAVICON && I.FAVICON.startsWith("data:image/svg+xml"), "icons.js must export a FAVICON data URI");
});

