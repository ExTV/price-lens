/* =========================================================================
   Price Lens — cost engine and catalog rules (pure, no DOM)

   Loaded as a plain <script> in the browser (window.PriceLens) and required
   under Node by tools/build-snapshot.mjs and the tests. One copy of the
   filters, so the offline snapshot cannot drift from what the live page shows.
   ========================================================================= */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PriceLens = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---- formatting --------------------------------------------------------- */
  const NF = new Intl.NumberFormat("en-US");
  const fmt = n => NF.format(n);

  // everything from the API lands in innerHTML — never trust it raw
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, ch => ESC[ch]);

  function money(n) {
    if (!isFinite(n)) return "—";          // unknown / variable pricing
    if (n === 0) return "$0";
    if (n >= 1000)     return "$" + fmt(Math.round(n));
    if (n >= 1)        return "$" + n.toFixed(2);
    if (n >= 0.01)     return "$" + n.toFixed(3);
    if (n >= 0.000001) return "$" + n.toFixed(6).replace(/0+$/, "");
    return "≈$0";                          // never exponent notation in a price column
  }

  function perM(rate) {            // rate is $/token → show $/million
    if (!isFinite(rate)) return "—";
    const v = rate * 1e6;
    if (v === 0)     return "$0";
    if (v >= 100)    return "$" + v.toFixed(0);
    if (v >= 1)      return "$" + v.toFixed(2);
    if (v >= 0.001)  return "$" + v.toFixed(3);
    return "$" + v.toFixed(4);
  }

  // Coerces rather than trusting: this value comes from the API and its result is
  // interpolated into innerHTML, so it must never be able to return raw markup.
  function ctxFmt(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return "—";
    if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(Math.round(n));
  }

  // token counts: accept "12,000,000", "12m", "500k", "1.2b"
  const SUFFIX = { k: 1e3, m: 1e6, b: 1e9 };
  function parseNum(s) {
    const raw = String(s).trim().toLowerCase();
    const mult = SUFFIX[raw.slice(-1)] || 1;
    const n = parseFloat((mult > 1 ? raw.slice(0, -1) : raw).replace(/[^0-9.]/g, ""));
    return isFinite(n) && n >= 0 ? n * mult : 0;
  }

  /* ---- cost engine --------------------------------------------------------- */
  // OpenRouter reports "-1" for router models whose price depends on where the
  // request lands. That is *unknown*, not negative — treat it (and anything
  // unparseable) as NaN so it can never be costed or sorted as if it were cheap.
  function rateOf(v) {
    const n = parseFloat(v);
    return isFinite(n) && n >= 0 ? n : NaN;
  }

  function cost(m, u) {
    const p = (m && m.pricing) || {};
    const inR  = rateOf(p.prompt);
    const outR = rateOf(p.completion);
    const unknown = !isFinite(inR) || !isFinite(outR);

    const crRaw = rateOf(p.input_cache_read);
    // Models without caching omit the field entirely (→ NaN). A published rate of
    // exactly 0 means reads are free, not unsupported — don't bill those as input.
    const hasCache = isFinite(crRaw);
    const crR = hasCache ? crRaw : inR;             // no native caching → reads cost full input rate

    // A write rate only means something next to a read rate. A few catalog
    // entries (Qwen 3.6) publish input_cache_write with no input_cache_read;
    // paying to warm a cache you can never read from is not a real tier, so
    // without read support both reads and writes are just fresh input. With
    // read support but no write rate (OpenAI, DeepSeek, Gemini auto-caching)
    // writes are free.
    const cwRaw = rateOf(p.input_cache_write);
    const cwR = !hasCache ? inR : (isFinite(cwRaw) ? cwRaw : 0);

    const cIn = u.input * inR;
    const cOut = u.output * outR;
    const cCr = u.cache_read * crR;
    const cCw = u.cache_write * cwR;

    return {
      inR, outR, crR, cwR, hasCache, unknown,
      cIn, cOut, cCr, cCw,
      total: unknown ? NaN : cIn + cOut + cCr + cCw
    };
  }

  // Long-context tiers. Some models (Sonnet 4.5, Gemini 3.1 Pro, Qwen 3.6) bill a
  // higher rate once a single prompt exceeds N tokens; OpenRouter publishes it
  // as pricing.overrides[{min_prompt_tokens, prompt, completion, …}]. The
  // monthly cost here can't know how long each request was, so it is costed at
  // the base tier and the row is tagged. Returns the lowest threshold, or null.
  function tierOf(m) {
    const o = m && m.pricing && m.pricing.overrides;
    if (!Array.isArray(o)) return null;
    const tiers = o.filter(t => t && Number(t.min_prompt_tokens) > 0)
                   .sort((a, b) => Number(a.min_prompt_tokens) - Number(b.min_prompt_tokens));
    if (!tiers.length) return null;
    const t = tiers[0];
    return { minPromptTokens: Number(t.min_prompt_tokens), inR: rateOf(t.prompt), outR: rateOf(t.completion) };
  }

  /* ---- catalog rules ------------------------------------------------------- */
  const providerOf = id => String(id || "").replace(/^~/, "").split("/")[0];

  // keep only true text→text LLMs (drop image-gen / audio / other media models)
  function isTextModel(m) {
    const o = m.architecture && m.architecture.output_modalities;
    return Array.isArray(o) ? (o.length === 1 && o[0] === "text") : true;
  }
  function hasVision(m) {
    const i = m.architecture && m.architecture.input_modalities;
    return Array.isArray(i) && i.includes("image");
  }

  // Free variants are excluded from the catalog: they're rate-limited tiers whose
  // "$0" would otherwise sit at the top of every cheapest-first sort. Matches the
  // standalone word only, so "freeform"/"freedom" are untouched.
  const FREE_RX = /(^|[^a-z])free([^a-z]|$)/i;
  function isFreeTier(m) {
    return FREE_RX.test(m.id || "") || FREE_RX.test(m.name || "");
  }

  // OpenRouter-only entries that are not models you can pin: the "~vendor/x-latest"
  // rolling aliases (tokenizer "Router"), the openrouter/* meta-routers (auto,
  // fusion, pareto-code, bodybuilder, free — priced "-1" because you pay whatever
  // they pick), and vendor rolling aliases such as openai/gpt-chat-latest.
  function isRouter(m) {
    const id = String(m.id || "");
    const tok = m.architecture && m.architecture.tokenizer;
    return tok === "Router" || id.startsWith("~") || providerOf(id) === "openrouter" || /latest/i.test(id);
  }

  // ":batch" is the same model served through the asynchronous batch queue at
  // roughly half price. It is a delivery mode, not a model, and listing it
  // doubles every frontier row with a cheaper twin.
  const isBatchVariant = m => /:batch$/i.test(String(m.id || ""));

  // Nothing to cost: prompt or completion rate is missing / "-1".
  function isUncostable(m) {
    const p = (m && m.pricing) || {};
    return !isFinite(rateOf(p.prompt)) || !isFinite(rateOf(p.completion));
  }

  // "chat completions" = every priced, pinnable text→text LLM in the catalog.
  function pick(arr) {
    return arr
      .filter(m => m && typeof m.id === "string" && isTextModel(m) && !isFreeTier(m) &&
                   !isRouter(m) && !isBatchVariant(m) && !isUncostable(m))
      .map(x => ({
        id: x.id, name: x.name, context_length: x.context_length, pricing: x.pricing,
        architecture: {
          input_modalities: (x.architecture && x.architecture.input_modalities) || ["text"],
          output_modalities: (x.architecture && x.architecture.output_modalities) || ["text"]
        }
      }));
  }

  // "anthropic/claude-fable-5.1" → [5, 1]. Used to prefer the newest release of a
  // family when a pinned featured id has left the catalog.
  function versionOf(id) {
    const tail = String(id || "").split("/")[1] || String(id || "");
    const v = tail.match(/\d+(?:\.\d+)*/);
    return v ? v[0].split(".").map(Number) : [];
  }
  function cmpVersion(a, b) {
    const va = versionOf(a), vb = versionOf(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (va[i] || 0) - (vb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  /* ---- Hermes Insights parser ---------------------------------------------- */
  // Reads the "Tokens: <total> (in: <in> / out: <out>)" line from a pasted Insights block.
  function parseInsights(text) {
    text = String(text || "");
    const grab = re => { const m = text.match(re); return m ? parseNum(m[1]) : null; };
    // reporting window, e.g. "Hermes Insights — Last 7 days" / "Last 24 hours" / "Last month"
    const w = text.match(/last\s+(\d+(?:\.\d+)?)?\s*(hour|day|week|month)/i);
    let windowDays = null;
    if (w) {
      const n = w[1] == null ? 1 : parseFloat(w[1]), u = w[2].toLowerCase();
      windowDays = u === "hour" ? n / 24 : u === "week" ? n * 7 : u === "month" ? n * 30 : n;
    }
    return {
      total: grab(/tokens?:\s*([\d,\s]+?)\s*\(/i) ?? grab(/tokens?:\s*([\d,]+)/i),
      inp:   grab(/\bin:\s*([\d,]+)/i),
      out:   grab(/\bout:\s*([\d,]+)/i),
      windowDays
    };
  }

  return {
    fmt, esc, money, perM, ctxFmt, parseNum,
    rateOf, cost, tierOf,
    providerOf, isTextModel, hasVision, isFreeTier, isRouter, isBatchVariant, isUncostable, pick,
    versionOf, cmpVersion,
    parseInsights
  };
});
