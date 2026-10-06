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
    // 8.2 * 1e6 is 8199999.999… in binary floating point — token counts are integers
    return isFinite(n) && n >= 0 ? Math.round(n * mult) : 0;
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

  // Cost-bar width in px. Monthly costs span four orders of magnitude ($0.86 to
  // $13,800 on the sample usage), so a linear bar collapsed 289 of 304 rows to
  // the 2px minimum and read as a stray tick under every price. Log scale
  // between the cheapest and priciest visible model instead, 6px floor so the
  // cheapest still shows.
  function costBarWidth(total, lo, hi) {
    if (!isFinite(total) || total <= 0 || !isFinite(lo) || !isFinite(hi) || lo <= 0) return 0;
    if (hi <= lo) return 44;
    const t = Math.min(1, Math.max(0, (Math.log(total) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))));
    return Math.round(6 + t * 82);
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

  /* ---- usage import parsers ------------------------------------------------ */
  // A reporting window, e.g. "Hermes Insights — Last 7 days" / "Last 24 hours" /
  // "Last month". Returns days, or null when no window line is present.
  function detectWindowDays(text) {
    const w = String(text).match(/last\s+(\d+(?:\.\d+)?)?\s*(hour|day|week|month)/i);
    if (!w) return null;
    const n = w[1] == null ? 1 : parseFloat(w[1]), u = w[2].toLowerCase();
    return u === "hour" ? n / 24 : u === "week" ? n * 7 : u === "month" ? n * 30 : n;
  }

  /* ---- Hermes Insights parser ---------------------------------------------- */
  // Reads the "Tokens: <total> (in: <in> / out: <out>)" line from a pasted Insights block.
  function parseInsights(text) {
    text = String(text || "");
    const grab = re => { const m = text.match(re); return m ? parseNum(m[1]) : null; };
    return {
      // The total must allow decimals AND a k/m/b suffix: "Tokens: 8.2m" is eight
      // million. Excluding the "." made every abbreviated block parse as a single
      // digit; omitting the suffix made it parse as 8.
      total: grab(/tokens?:\s*([\d.,\s]+?[kmb]?)\s*\(/i) ?? grab(/tokens?:\s*([\d.,]+\s*[kmb]?)/i),
      inp:   grab(/\bin:\s*([\d.,]+\s*[kmb]?)/i),
      out:   grab(/\bout:\s*([\d.,]+\s*[kmb]?)/i),
      windowDays: detectWindowDays(text)
    };
  }

  /* ---- OpenClaw parser ----------------------------------------------------- */
  // /status ("🧮 Tokens" + "🗄️ Cache" lines), /usage cost footers ("↕️ in/out"),
  // and usage.cost JSON. Returns null when nothing recognisable is present.
  function parseOpenClaw(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;

    if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        const j = JSON.parse(raw);
        const totals = (j && (j.totals || j)) || {};
        if (typeof totals.input === "number") {
          return {
            source: "openclaw-json",
            input: totals.input,
            output: totals.output ?? 0,
            cache_read: totals.cacheRead ?? 0,
            cache_write: totals.cacheWrite ?? 0,
            windowDays: detectWindowDays(raw) ?? (typeof j.days === "number" ? j.days : null)
          };
        }
      } catch { /* not JSON after all — fall through to the line parsers */ }
    }

    let inp = null, out = null, cache_read = 0, cache_write = 0;

    const tokM = raw.match(/🧮\s*Tokens:\s*([^\n]+)/i)
      ?? raw.match(/tokens:\s*([\d.,]+\s*[kmb]?\s*in\s*\/\s*[\d.,]+\s*[kmb]?\s*out)/i);
    if (tokM) {
      const pair = tokM[1].match(/([\d.,]+\s*[kmb]?)\s*in\s*\/\s*([\d.,]+\s*[kmb]?)\s*out/i);
      if (pair) { inp = parseNum(pair[1]); out = parseNum(pair[2]); }
    }

    // "🗄️ Cache: 91% hit · 84m cached, 9m new" — cached reads and fresh writes
    const cacheM = raw.match(/🗄[️]?\s*Cache:\s*(\d+)%\s*hit\s*[·•]\s*([\d.,]+\s*[kmb]?)\s*cached,\s*([\d.,]+\s*[kmb]?)\s*new/i);
    if (cacheM) {
      cache_read = parseNum(cacheM[2]);
      cache_write = parseNum(cacheM[3]);
    }

    if (inp == null) {                                  // /usage full footer: "↕️ 8.2m/2.1m"
      const footM = raw.match(/↕️?\s*([\d.,]+\s*[kmb]?)\s*\/\s*([\d.,]+\s*[kmb]?)/);
      if (footM) { inp = parseNum(footM[1]); out = parseNum(footM[2]); }
    }

    const field = names => {
      for (const n of names) {
        const m = raw.match(new RegExp(`["']?${n}["']?\\s*[:=]\\s*([\\d.,]+)`, "i"));
        if (m) return parseNum(m[1]);
      }
      return null;
    };
    if (inp == null) inp = field(["input", "inputTokens", "input_tokens", "prompt"]);
    if (out == null) out = field(["output", "outputTokens", "output_tokens", "completion"]);
    if (!cache_read) { const v = field(["cacheRead", "cache_read", "cached"]); if (v) cache_read = v; }
    if (!cache_write) { const v = field(["cacheWrite", "cache_write"]); if (v) cache_write = v; }

    if (inp == null && out == null && !cache_read && !cache_write) return null;
    return {
      source: "openclaw",
      input: inp ?? 0, output: out ?? 0,
      cache_read, cache_write,
      windowDays: detectWindowDays(raw)
    };
  }

  // Pick a parser for a pasted block. "openclaw"/"hermes" force one shape; "auto"
  // tries OpenClaw first because its output carries the cache split, which Hermes
  // Insights never does.
  function parseUsage(text, src) {
    const fromInsights = () => {
      const h = parseInsights(text);
      if (h.total == null && h.inp == null && h.out == null) return null;
      const knownSplit = h.inp != null && h.out != null;
      return {
        source: "hermes",
        input: knownSplit ? h.inp : (h.total != null ? Math.max(0, h.total - (h.out ?? 0)) : (h.inp ?? 0)),
        output: h.out ?? 0,
        cache_read: knownSplit ? Math.max(0, (h.total ?? 0) - h.inp - h.out) : 0,
        cache_write: 0,
        windowDays: h.windowDays,
        knownSplit
      };
    };
    if (src === "hermes") return fromInsights();
    const oc = parseOpenClaw(text);
    if (oc) return { ...oc, knownSplit: (oc.input || oc.output) > 0 || oc.cache_read > 0 };
    return src === "openclaw" ? null : fromInsights();
  }

  return {
    fmt, esc, money, perM, ctxFmt, parseNum,
    rateOf, cost, tierOf, costBarWidth,
    providerOf, isTextModel, hasVision, isFreeTier, isRouter, isBatchVariant, isUncostable, pick,
    versionOf, cmpVersion,
    detectWindowDays, parseInsights, parseOpenClaw, parseUsage
  };
});
