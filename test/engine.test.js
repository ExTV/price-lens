"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const E = require("../engine.js");

const U = { input: 1_000_000, output: 100_000, cache_read: 2_000_000, cache_write: 500_000 };
const model = (pricing, extra = {}) => ({ id: "lab/model-1", name: "Lab: Model 1", pricing, ...extra });

test("rateOf: -1 and junk are unknown, 0 is a real free rate", () => {
  assert.ok(Number.isNaN(E.rateOf("-1")));
  assert.ok(Number.isNaN(E.rateOf("abc")));
  assert.ok(Number.isNaN(E.rateOf(undefined)));
  assert.equal(E.rateOf("0"), 0);
  assert.equal(E.rateOf("0.000002"), 0.000002);
});

test("cost: full cache support bills each bucket at its own rate", () => {
  const c = E.cost(model({ prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375" }), U);
  assert.equal(c.hasCache, true);
  assert.equal(c.unknown, false);
  assert.equal(c.cIn, 3);
  assert.equal(c.cOut, 1.5);
  assert.equal(c.cCr, 0.6);
  assert.equal(c.cCw, 1.875);
  assert.equal(c.total, 3 + 1.5 + 0.6 + 1.875);
});

test("cost: read rate but no write rate means writes are free (auto-caching)", () => {
  const c = E.cost(model({ prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" }), U);
  assert.equal(c.hasCache, true);
  assert.equal(c.cwR, 0);
  assert.equal(c.cCw, 0);
});

test("cost: no cache support bills reads and writes as fresh input", () => {
  const c = E.cost(model({ prompt: "0.000001", completion: "0.000002" }), U);
  assert.equal(c.hasCache, false);
  assert.equal(c.crR, 0.000001);
  assert.equal(c.cwR, 0.000001);
  assert.equal(c.total, 1 + 0.2 + 2 + 0.5);
});

test("cost: a write rate without a read rate is not cache support", () => {
  // Qwen 3.6 entries publish input_cache_write only
  const c = E.cost(model({ prompt: "0.000001", completion: "0.000002", input_cache_write: "0.00000125" }), U);
  assert.equal(c.hasCache, false);
  assert.equal(c.crR, 0.000001);
  assert.equal(c.cwR, 0.000001);
});

test("cost: a published cache-read rate of 0 is free reads, not unsupported", () => {
  const c = E.cost(model({ prompt: "0.000001", completion: "0.000002", input_cache_read: "0" }), U);
  assert.equal(c.hasCache, true);
  assert.equal(c.cCr, 0);
});

test("cost: -1 pricing is unknown and never totals", () => {
  const c = E.cost(model({ prompt: "-1", completion: "-1" }), U);
  assert.equal(c.unknown, true);
  assert.ok(Number.isNaN(c.total));
});

test("tierOf: lowest long-context threshold, or null", () => {
  assert.equal(E.tierOf(model({ prompt: "1", completion: "2" })), null);
  assert.equal(E.tierOf(model({ prompt: "1", completion: "2", overrides: [] })), null);
  const t = E.tierOf(model({ prompt: "0.000003", completion: "0.000015", overrides: [
    { min_prompt_tokens: 400000, prompt: "0.000009", completion: "0.00003" },
    { min_prompt_tokens: 200000, prompt: "0.000006", completion: "0.0000225" },
    { something_else: true }
  ] }));
  assert.deepEqual(t, { minPromptTokens: 200000, inR: 0.000006, outR: 0.0000225 });
});

test("money / perM / ctxFmt formatting", () => {
  assert.equal(E.money(NaN), "—");
  assert.equal(E.money(0), "$0");
  assert.equal(E.money(1234.5), "$1,235");
  assert.equal(E.money(12.345), "$12.35");
  assert.equal(E.money(0.05), "$0.050");
  assert.equal(E.money(0.00001234), "$0.000012");
  assert.equal(E.money(1e-9), "≈$0");
  assert.equal(E.perM(NaN), "—");
  assert.equal(E.perM(0), "$0");
  assert.equal(E.perM(0.00001), "$10.00");
  assert.equal(E.perM(0.0005), "$500");
  assert.equal(E.perM(0.0000000896), "$0.090");
  assert.equal(E.ctxFmt(1048576), "1.0M");
  assert.equal(E.ctxFmt(1000000), "1M");
  assert.equal(E.ctxFmt(200000), "200K");
  assert.equal(E.ctxFmt(512), "512");
  assert.equal(E.ctxFmt("<b>x</b>"), "—");
  assert.equal(E.ctxFmt(null), "—");
});

test("parseNum accepts separators and k/m/b suffixes", () => {
  assert.equal(E.parseNum("12,000,000"), 12_000_000);
  assert.equal(E.parseNum("12m"), 12_000_000);
  assert.equal(E.parseNum("500K"), 500_000);
  assert.equal(E.parseNum("1.2b"), 1.2e9);
  assert.equal(E.parseNum(" 7 "), 7);
  assert.equal(E.parseNum(""), 0);
  assert.equal(E.parseNum("abc"), 0);
  assert.equal(E.parseNum("-5"), 5);   // sign stripped, never negative
});

test("esc neutralises markup", () => {
  assert.equal(E.esc(`<img src=x onerror="alert('1')">&`), "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;");
  assert.equal(E.esc(null), "");
  assert.equal(E.esc(42), "42");
});

test("parseInsights reads the Tokens line and the reporting window", () => {
  const r = E.parseInsights("Hermes Insights — Last 7 days\nSessions: 42\nTokens: 331,234,491 (in: 56,828,463 / out: 1,669,359)\n");
  assert.deepEqual(r, { total: 331_234_491, inp: 56_828_463, out: 1_669_359, windowDays: 7 });
  assert.equal(E.parseInsights("Last 24 hours\nTokens: 100").windowDays, 1);
  assert.equal(E.parseInsights("Last 2 weeks\nTokens: 100").windowDays, 14);
  assert.equal(E.parseInsights("Last month\nTokens: 100").windowDays, 30);
  const noSplit = E.parseInsights("Tokens: 1,000");
  assert.deepEqual(noSplit, { total: 1000, inp: null, out: null, windowDays: null });
  assert.deepEqual(E.parseInsights("nothing here"), { total: null, inp: null, out: null, windowDays: null });
});

test("providerOf strips the alias tilde", () => {
  assert.equal(E.providerOf("anthropic/claude-fable-5.1"), "anthropic");
  assert.equal(E.providerOf("~openai/gpt-latest"), "openai");
  assert.equal(E.providerOf(""), "");
});

test("versionOf / cmpVersion prefer the newest release of a family", () => {
  assert.deepEqual(E.versionOf("anthropic/claude-fable-5.1"), [5, 1]);
  assert.deepEqual(E.versionOf("openai/gpt-5.6-sol"), [5, 6]);
  assert.deepEqual(E.versionOf("google/gemini-3.1-pro-preview"), [3, 1]);
  assert.deepEqual(E.versionOf("lab/model"), []);
  assert.ok(E.cmpVersion("a/x-5.1", "a/x-5") > 0);
  assert.ok(E.cmpVersion("a/x-5.10", "a/x-5.9") > 0);
  assert.equal(E.cmpVersion("a/x-3", "a/x-3.0"), 0);
});

const REGULAR = {
  id: "lab/model-1", name: "Lab: Model 1", context_length: 128000, created: 1,
  pricing: { prompt: "0.000001", completion: "0.000002" },
  architecture: { tokenizer: "Other", input_modalities: ["text", "image"], output_modalities: ["text"] },
  description: "junk that must not survive pick()"
};
const with_ = (over) => ({ ...REGULAR, ...over });

test("pick keeps regular text models and slims them", () => {
  const out = E.pick([REGULAR]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    id: "lab/model-1", name: "Lab: Model 1", context_length: 128000,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }
  });
  assert.ok(E.hasVision(out[0]));
  // missing modalities → assumed text→text
  assert.equal(E.pick([with_({ architecture: undefined })]).length, 1);
});

test("pick drops free tiers, routers, aliases, batch variants, media models and -1 pricing", () => {
  const dropped = [
    with_({ id: "lab/model-1:free" }),
    with_({ id: "lab/freedom-2", name: "Lab: Model (free)" }),
    with_({ id: "~anthropic/claude-fable-latest", architecture: { tokenizer: "Router", output_modalities: ["text"] } }),
    with_({ id: "vendor/x-latest" }),                                                  // rolling alias by id alone
    with_({ id: "openai/gpt-chat-latest" }),
    with_({ id: "openrouter/fusion", pricing: { prompt: "-1", completion: "-1" } }),
    with_({ id: "openrouter/free", pricing: { prompt: "0", completion: "0" } }),
    with_({ id: "openrouter/something-priced" }),                                      // provider rule, even if priced
    with_({ id: "lab/model-1:batch" }),
    with_({ id: "openai/gpt-5-image", architecture: { output_modalities: ["text", "image"] } }),
    with_({ id: "lab/audio", architecture: { output_modalities: ["audio"] } }),
    with_({ id: "lab/no-price", pricing: { prompt: "-1", completion: "0.000002" } }),
    with_({ id: "lab/no-price-2", pricing: {} }),
    { name: "no id" },
    null
  ];
  assert.deepEqual(E.pick(dropped), []);
  // and "freedom"/"freeform" in a name are not the free tier
  assert.equal(E.pick([with_({ id: "lab/freedom", name: "Lab: Freeform Writer" })]).length, 1);
  // the tokenizer rule catches a router even under an ordinary-looking id
  assert.equal(E.isRouter(with_({ id: "lab/plain", architecture: { tokenizer: "Router" } })), true);
});
