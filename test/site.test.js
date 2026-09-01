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

test("index.html loads engine → snapshot → app with one shared ?v= version", () => {
  const html = read("index.html");
  const versions = [...html.matchAll(/\?v=([\w.-]+)/g)].map(m => m[1]);
  assert.equal(versions.length, 4, "expected style.css + 3 scripts to be versioned");
  assert.equal(new Set(versions).size, 1, `mixed cache-bust versions: ${versions.join(", ")}`);
  const order = [...html.matchAll(/<script src="([\w.-]+)\?v=/g)].map(m => m[1]);
  assert.deepEqual(order, ["engine.js", "snapshot.js", "app.js"]);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /connect-src https:\/\/openrouter\.ai/);
});

test("app.js only uses engine exports that exist", () => {
  const src = read("app.js");
  const m = src.match(/const \{([^}]+)\} = window\.PriceLens;/);
  assert.ok(m, "app.js must destructure window.PriceLens");
  const wanted = m[1].split(",").map(s => s.trim()).filter(Boolean);
  for (const name of wanted) assert.equal(typeof E[name], "function", `engine.js does not export ${name}`);
});
