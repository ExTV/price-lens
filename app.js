/* =========================================================================
   Price Lens — app logic
   Live OpenRouter pricing → cost your real monthly usage on every model.
   ========================================================================= */

"use strict";

const API = "https://openrouter.ai/api/v1/models";

// Generic sample workload so the page is alive on first load.
// Replace via the field inputs or by pasting your own Hermes Insights block.
const DEFAULTS = {
  input:       20000000,   // fresh / uncached prompt
  output:      3000000,    // completion
  cache_read:  60000000,   // re-sent cached context  (= total − in − out)
  cache_write: 0
};

// Always-shown hero trio. Matched by exact id first, then a loose fallback.
const FEATURED = [
  { ids: ["anthropic/claude-fable-5", "~anthropic/claude-fable-latest"], rx: /claude-fable/,             label: "Fable" },
  { ids: ["openai/gpt-5.5"],                                             rx: /^~?openai\/gpt-5\.5$/,      label: "GPT-5.5" },
  { ids: ["google/gemini-3.1-pro-preview-customtools"],                 rx: /gemini-3\.1-pro.*customtool/, label: "Gemini 3.1 Pro" }
];

// Known providers → display label + chip colour. Any provider not listed here
// still shows up (chips/sort are derived from the live data) with a fallback tint.
const PROV = {
  anthropic:    { label: "Anthropic",  color: "var(--anthropic)" },
  openai:       { label: "OpenAI",     color: "var(--openai)" },
  google:       { label: "Google",     color: "var(--google)" },
  qwen:         { label: "Qwen",        color: "var(--qwen)" },
  mistralai:    { label: "Mistral",    color: "#ff8205" },
  "meta-llama": { label: "Meta",       color: "#4d8bf0" },
  deepseek:     { label: "DeepSeek",   color: "#4d6bfe" },
  "x-ai":       { label: "xAI",        color: "#9aa0a6" },
  cohere:       { label: "Cohere",     color: "#ff7759" },
  microsoft:    { label: "Microsoft",  color: "#5ea0ef" },
  nvidia:       { label: "NVIDIA",     color: "#76b900" },
  "z-ai":       { label: "Z.AI",       color: "#5b78ff" },
  moonshotai:   { label: "MoonshotAI", color: "#19b3b3" },
  minimax:      { label: "MiniMax",    color: "#ff5b6a" },
  ai21:         { label: "AI21",       color: "#e35caa" },
  amazon:       { label: "Amazon",     color: "#ff9b3d" },
  nousresearch: { label: "Nous",       color: "#c0a3ff" },
  perplexity:   { label: "Perplexity", color: "#20b8cd" },
  liquid:       { label: "Liquid",     color: "#4fb0c6" },
  inception:    { label: "Inception",  color: "#7bd1c0" },
  reka:         { label: "Reka",       color: "#ff7a45" },
  baidu:        { label: "Baidu",      color: "#5566ff" },
  tencent:      { label: "Tencent",    color: "#3fb950" },
  "01-ai":      { label: "01.AI",      color: "#2dd4bf" },
  inflection:   { label: "Inflection", color: "#b08cff" },
  allenai:      { label: "Ai2",        color: "#f0529c" },
  "arcee-ai":   { label: "Arcee",      color: "#6bcf9b" },
  stepfun:      { label: "StepFun",    color: "#7c83ff" },
  thedrummer:   { label: "TheDrummer", color: "#d98c5f" },
  sao10k:       { label: "Sao10K",     color: "#caa46a" },
  agentica:     { label: "Agentica",   color: "#8bd17c" }
};

// stable fallback tint for providers we don't have a brand colour for
const FALLBACK_COLORS = ["#9c8f7a", "#7f9cb0", "#b08f9c", "#8fb09c", "#a59cb0", "#b0a88f"];
function provMeta(prov) {
  if (PROV[prov]) return PROV[prov];
  let h = 0;
  for (let i = 0; i < prov.length; i++) h = (h * 31 + prov.charCodeAt(i)) >>> 0;
  return { label: prov, color: FALLBACK_COLORS[h % FALLBACK_COLORS.length] };
}

/* ---- state --------------------------------------------------------------- */
let MODELS = [];                       // raw {id,name,context_length,pricing}
let base   = { ...DEFAULTS };          // token counts exactly as reported (per data window)
let period = { dataDays: 30, projectDays: 30 };  // reported window  →  projection target
let usage  = { ...DEFAULTS };          // base scaled to the projection window — what we actually cost
let filterProv = "all";
let query = "";
let sortMode = "cost-asc";
let openId = null;                     // expanded row

// monthly projection: scale the reported tokens from their window up/down to the target.
function periodScale() { return period.dataDays > 0 ? period.projectDays / period.dataDays : 1; }
function recalcUsage() {
  const s = periodScale();
  usage = {
    input:       Math.round(base.input * s),
    output:      Math.round(base.output * s),
    cache_read:  Math.round(base.cache_read * s),
    cache_write: Math.round(base.cache_write * s)
  };
}

/* ---- helpers ------------------------------------------------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const providerOf = id => id.replace(/^~/, "").split("/")[0];

function cleanName(m) {
  const n = m.name || m.id;
  const i = n.indexOf(": ");
  if (i > 0) {
    const head = n.slice(0, i).toLowerCase();
    if (Object.values(PROV).some(p => p.label.toLowerCase() === head)) return n.slice(i + 2);
  }
  return n;
}

const f = new Intl.NumberFormat("en-US");

// everything from the API lands in innerHTML — never trust it raw
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, ch => ESC[ch]);

function money(n) {
  if (!isFinite(n)) return "—";          // unknown / variable pricing
  if (n === 0) return "$0";
  if (n >= 1000)     return "$" + f.format(Math.round(n));
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

function ctxFmt(n) {
  if (!n) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
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
// request lands (openrouter/auto, fusion, …). That is *unknown*, not negative —
// treat it (and anything unparseable) as NaN so it can never be costed or sorted
// as if it were cheap.
function rateOf(v) {
  const n = parseFloat(v);
  return isFinite(n) && n >= 0 ? n : NaN;
}

function cost(m, u) {
  const p = m.pricing || {};
  const inR  = rateOf(p.prompt);
  const outR = rateOf(p.completion);
  const unknown = !isFinite(inR) || !isFinite(outR);

  const crRaw = rateOf(p.input_cache_read);
  const hasCache = isFinite(crRaw) && crRaw > 0;
  const crR = hasCache ? crRaw : inR;             // no native caching → reads cost full input rate

  const cwRaw = rateOf(p.input_cache_write);
  // no cache support → "cache writes" are just fresh input, not free
  const cwR = isFinite(cwRaw) ? cwRaw : (hasCache ? 0 : inR);

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

function decorate() {
  return MODELS.map(m => {
    const prov = providerOf(m.id);
    return { m, prov, meta: provMeta(prov), name: cleanName(m), c: cost(m, usage) };
  });
}

/* ---- data load ----------------------------------------------------------- */
function setStatus(kind, label) {
  const el = $("#status"), t = $("#statusText");
  el.classList.remove("live", "snap", "err");
  if (kind === "live")      { el.classList.add("live"); t.textContent = "live · " + label; }
  else if (kind === "snap") { el.classList.add("snap"); t.textContent = "snapshot · " + label; }
  else                      { el.classList.add("err");  t.textContent = label; }
}

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

// Meta-routers (openrouter/fusion, /pareto-code, /bodybuilder, /auto) report "-1"
// for every rate because you pay whatever the model they pick charges. There is
// nothing to cost, so they're dropped rather than listed as "variable".
function isUncostable(m) {
  const c = cost(m, DEFAULTS);
  return c.unknown;
}

// "chat completions" = every priced text→text LLM in the catalog, across all providers.
function pick(arr) {
  return arr.filter(m => isTextModel(m) && !isFreeTier(m) && !isUncostable(m))
            .map(x => ({ id: x.id, name: x.name, context_length: x.context_length, pricing: x.pricing, architecture: x.architecture }));
}

async function load(isRefresh) {
  const btn = $("#refreshBtn");
  if (isRefresh) btn.classList.add("spin");
  try {
    const r = await fetch(API, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const data = pick(j.data || []);
    if (!data.length) throw new Error("empty");
    MODELS = data;
    const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    setStatus("live", now);
    $("#footMeta").textContent = `${MODELS.length} models · live from openrouter.ai · ${new Date().toLocaleString()}`;
  } catch (e) {
    const snap = window.OR_SNAPSHOT;
    if (MODELS.length) {
      // we already have good data — a failed refresh must not downgrade it to an older snapshot
      setStatus("err", "refresh failed · showing last good data");
    } else if (snap && snap.data && snap.data.length) {
      MODELS = pick(snap.data);
      setStatus("snap", snap.generated);
      $("#footMeta").textContent = `${MODELS.length} models · offline snapshot (${snap.generated}) · live fetch unavailable`;
    } else {
      setStatus("err", "no data");
    }
  } finally {
    if (isRefresh) setTimeout(() => btn.classList.remove("spin"), 500);
    render();
  }
}

/* ---- rendering ----------------------------------------------------------- */
// numeric compare that always parks unknown (NaN) values at the bottom, in both
// directions — otherwise NaN comparisons return false and the sort goes to pieces.
function numCmp(a, b, desc) {
  const ka = isFinite(a), kb = isFinite(b);
  if (!ka || !kb) return ka === kb ? 0 : (ka ? -1 : 1);
  return desc ? b - a : a - b;
}

function applyFilterSort(list) {
  let out = list;
  if (filterProv !== "all") out = out.filter(d => d.prov === filterProv);
  if (query) {
    const q = query.toLowerCase();
    out = out.filter(d => d.name.toLowerCase().includes(q) || d.m.id.toLowerCase().includes(q));
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const by = {
    "cost-asc":  (a, b) => numCmp(a.c.total, b.c.total, false) || byName(a, b),
    "cost-desc": (a, b) => numCmp(a.c.total, b.c.total, true)  || byName(a, b),
    "in-asc":    (a, b) => numCmp(a.c.inR,   b.c.inR,   false) || byName(a, b),
    "out-asc":   (a, b) => numCmp(a.c.outR,  b.c.outR,  false) || byName(a, b),
    "ctx-desc":  (a, b) => numCmp(a.m.context_length || 0, b.m.context_length || 0, true) || byName(a, b),
    "name-asc":  byName,
    "prov-asc":  (a, b) => a.meta.label.localeCompare(b.meta.label) || numCmp(a.c.total, b.c.total, false) || byName(a, b)
  }[sortMode] || ((a, b) => numCmp(a.c.total, b.c.total, false) || byName(a, b));
  return [...out].sort(by);
}

const CHIP_LIMIT = 12;          // providers shown before the "+N more" toggle
let chipsOpen = false;

function renderChips(all) {
  const counts = all.reduce((a, d) => (a[d.prov] = (a[d.prov] || 0) + 1, a), {});
  // only providers actually present, busiest first (ties → label A–Z)
  const provs = Object.keys(counts).sort((a, b) =>
    counts[b] - counts[a] || provMeta(a).label.localeCompare(provMeta(b).label));
  const items = [{ key: "all", label: "All", color: "var(--text)", n: all.length },
    ...provs.map(k => ({ key: k, label: provMeta(k).label, color: provMeta(k).color, n: counts[k] }))];
  // if the active filter no longer matches any model, fall back to All
  if (filterProv !== "all" && !counts[filterProv]) filterProv = "all";

  // 40+ providers wrapped into six rows of chips and swamped the page. Show the
  // busiest handful and tuck the long tail behind a toggle.
  const head = items.slice(0, CHIP_LIMIT + 1);   // +1 because items[0] is "All"
  const tail = items.slice(CHIP_LIMIT + 1);
  if (!chipsOpen) {
    const i = tail.findIndex(it => it.key === filterProv);   // keep the active chip visible
    if (i >= 0) head.push(tail.splice(i, 1)[0]);
  }
  const chip = it => {
    const on = filterProv === it.key;
    return `
    <button type="button" class="chip ${on ? "active" : ""}" data-prov="${esc(it.key)}" role="tab" aria-selected="${on}">
      <span class="dot" style="--c:${esc(it.color)}"></span>${esc(it.label)}<span class="cnt">${it.n}</span>
    </button>`;
  };
  const more = tail.length
    ? `<button type="button" class="chip chip-more" data-more="1" aria-expanded="${chipsOpen}">${
        chipsOpen ? "− less" : `+${tail.length} more`}</button>`
    : "";
  $("#chips").innerHTML = (chipsOpen ? [...head, ...tail] : head).map(chip).join("") + more;
}

function findFeatured(all) {
  return FEATURED.map(spec => {
    let d = null;
    for (const id of spec.ids) { d = all.find(x => x.m.id === id); if (d) break; }  // honor priority order
    if (!d) d = all.find(x => spec.rx.test(x.m.id));
    return { spec, d };
  });
}

function renderFeatured(items) {
  const costs = items.filter(i => i.d && isFinite(i.d.c.total)).map(i => i.d.c.total);
  const min = costs.length ? Math.min(...costs) : NaN;
  const cards = items.map(i => {
    if (!i.d) return `
      <div class="pod pod-missing">
        <div class="pod-rank"><span class="pod-medal">★</span> featured</div>
        <h3 class="pod-name">${esc(i.spec.label)}</h3>
        <div class="pod-cost">—<small>not in catalog</small></div>
      </div>`;
    const d = i.d, known = isFinite(d.c.total);
    const best = known && d.c.total === min && costs.length > 1;
    const figure = known
      ? `<div class="pod-cost" data-target="${d.c.total}">$0<small>/mo</small></div>`
      : `<div class="pod-cost">—<small>variable pricing</small></div>`;
    return `
      <div class="pod ${best ? "pod-1" : ""}">
        <div class="pod-rank"><span class="pod-medal">★</span> featured${best ? " · cheapest of 3" : ""}</div>
        <div class="pod-prov"><span class="m-dot" style="--c:${esc(d.meta.color)};width:8px;height:8px"></span>${esc(d.meta.label)}</div>
        <h3 class="pod-name">${esc(i.spec.label)}<span class="pod-id">${esc(d.m.id)}</span></h3>
        ${figure}
      </div>`;
  }).join("");
  $("#podium").innerHTML =
    `<div class="podium-cap">★ Featured models · your monthly cost</div><div class="pod-row">${cards}</div>`;
  // Count up on the first paint only. Re-running it on every render meant each
  // keystroke / slider tick restarted the animation and stacked rAF loops that
  // fought over the same element.
  $$("#podium .pod-cost[data-target]").forEach(el => {
    const target = +el.dataset.target;
    if (podiumAnimated) el.innerHTML = money(target) + "<small>/mo</small>";
    else countUp(el, target);
  });
  if (cards) podiumAnimated = true;
}

let podiumAnimated = false;

function countUp(el, target) {
  const dur = 650, t0 = performance.now();
  const small = "<small>/mo</small>";
  (function frame(t) {
    if (!el.isConnected) return;               // node replaced by a re-render — stop
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.innerHTML = money(target * e) + small;
    if (k < 1) requestAnimationFrame(frame);
  })(t0);
}

function row(d, maxCost) {
  const c = d.c;
  const w = maxCost > 0 && isFinite(c.total) ? Math.max(2, (c.total / maxCost) * 88) : 0;
  const free = c.total === 0;
  const noCache = !c.unknown && !c.hasCache && usage.cache_read > 0;
  const vision = hasVision(d.m);
  const id = esc(d.m.id), open = openId === d.m.id;
  const tags =
    (vision ? '<span class="tag">vision</span>' : "") +
    (c.unknown ? '<span class="tag">variable</span>' : "") +
    (free ? '<span class="tag">free</span>' : "") +
    (noCache ? '<span class="tag">no cache</span>' : "");
  const cards =
    `${bd("Fresh input", c.cIn, c.total, `${f.format(usage.input)} tok × ${perM(c.inR)}/M`)}
     ${bd("Output", c.cOut, c.total, `${f.format(usage.output)} tok × ${perM(c.outR)}/M`)}
     ${bd("Cached reads", c.cCr, c.total, c.hasCache ? `${f.format(usage.cache_read)} tok × ${perM(c.crR)}/M` : "no native cache → billed as input")}
     ${usage.cache_write > 0 ? bd("Cache writes", c.cCw, c.total, c.hasCache ? `${f.format(usage.cache_write)} tok × ${perM(c.cwR)}/M` : "no native cache → billed as input") : ""}
     ${bdTotal(c.total)}`;
  return `
    <tr class="row" data-id="${id}" tabindex="0" role="button" aria-expanded="${open}"
        aria-label="${esc(d.name)} — ${money(c.total)} per month; toggle cost breakdown">
      <td>
        <div class="m-name">
          <span class="m-dot" style="--c:${esc(d.meta.color)}"></span>
          <div>
            <div class="m-title">${esc(d.name)}${tags}</div>
            <div class="m-id">${id}</div>
          </div>
        </div>
      </td>
      <td class="col-ctx">${ctxFmt(d.m.context_length)}</td>
      <td class="num">${perM(c.inR)}</td>
      <td class="num out-col">${perM(c.outR)}</td>
      <td class="num cache-col ${c.hasCache ? "" : "faint"}">${c.hasCache ? perM(c.crR) : "—"}</td>
      <td class="num col-cost ${c.unknown ? "faint" : ""}">
        <span class="cost-val">${money(c.total)}</span>
        <span class="cost-bar" style="width:${w}px"></span>
      </td>
    </tr>
    <tr class="detail ${open ? "open" : ""}" data-detail="${id}">
      <td colspan="6"><div class="detail-inner">
        <div class="bd-grid">${cards}</div>
        ${provPanel(id, open)}
      </div></td>
    </tr>`;
}

/* ---- upstream providers -------------------------------------------------- */
// OpenRouter routes each model to one of several upstream hosts, and they don't
// charge the same — the catalog rate is just the default. Fetched per model, on
// demand (opening a row), and cached for the session.
const EP_CACHE = new Map();       // model id → { state, eps, msg }

const epUrl = id => `${API}/${id.replace(/^~/, "")}/endpoints`;

async function loadEndpoints(id) {
  if (EP_CACHE.has(id)) return EP_CACHE.get(id);
  const rec = { state: "loading", eps: [] };
  EP_CACHE.set(id, rec);
  try {
    const r = await fetch(epUrl(id), { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    rec.eps = (j.data && j.data.endpoints) || [];
    rec.state = rec.eps.length ? "ok" : "empty";
  } catch (e) {
    rec.state = "err";
    rec.msg = e && e.message ? e.message : "request failed";
  }
  return rec;
}

function pct(v) { return v == null ? "—" : v.toFixed(2) + "%"; }

function epRows(eps) {
  return eps
    .map(e => ({ e, c: cost({ pricing: e.pricing }, usage) }))
    .sort((a, b) => numCmp(a.c.total, b.c.total, false) ||
                    String(a.e.provider_name).localeCompare(String(b.e.provider_name)));
}

function epMarkup(id) {
  const rec = EP_CACHE.get(id);
  if (!rec || rec.state === "loading") return `<div class="prov-msg">Loading upstream providers…</div>`;
  if (rec.state === "err")   return `<div class="prov-msg err">Couldn't load providers — ${esc(rec.msg)}.</div>`;
  if (rec.state === "empty") return `<div class="prov-msg">No upstream provider breakdown published for this model.</div>`;

  const rows = epRows(rec.eps);
  const cheapest = rows.length ? rows[0].c.total : NaN;
  // these are null across the public API today — only show the columns if real
  const speed = rec.eps.some(e => e.latency_last_30m != null || e.throughput_last_30m != null);

  const body = rows.map(({ e, c }) => {
    const best = isFinite(c.total) && c.total === cheapest;
    const disc = e.pricing && e.pricing.discount > 0
      ? `<span class="prov-off">${Math.round(e.pricing.discount * 100)}% off</span>` : "";
    const quant = e.quantization && e.quantization !== "unknown" ? e.quantization : "";
    return `
      <tr class="${best ? "prov-best" : ""}">
        <td class="prov-nm">${esc(e.provider_name || e.name || "—")}${
          quant ? `<span class="tag">${esc(quant)}</span>` : ""}${disc}${
          best && rows.length > 1 ? `<span class="tag tag-best">cheapest</span>` : ""}</td>
        <td class="prov-ctx">${ctxFmt(e.context_length)}</td>
        <td class="num">${perM(c.inR)}</td>
        <td class="num">${perM(c.outR)}</td>
        <td class="num ${c.hasCache ? "" : "faint"}">${c.hasCache ? perM(c.crR) : "—"}</td>
        ${speed ? `<td class="num faint">${e.latency_last_30m != null ? e.latency_last_30m.toFixed(2) + "s" : "—"}</td>
        <td class="num faint">${e.throughput_last_30m != null ? Math.round(e.throughput_last_30m) + " tps" : "—"}</td>` : ""}
        <td class="num faint">${pct(e.uptime_last_30m)}</td>
        <td class="num prov-cost">${money(c.total)}</td>
      </tr>`;
  }).join("");

  return `
    <div class="prov-scroll">
      <table class="prov-table">
        <thead><tr>
          <th>Provider</th><th>Context</th><th class="num">Input <small>$/M</small></th>
          <th class="num">Output <small>$/M</small></th><th class="num">Cache read <small>$/M</small></th>
          ${speed ? `<th class="num">Latency</th><th class="num">Throughput</th>` : ""}
          <th class="num">Uptime <small>30m</small></th><th class="num">Your cost</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

// patch just the open row's panel — a full render() would collapse it
function paintEndpoints(id) {
  const host = $(`.prov-body[data-ep="${CSS.escape(id)}"]`);
  if (host) host.innerHTML = epMarkup(id);
}

// Body is only filled for the open row — closed rows keep an empty shell so the
// panel doesn't cost anything across the other ~370 rows.
function provPanel(id, open) {
  const rec = EP_CACHE.get(id);
  const n = open && rec && rec.state === "ok" ? rec.eps.length : 0;
  return `
    <div class="prov-panel">
      <div class="prov-head">Upstream providers${n ? ` <span class="prov-n">${n}</span>` : ""}
        <span class="prov-note">who OpenRouter can route this model to — priced against your usage, cheapest first</span>
      </div>
      <div class="prov-body" data-ep="${esc(id)}">${open ? epMarkup(id) : ""}</div>
    </div>`;
}

function bd(k, v, total, sub) {
  const pct = total > 0 && isFinite(v) ? Math.round((v / total) * 100) : 0;
  return `<div class="bd"><div class="bd-k">${esc(k)} · ${pct}%</div><div class="bd-v">${money(v)}</div><div class="bd-sub">${esc(sub)}</div></div>`;
}
function bdTotal(v) {
  return `<div class="bd total"><div class="bd-k">Monthly total</div><div class="bd-v">${money(v)}</div><div class="bd-sub">your usage on this model</div></div>`;
}

function render() {
  const all = decorate();
  renderChips(all);

  // hero = three fixed featured models, costed against the current usage
  renderFeatured(findFeatured(all));
  const paid = all.filter(d => isFinite(d.c.total) && d.c.total > 0).sort((a, b) => a.c.total - b.c.total);

  const list = applyFilterSort(all);
  const maxCost = list.reduce((m, d) => Math.max(m, isFinite(d.c.total) ? d.c.total : 0), 0);

  $("#rows").innerHTML = list.map(d => row(d, maxCost)).join("");
  $("#empty").hidden = list.length > 0;

  // update usage summary line
  const totalTok = usage.input + usage.output + usage.cache_read + usage.cache_write;
  const cheapestPaid = paid[0];
  const s = periodScale();
  const scaleNote = Math.abs(s - 1) > 0.001
    ? ` <b>Projected ×${(Math.round(s * 100) / 100)}</b> from your ${period.dataDays}-day data.`
    : "";
  $("#usageNote").innerHTML =
    `Costing <b>${f.format(totalTok)}</b> tokens / ${period.projectDays}-day month — ` +
    `${f.format(usage.input)} fresh in · ${f.format(usage.output)} out · ${f.format(usage.cache_read)} cached.` +
    scaleNote +
    ` Across <b>${all.length}</b> text models, ` +
    (cheapestPaid ? `cheapest is <b>${money(cheapestPaid.c.total)}/mo</b> (${esc(cheapestPaid.name)}). Free tiers are excluded; routers with variable pricing can't be costed.` : "no priced match.");
}

/* flash the cost cells after a usage edit (visual feedback that numbers moved) */
function flashCosts() {
  $$("#rows td.col-cost").forEach(td => {
    td.classList.remove("flash");
    void td.offsetWidth;
    td.classList.add("flash");
  });
}

/* ---- usage inputs -------------------------------------------------------- */
const FIELD_IDS = { input: "#u_input", output: "#u_output", cache_read: "#u_cache_read", cache_write: "#u_cache_write" };

function writeFields() {
  for (const [k, sel] of Object.entries(FIELD_IDS)) $(sel).value = f.format(usage[k]);
}

function writePeriod() {
  $("#p_data").value = period.dataDays;
  $("#p_proj").value = period.projectDays;
  const s = periodScale();
  const mult = $("#periodMult");
  mult.textContent = "×" + (Math.round(s * 100) / 100);
  mult.classList.toggle("on", Math.abs(s - 1) > 0.001);
}

/* ---- cache hit rate ------------------------------------------------------ */
// hit rate = share of total input served from cache (cheap) vs sent fresh (full price).
function hitRate() {
  const t = usage.input + usage.cache_read;
  return t > 0 ? usage.cache_read / t : 0;
}

// rebalance fresh/cached for a new hit rate, keeping total input fixed.
function applyHit(rate) {
  const total = usage.input + usage.cache_read;
  const cached = Math.round(total * rate);
  base = { ...usage };                 // freeze current monthly numbers as the new base…
  period.dataDays = period.projectDays;//  …and drop scaling so the split is literal
  base.cache_read = cached;
  base.input = total - cached;
  recalcUsage();
}

function writeHitLabel() {
  const r = hitRate();
  const pct = Math.round(r * 100);
  $("#hitVal").textContent = pct + "%";
  $("#hitSlider").style.setProperty("--fill", pct + "%");
  $$("#hitPresets .hr-preset").forEach(b => b.classList.toggle("on", +b.dataset.hr === pct));
  $("#hitHint").innerHTML =
    `→ <b>${f.format(usage.cache_read)}</b> cached read · <b>${f.format(usage.input)}</b> fresh input / ${period.projectDays}-day mo. ` +
    `Only changes cost for cache-capable models — Anthropic needs explicit cache breakpoints; OpenAI/Gemini/DeepSeek auto-cache.`;
}

function writeHitRate() {            // full sync: also move the slider to match the data
  $("#hitSlider").value = Math.round(hitRate() * 100);
  writeHitLabel();
}

function bindHit() {
  $("#hitSlider").addEventListener("input", e => {
    applyHit((+e.target.value) / 100);
    writeFields();
    writePeriod();
    writeHitLabel();               // leave the slider where the user dragged it
    render();
    flashCosts();
  });
  $("#hitPresets").addEventListener("click", e => {
    const b = e.target.closest(".hr-preset"); if (!b) return;
    applyHit((+b.dataset.hr) / 100);
    writeFields();
    writePeriod();
    writeHitRate();
    render();
    flashCosts();
  });
}

function bindUsage() {
  for (const [k, sel] of Object.entries(FIELD_IDS)) {
    const el = $(sel);
    el.addEventListener("input", () => {
      // a manual edit is a literal monthly value: freeze the current scaled numbers as the
      // new base and drop scaling, so the other fields don't jump around.
      base = { ...usage };
      period.dataDays = period.projectDays;
      base[k] = parseNum(el.value);
      recalcUsage();
      writePeriod();
      writeHitRate();
      render();
      flashCosts();
    });
    el.addEventListener("blur", () => { el.value = f.format(usage[k]); });
    el.addEventListener("focus", () => { el.value = usage[k] ? String(usage[k]) : ""; el.select(); });
  }
  $("#resetBtn").addEventListener("click", () => {
    base = { ...DEFAULTS };
    period = { dataDays: 30, projectDays: 30 };
    recalcUsage();
    writeFields();
    writePeriod();
    writeHitRate();
    render();
    flashCosts();
  });
}

function bindPeriod() {
  const upd = () => {
    period.dataDays    = Math.max(0.1, parseNum($("#p_data").value) || 30);
    period.projectDays = Math.max(0.1, parseNum($("#p_proj").value) || 30);
    recalcUsage();
    writeFields();
    writePeriod();
    writeHitRate();
    render();
    flashCosts();
  };
  $("#p_data").addEventListener("input", upd);
  $("#p_proj").addEventListener("input", upd);
}

/* ---- other controls ------------------------------------------------------ */
function bindControls() {
  $("#chips").addEventListener("click", e => {
    const b = e.target.closest(".chip"); if (!b) return;
    if (b.dataset.more) { chipsOpen = !chipsOpen; render(); return; }
    filterProv = b.dataset.prov; render();
  });
  let qt;
  $("#search").addEventListener("input", e => {
    clearTimeout(qt); qt = setTimeout(() => { query = e.target.value.trim(); render(); }, 90);
  });
  $("#sort").addEventListener("change", e => { sortMode = e.target.value; render(); });
  $("#refreshBtn").addEventListener("click", () => load(true));

  // expand/collapse breakdown rows (mouse + keyboard)
  const toggleRow = tr => {
    const id = tr.dataset.id;
    openId = openId === id ? null : id;
    const det = $(`tr.detail[data-detail="${CSS.escape(id)}"]`);
    $$("#rows tr.row[aria-expanded='true']").forEach(x => x.setAttribute("aria-expanded", "false"));
    $$("#rows tr.detail.open").forEach(x => { if (x !== det) x.classList.remove("open"); });
    if (det) det.classList.toggle("open", openId === id);
    tr.setAttribute("aria-expanded", String(openId === id));
    if (openId !== id) return;
    // opening: show the placeholder now, fill in when the provider list lands
    paintEndpoints(id);
    loadEndpoints(id).then(() => { if (openId === id) paintEndpoints(id); });
  };
  $("#rows").addEventListener("click", e => {
    const tr = e.target.closest("tr.row"); if (tr) toggleRow(tr);
  });
  $("#rows").addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr.row"); if (!tr) return;
    e.preventDefault();
    toggleRow(tr);
  });
}

/* ---- Hermes Insights parser ---------------------------------------------- */
// Reads the "Tokens: <total> (in: <in> / out: <out>)" line from a pasted Insights block.
function parseInsights(text) {
  const grab = re => { const m = text.match(re); return m ? parseNum(m[1]) : null; };
  // reporting window, e.g. "Hermes Insights — Last 7 days" / "Last 24 hours" / "Last 4 weeks"
  const w = text.match(/last\s+([\d.]+)\s*(hour|day|week|month)/i);
  let windowDays = null;
  if (w) {
    const n = parseFloat(w[1]), u = w[2].toLowerCase();
    windowDays = u === "hour" ? n / 24 : u === "week" ? n * 7 : u === "month" ? n * 30 : n;
  }
  return {
    total: grab(/tokens?:\s*([\d,\s]+?)\s*\(/i) ?? grab(/tokens?:\s*([\d,]+)/i),
    inp:   grab(/\bin:\s*([\d,]+)/i),
    out:   grab(/\bout:\s*([\d,]+)/i),
    windowDays
  };
}

function setPasteMsg(text, isErr) {
  const el = $("#pasteMsg");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

function loadInsights() {
  const text = $("#pasteArea").value;
  const { total, inp, out, windowDays } = parseInsights(text);
  if (total == null && inp == null && out == null) {
    setPasteMsg("Couldn't find a “Tokens: … (in: … / out: …)” line — paste the full Insights block.", true);
    return;
  }
  base = {
    input:       inp ?? 0,
    output:      out ?? 0,
    cache_read:  (total != null) ? Math.max(0, total - (inp ?? 0) - (out ?? 0)) : 0,
    cache_write: 0
  };
  period.dataDays = windowDays ? Math.round(windowDays * 100) / 100 : 30;
  period.projectDays = 30;
  recalcUsage();
  writeFields();
  writePeriod();
  writeHitRate();
  render();
  flashCosts();
  const s = periodScale();
  const note = windowDays
    ? `Detected a ${period.dataDays}-day window → scaled ×${(Math.round(s * 100) / 100)} to a 30-day month.`
    : `No “Last N days” line found — assuming ~30 days (no scaling).`;
  setPasteMsg(`Loaded ✓ ${note}  ${f.format(usage.input)} in · ${f.format(usage.output)} out · ${f.format(usage.cache_read)} cached / mo`, false);
}

function bindPaste() {
  $("#pasteToggle").addEventListener("click", () => {
    const box = $("#pasteBox");
    box.hidden = !box.hidden;
    if (!box.hidden) $("#pasteArea").focus();
  });
  $("#pasteLoad").addEventListener("click", loadInsights);
  $("#pasteArea").addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); loadInsights(); }
  });
}

/* ---- boot ---------------------------------------------------------------- */
recalcUsage();
writeFields();
writePeriod();
writeHitRate();
bindUsage();
bindPeriod();
bindHit();
bindControls();
bindPaste();
load(false);
// quiet auto-refresh every 10 min — skipped while the tab is in the background
setInterval(() => { if (!document.hidden) load(false); }, 10 * 60 * 1000);
