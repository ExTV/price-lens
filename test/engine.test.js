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

test("costBarWidth is log-scaled between the visible extremes", () => {
  assert.equal(E.costBarWidth(NaN, 1, 100), 0);
  assert.equal(E.costBarWidth(0, 1, 100), 0);
  assert.equal(E.costBarWidth(10, Infinity, 0), 0);   // empty list
  assert.equal(E.costBarWidth(1, 1, 100), 6);
  assert.equal(E.costBarWidth(100, 1, 100), 88);
  assert.equal(E.costBarWidth(10, 1, 100), 47);        // halfway in log space
  assert.equal(E.costBarWidth(5, 5, 5), 44);           // single value
  assert.equal(E.costBarWidth(1000, 1, 100), 88);      // clamped
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

test("parseInsights reads abbreviated totals — 8.2m is eight million, not eight", () => {
  assert.equal(E.parseInsights("Tokens: 8.2m (in: 2.1m / out: 900k)").total, 8_200_000);
  assert.equal(E.parseInsights("Tokens: 8.2m (in: 2.1m / out: 900k)").inp, 2_100_000);
  assert.equal(E.parseInsights("Tokens: 8.2m (in: 2.1m / out: 900k)").out, 900_000);
  // a total with no parentheses still parses
  assert.equal(E.parseInsights("Tokens: 331.5m").total, 331_500_000);
});

test("parseOpenClaw reads /status lines, footers and usage.cost JSON", () => {
  const status = E.parseOpenClaw("🧮 Tokens: 8.2m in / 2.1m out\n🗄️ Cache: 91% hit · 84m cached, 9m new\nLast 7 days");
  assert.deepEqual(status, {
    source: "openclaw", input: 8_200_000, output: 2_100_000,
    cache_read: 84_000_000, cache_write: 9_000_000, windowDays: 7
  });
  // full comma-separated numbers, same shape
  assert.equal(E.parseOpenClaw("🧮 Tokens: 8,200,000 in / 2,100,000 out").input, 8_200_000);
  // /usage footer
  const foot = E.parseOpenClaw("↕️ 8.2m/2.1m · Last 7 days");
  assert.deepEqual([foot.input, foot.output, foot.windowDays], [8_200_000, 2_100_000, 7]);
  // JSON with totals
  const json = E.parseOpenClaw(JSON.stringify({ totals: { input: 5_000_000, output: 900_000, cacheRead: 40_000_000, cacheWrite: 3_000_000 }, days: 14 }));
  assert.equal(json.source, "openclaw-json");
  assert.deepEqual([json.input, json.output, json.cache_read, json.cache_write, json.windowDays],
    [5_000_000, 900_000, 40_000_000, 3_000_000, 14]);
  // nothing recognisable
  assert.equal(E.parseOpenClaw("just prose"), null);
  assert.equal(E.parseOpenClaw(""), null);
});

test("parseUsage picks a parser per source and flags a missing cache split", () => {
  const ocBlock = "🧮 Tokens: 8.2m in / 2.1m out\n🗄️ Cache: 91% hit · 84m cached, 9m new\nLast 7 days";
  const hermesBlock = "Hermes Insights — Last 7 days\nTokens: 331,234,491 (in: 56,828,463 / out: 1,669,359)";

  // forced sources do what they say
  assert.equal(E.parseUsage(ocBlock, "openclaw").source, "openclaw");
  assert.equal(E.parseUsage(hermesBlock, "hermes").source, "hermes");
  // Hermes tab on an OpenClaw block: the total parses, but there is no in/out
  // split, so it must come back flagged rather than silently mis-costed.
  const forced = E.parseUsage(ocBlock, "hermes");
  assert.equal(forced.source, "hermes");
  assert.equal(forced.knownSplit, false);
  assert.equal(forced.cache_read, 0);          // nothing is assumed cached
  assert.equal(forced.input, 8_200_000);       // …so the total bills as fresh input
  assert.equal(E.parseUsage(hermesBlock, "openclaw"), null);

  // auto prefers OpenClaw because it carries the cache split
  const auto = E.parseUsage(ocBlock, "auto");
  assert.equal(auto.source, "openclaw");
  assert.equal(auto.cache_read, 84_000_000);
  assert.equal(auto.knownSplit, true);

  // hermes total minus in/out = cached reads
  const h = E.parseUsage(hermesBlock, "hermes");
  assert.equal(h.cache_read, 331_234_491 - 56_828_463 - 1_669_359);
  assert.equal(h.knownSplit, true);

  // total with no split → everything is fresh input, and knownSplit says so
  const bare = E.parseUsage("Tokens: 1,000,000", "hermes");
  assert.deepEqual([bare.input, bare.cache_read, bare.knownSplit], [1_000_000, 0, false]);
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
