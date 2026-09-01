/* =========================================================================
   Price Lens — app logic
   Live OpenRouter pricing → cost your real monthly usage on every model.
   Pure pricing/catalog rules live in engine.js (shared with the snapshot
   builder and the tests); this file is state, fetch and rendering.
   ========================================================================= */

"use strict";

const {
  fmt, esc, money, perM, ctxFmt, parseNum,
  cost, tierOf, costBarWidth, providerOf, hasVision, pick, cmpVersion, parseInsights
} = window.PriceLens;

const API = "https://openrouter.ai/api/v1/models";
const REFRESH_MS = 10 * 60 * 1000;

// Generic sample workload so the page is alive on first load.
// Replace via the field inputs or by pasting your own Hermes Insights block.
const DEFAULTS = {
  input:       20000000,   // fresh / uncached prompt
  output:      3000000,    // completion
  cache_read:  60000000,   // re-sent cached context  (= total − in − out)
  cache_write: 0
};

// Always-shown hero trio. Matched by exact id (in priority order); if none of
// those is in the catalog any more, the newest release matching `rx` stands in
// and is shown under its own name.
const FEATURED = [
  { ids: ["anthropic/claude-fable-5.1"],                                              rx: /^anthropic\/claude-fable-[\d.]+$/,       label: "Fable 5.1" },
  { ids: ["openai/gpt-5.6-sol"],                                                      rx: /^openai\/gpt-[\d.]+-sol$/,               label: "GPT-5.6 Sol" },
  { ids: ["google/gemini-3.1-pro-preview", "google/gemini-3.1-pro-preview-customtools"], rx: /^google\/gemini-[\d.]+-pro(-preview)?$/, label: "Gemini 3.1 Pro" }
];

// Display labels for providers whose id segment isn't a readable name. Anything
// not listed shows its id segment as-is.
const PROV_LABEL = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", qwen: "Qwen", mistralai: "Mistral",
  "meta-llama": "Meta", meta: "Meta", deepseek: "DeepSeek", "x-ai": "xAI", cohere: "Cohere",
  microsoft: "Microsoft", nvidia: "NVIDIA", "z-ai": "Z.AI", moonshotai: "MoonshotAI", minimax: "MiniMax",
  ai21: "AI21", amazon: "Amazon", nousresearch: "Nous", perplexity: "Perplexity", liquid: "Liquid",
  inception: "Inception", reka: "Reka", baidu: "Baidu", tencent: "Tencent", "01-ai": "01.AI",
  inflection: "Inflection", allenai: "Ai2", "arcee-ai": "Arcee", stepfun: "StepFun", thedrummer: "TheDrummer",
  sao10k: "Sao10K", agentica: "Agentica", "bytedance-seed": "ByteDance", inclusionai: "inclusionAI",
  upstage: "Upstage", "ibm-granite": "IBM", sakana: "Sakana"
};

// Only the busiest labs get a hue. Thirty near-identical brand colours told
// nobody anything at 9px (Google vs Microsoft was ΔE 2.9); these eight sit at
// least ΔE 27 apart. Everyone else shares the neutral dot and the label
// carries the identity.
const PROV_HUE = {
  openai:       "#2bcf8d",
  qwen:         "#b197ff",
  google:       "#6aa6f7",
  anthropic:    "#e08a63",
  mistralai:    "#f5b431",
  deepseek:     "#4d6bfe",
  "z-ai":       "#ff6b9d",
  "meta-llama": "#38c8d4",
  meta:         "#38c8d4"
};
function provMeta(prov) {
  return { label: PROV_LABEL[prov] || prov, color: PROV_HUE[prov] || "var(--dot)" };
}

/* ---- state --------------------------------------------------------------- */
let MODELS = [];                       // raw {id,name,context_length,pricing}
let LAST   = new Map();                // id → decorated row from the last render()
let source = null;                     // "live" | "snap" — what MODELS currently holds
let lastLiveAt = 0;                    // ms timestamp of the last successful live fetch
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

// "Anthropic: Claude Opus 5" → "Claude Opus 5" when the prefix is the model's own
// provider (or any provider we know), so unknown labs get the same treatment.
function cleanName(m) {
  const n = m.name || m.id;
  const i = n.indexOf(": ");
  if (i > 0) {
    const head = n.slice(0, i).toLowerCase();
    const own = provMeta(providerOf(m.id)).label.toLowerCase();
    if (head === own || Object.values(PROV_LABEL).some(l => l.toLowerCase() === head)) return n.slice(i + 2);
  }
  return n;
}

function tierNote(t) {
  return `Long-context tier: above ${ctxFmt(t.minPromptTokens)} prompt tokens OpenRouter bills ` +
         `${perM(t.inR)}/M in · ${perM(t.outR)}/M out. Not modelled — this cost uses the base rate.`;
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

let inflight = null;
// one fetch at a time — a manual Refresh landing on top of the timer (or a tab
// coming back to the foreground) must not race two responses into MODELS.
function load(isRefresh) {
  return inflight || (inflight = doLoad(isRefresh).finally(() => { inflight = null; }));
}

async function doLoad(isRefresh) {
  const btn = $("#refreshBtn");
  if (isRefresh) btn.classList.add("spin");
  try {
    const r = await fetch(API, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const data = pick((j && j.data) || []);
    if (!data.length) throw new Error("empty");
    MODELS = data;
    source = "live";
    lastLiveAt = Date.now();
    // Per-provider pricing is now stale too — keeping it would let an open row's
    // breakdown contradict the headline price it sits under.
    EP_CACHE.clear();
    const now = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    setStatus("live", now);
    $("#footMeta").textContent = `${MODELS.length} models · live from openrouter.ai · ${new Date().toLocaleString()}`;
  } catch (e) {
    const snap = window.OR_SNAPSHOT;
    if (MODELS.length) {
      // we already have good data — a failed refresh must not downgrade it to an
      // older snapshot, and the pill must keep saying what is actually on screen
      if (source === "snap") setStatus("snap", `${snap.generated} · refresh failed`);
      else setStatus("err", "refresh failed · showing last live data");
    } else if (snap && snap.data && snap.data.length) {
      MODELS = pick(snap.data);
      source = "snap";
      setStatus("snap", snap.generated);
      $("#footMeta").textContent = `${MODELS.length} models · offline snapshot (${snap.generated}) · live fetch unavailable`;
    } else {
      setStatus("err", "no data");
    }
  } finally {
    if (isRefresh) setTimeout(() => btn.classList.remove("spin"), 500);
    render();
    // an open row whose providers were just invalidated needs them re-fetched
    if (openId && !EP_CACHE.has(openId)) {
      const id = openId;
      loadEndpoints(id).then(() => { if (openId === id) paintEndpoints(id); });
    }
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
    <button type="button" class="chip ${on ? "active" : ""}" data-prov="${esc(it.key)}" aria-pressed="${on}">
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
    if (d) return { spec, d, label: spec.label };
    // pinned id gone from the catalog → newest release of the family, under its own name
    d = all.filter(x => spec.rx.test(x.m.id)).sort((a, b) => cmpVersion(b.m.id, a.m.id))[0] || null;
    return { spec, d, label: d ? d.name : spec.label };
  });
}

function renderFeatured(items) {
  const costs = items.filter(i => i.d && isFinite(i.d.c.total)).map(i => i.d.c.total);
  const min = costs.length ? Math.min(...costs) : NaN;
  const cards = items.map(i => {
    if (!i.d) return `
      <div class="pod pod-missing">
        <div class="pod-rank"><span class="pod-medal">★</span> featured</div>
        <h3 class="pod-name">${esc(i.label)}</h3>
        <div class="pod-cost">—<small>not in catalog</small></div>
      </div>`;
    const d = i.d, c = d.c, known = isFinite(c.total);
    const best = known && c.total === min && costs.length > 1;
    const figure = known
      ? `<div class="pod-cost" data-target="${c.total}">$0<small>/mo</small></div>`
      : `<div class="pod-cost">—<small>variable pricing</small></div>`;
    // where the money goes — same four tones as the usage-field markers
    const parts = [["fresh in", c.cIn], ["out", c.cOut], ["cached", c.cCr]];
    if (usage.cache_write > 0) parts.push(["writes", c.cCw]);
    const split = known && c.total > 0 ? `
        <div class="pod-bar" aria-hidden="true">${parts.map((p, k) =>
          `<i class="tone-${k + 1}" style="width:${(p[1] / c.total * 100).toFixed(1)}%"></i>`).join("")}</div>
        <div class="pod-split">${parts.map((p, k) =>
          `<span><b class="tone-${k + 1}"></b>${p[0]} ${money(p[1])}</span>`).join("")}</div>` : "";
    // the card is a shortcut to its row (see openFromPodium)
    return `
      <div class="pod ${best ? "pod-1" : ""}" data-id="${esc(d.m.id)}" role="button" tabindex="0"
           aria-label="${esc(i.label)}: ${money(c.total)} per month. Open its row in the table">
        <div class="pod-rank"><span class="pod-medal">★</span> featured${best ? `<span class="pod-flag">cheapest of 3</span>` : ""}</div>
        <div class="pod-prov"><span class="m-dot" style="--c:${esc(d.meta.color)};width:8px;height:8px"></span>${esc(d.meta.label)}</div>
        <h3 class="pod-name">${esc(i.label)}<span class="pod-id">${esc(d.m.id)}</span></h3>
        ${figure}${split}
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

const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");

function countUp(el, target) {
  if (REDUCED && REDUCED.matches) { el.innerHTML = money(target) + "<small>/mo</small>"; return; }
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

function row(d, scale) {
  const c = d.c;
  const w = costBarWidth(c.total, scale.lo, scale.hi);
  const free = c.total === 0;
  const tier = tierOf(d.m);
  const id = esc(d.m.id), open = openId === d.m.id;
  const tags =
    (hasVision(d.m) ? '<span class="tag">vision</span>' : "") +
    (tier ? `<span class="tag" title="${esc(tierNote(tier))}">tiered</span>` : "") +
    (c.unknown ? '<span class="tag">variable</span>' : "") +
    (free ? '<span class="tag">free</span>' : "");   // "no cache" is already the dash in the cache column
  // The breakdown is only built for the open row. Building it for every closed
  // row too was 57% of the HTML and 59% of the DOM on each render.
  return `
    <tr class="row" data-id="${id}" tabindex="0" aria-expanded="${open}"
        aria-label="${esc(d.name)} — ${money(c.total)} per month; toggle cost breakdown">
      <td>
        <div class="m-name">
          <span class="m-dot" style="--c:${esc(d.meta.color)}"></span>
          <div>
            <div class="m-title">${esc(d.name)}${tags}</div>
            <div class="m-id">${id}</div>
            <div class="m-prov">${esc(d.meta.label)}</div>
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
      <td colspan="6"><div class="detail-inner">${open ? detailMarkup(d) : ""}</div></td>
    </tr>`;
}

// cost cards + upstream provider panel for one (open) row
function detailMarkup(d) {
  const c = d.c, tier = tierOf(d.m);
  const cards =
    bd("Fresh input", c.cIn, c.total, `${fmt(usage.input)} tok × ${perM(c.inR)}/M`) +
    bd("Output", c.cOut, c.total, `${fmt(usage.output)} tok × ${perM(c.outR)}/M`) +
    bd("Cached reads", c.cCr, c.total, c.hasCache ? `${fmt(usage.cache_read)} tok × ${perM(c.crR)}/M` : "no native cache → billed as input") +
    (usage.cache_write > 0 ? bd("Cache writes", c.cCw, c.total, c.hasCache ? `${fmt(usage.cache_write)} tok × ${perM(c.cwR)}/M` : "no native cache → billed as input") : "") +
    bdTotal(c.total);
  return `<div class="bd-grid">${cards}</div>` +
         (tier ? `<div class="tier-note">${esc(tierNote(tier))}</div>` : "") +
         provPanel(d.m.id);
}

/* ---- upstream providers -------------------------------------------------- */
// OpenRouter routes each model to one of several upstream hosts, and they don't
// charge the same — the catalog rate is just the default. Fetched per model, on
// demand (opening a row), and cached for the session.
const EP_CACHE = new Map();       // model id → { state, eps, msg }

// The id comes from the API payload, so encode each path segment — left raw, an
// id containing "?" or "#" rewrites the request (the "/endpoints" suffix silently
// disappears into a fragment and attacker-chosen query params ride along).
const epUrl = id => `${API}/${id.split("/").map(encodeURIComponent).join("/")}/endpoints`;

async function loadEndpoints(id) {
  const prev = EP_CACHE.get(id);
  if (prev && prev.state !== "err") return prev;   // a failure is worth retrying, a result isn't
  const rec = { state: "loading", eps: [] };
  EP_CACHE.set(id, rec);
  try {
    const r = await fetch(epUrl(id), { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const eps = j && j.data && j.data.endpoints;
    rec.eps = Array.isArray(eps) ? eps : [];
    rec.state = rec.eps.length ? "ok" : "empty";
  } catch (e) {
    rec.state = "err";
    rec.msg = e && e.message ? e.message : "request failed";
  }
  return rec;
}

// Numbers from the API are not necessarily numbers. Null/absent must stay null:
// Number(null) and Number("") are both 0, which would read as a real measurement.
function num(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function pct(v) { const n = num(v); return n == null ? "—" : n.toFixed(2) + "%"; }

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
  const speed = rec.eps.some(e => num(e.latency_last_30m) != null || num(e.throughput_last_30m) != null);

  const body = rows.map(({ e, c }) => {
    const best = isFinite(c.total) && c.total === cheapest;
    const dsc = num(e.pricing && e.pricing.discount);
    const disc = dsc > 0 ? `<span class="prov-off">${Math.round(dsc * 100)}% off</span>` : "";
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
        ${speed ? `<td class="num faint">${num(e.latency_last_30m) != null ? num(e.latency_last_30m).toFixed(2) + "s" : "—"}</td>
        <td class="num faint">${num(e.throughput_last_30m) != null ? Math.round(num(e.throughput_last_30m)) + " tps" : "—"}</td>` : ""}
        <td class="num faint">${pct(e.uptime_last_30m)}</td>
        <td class="num prov-cost">${money(c.total)}</td>
      </tr>`;
  }).join("");

  return `
    <div class="prov-scroll">
      <table class="prov-table">
        <thead><tr>
          <th scope="col">Provider</th><th scope="col">Context</th><th scope="col" class="num">Input <small>$/M</small></th>
          <th scope="col" class="num">Output <small>$/M</small></th><th scope="col" class="num">Cache read <small>$/M</small></th>
          ${speed ? `<th scope="col" class="num">Latency</th><th scope="col" class="num">Throughput</th>` : ""}
          <th scope="col" class="num">Uptime <small>30m</small></th><th scope="col" class="num">Your cost</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

// Head (with the provider count) + body, so a repaint after the fetch lands
// updates the count badge as well as the table.
function provPanelInner(id) {
  const rec = EP_CACHE.get(id);
  const n = rec && rec.state === "ok" ? rec.eps.length : 0;
  return `
      <div class="prov-head">Upstream providers${n ? ` <span class="prov-n">${n}</span>` : ""}
        <span class="prov-note">who OpenRouter can route this model to — priced against your usage, cheapest first</span>
      </div>
      <div class="prov-body">${epMarkup(id)}</div>`;
}
function provPanel(id) {
  return `<div class="prov-panel" data-ep="${esc(id)}">${provPanelInner(id)}</div>`;
}

// patch just the open row's panel — a full render() would collapse it
function paintEndpoints(id) {
  const host = $(`.prov-panel[data-ep="${CSS.escape(id)}"]`);
  if (host) host.innerHTML = provPanelInner(id);
}

function bd(k, v, total, sub) {
  const share = total > 0 && isFinite(v) ? Math.round((v / total) * 100) : 0;
  return `<div class="bd"><div class="bd-k">${esc(k)} · ${share}%</div><div class="bd-v">${money(v)}</div><div class="bd-sub">${esc(sub)}</div></div>`;
}
function bdTotal(v) {
  return `<div class="bd total"><div class="bd-k">Monthly total</div><div class="bd-v">${money(v)}</div><div class="bd-sub">your usage on this model</div></div>`;
}

function render() {
  const all = decorate();
  LAST = new Map(all.map(d => [d.m.id, d]));
  renderChips(all);

  // hero = three fixed featured models, costed against the current usage
  renderFeatured(findFeatured(all));

  const list = applyFilterSort(all);
  // Filtering the open row out of view must close it — otherwise it silently
  // springs back open, already expanded, the moment the filter is cleared.
  if (openId && !list.some(d => d.m.id === openId)) openId = null;
  // cost-bar scale over the visible list — log between the extremes, see costBarWidth()
  let lo = Infinity, hi = 0;
  for (const d of list) if (isFinite(d.c.total) && d.c.total > 0) { lo = Math.min(lo, d.c.total); hi = Math.max(hi, d.c.total); }
  const scale = { lo, hi };

  $("#rows").innerHTML = list.map(d => row(d, scale)).join("");
  $("#empty").hidden = list.length > 0;

  // update usage summary line
  const totalTok = usage.input + usage.output + usage.cache_read + usage.cache_write;
  let cheapestPaid = null;
  for (const d of all) {
    if (isFinite(d.c.total) && d.c.total > 0 && (!cheapestPaid || d.c.total < cheapestPaid.c.total)) cheapestPaid = d;
  }
  const s = periodScale();
  const scaleNote = Math.abs(s - 1) > 0.001
    ? ` <b>Projected ×${(Math.round(s * 100) / 100)}</b> from your ${period.dataDays}-day data.`
    : "";
  $("#usageNote").innerHTML =
    `Costing <b>${fmt(totalTok)}</b> tokens / ${period.projectDays}-day month — ` +
    `${fmt(usage.input)} fresh in · ${fmt(usage.output)} out · ${fmt(usage.cache_read)} cached.` +
    scaleNote +
    ` Across <b>${all.length}</b> text models, ` +
    (cheapestPaid
      ? `cheapest is <b>${money(cheapestPaid.c.total)}/mo</b> (${esc(cheapestPaid.name)}). Free tiers, batch variants and OpenRouter's routers/aliases are excluded.`
      : "no priced match.");
}

/* flash the cost cells after a usage edit (visual feedback that numbers moved) */
function flashCosts() {
  // Every caller runs render() first, which replaces #rows wholesale — so these
  // nodes are brand new and cannot already carry .flash. The old
  // remove → read offsetWidth → add dance existed to restart the animation on a
  // reused node, but interleaved a forced synchronous layout with a style write
  // 367 times per call: ~1.3s per keystroke, 3.1s per slider tick. Adding the
  // class on a fresh node starts the animation just the same, in ~1ms.
  $$("#rows td.col-cost").forEach(td => td.classList.add("flash"));
}

/* ---- usage inputs -------------------------------------------------------- */
const FIELD_IDS = { input: "#u_input", output: "#u_output", cache_read: "#u_cache_read", cache_write: "#u_cache_write" };

function writeFields() {
  for (const [k, sel] of Object.entries(FIELD_IDS)) $(sel).value = fmt(usage[k]);
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
  const share = Math.round(r * 100);
  $("#hitVal").textContent = share + "%";
  $("#hitSlider").style.setProperty("--fill", share + "%");
  $$("#hitPresets .hr-preset").forEach(b => b.classList.toggle("on", +b.dataset.hr === share));
  $("#hitHint").innerHTML =
    `→ <b>${fmt(usage.cache_read)}</b> cached read · <b>${fmt(usage.input)}</b> fresh input / ${period.projectDays}-day mo. ` +
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
    el.addEventListener("blur", () => { el.value = fmt(usage[k]); });
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
  // An empty field means "not set yet" → default. A typed 0 (or junk) is a real
  // edit and clamps to the 0.1-day floor; `|| 30` conflated the two and made the
  // multiplier leap to 30 mid-keystroke whenever the box was briefly cleared.
  const days = sel => {
    const raw = $(sel).value.trim();
    return raw === "" ? 30 : Math.max(0.1, parseNum(raw));
  };
  const upd = () => {
    period.dataDays    = days("#p_data");
    period.projectDays = days("#p_proj");
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

  // featured card → its row: clear the filters so it is in the list, open it, scroll to it
  const openFromPodium = id => {
    filterProv = "all"; query = ""; $("#search").value = "";
    openId = id;
    render();
    const tr = $(`#rows tr.row[data-id="${CSS.escape(id)}"]`);
    if (tr) {
      tr.scrollIntoView({ block: "center", behavior: REDUCED && REDUCED.matches ? "auto" : "smooth" });
      tr.focus({ preventScroll: true });
    }
    loadEndpoints(id).then(() => { if (openId === id) paintEndpoints(id); });
  };
  $("#podium").addEventListener("click", e => {
    const pod = e.target.closest(".pod[data-id]"); if (pod) openFromPodium(pod.dataset.id);
  });
  $("#podium").addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const pod = e.target.closest(".pod[data-id]"); if (!pod) return;
    e.preventDefault(); openFromPodium(pod.dataset.id);
  });

  // Sticky filter bar: once it is pinned to the top, collapse the chips to one
  // scrolling row (.controls.stuck) instead of holding ~150px of viewport.
  // Checked on scroll rather than with an IntersectionObserver sentinel: a
  // zero-height sentinel never fires when the page jumps past it (End key,
  // scrollbar drag, restored scroll position). Pinned means top === 0; on
  // phones the bar is static, so it is never "stuck".
  const controls = $(".controls");
  let stuckTick = false;
  const syncStuck = () => {
    stuckTick = false;
    const pinned = getComputedStyle(controls).position === "sticky" && controls.getBoundingClientRect().top <= 0;
    controls.classList.toggle("stuck", pinned);
  };
  const queueStuck = () => { if (!stuckTick) { stuckTick = true; requestAnimationFrame(syncStuck); } };
  addEventListener("scroll", queueStuck, { passive: true });
  addEventListener("resize", queueStuck);
  controls.addEventListener("animationend", queueStuck);   // the reveal transform offsets the bar until it ends
  syncStuck();

  // expand/collapse breakdown rows (mouse + keyboard)
  const toggleRow = tr => {
    const id = tr.dataset.id;
    const opening = openId !== id;
    $$("#rows tr.row[aria-expanded='true']").forEach(x => x.setAttribute("aria-expanded", "false"));
    $$("#rows tr.detail.open").forEach(x => x.classList.remove("open"));
    openId = opening ? id : null;
    if (!opening) return;
    // opening: build the breakdown now (closed rows carry an empty shell), show
    // the provider placeholder, fill it in when the list lands
    const det = $(`tr.detail[data-detail="${CSS.escape(id)}"]`);
    const d = LAST.get(id);
    if (det && d) {
      det.querySelector(".detail-inner").innerHTML = detailMarkup(d);
      det.classList.add("open");
    }
    tr.setAttribute("aria-expanded", "true");
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

/* ---- Hermes Insights import ---------------------------------------------- */
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
  // "total − in − out = cached reads" only holds when we actually found in AND out.
  // Without that split we can't tell cheap cached reads from full-price fresh input,
  // and guessing "it's all cache" understates the bill by an order of magnitude — so
  // bill everything that isn't known output as fresh input, and say so.
  const knownSplit = inp != null && out != null;
  if (knownSplit) {
    base = {
      input:       inp,
      output:      out,
      cache_read:  total != null ? Math.max(0, total - inp - out) : 0,
      cache_write: 0
    };
  } else {
    const o = out ?? 0;
    base = {
      input:       total != null ? Math.max(0, total - o) : (inp ?? 0),
      output:      o,
      cache_read:  0,
      cache_write: 0
    };
  }
  const haveWindow = windowDays != null;      // a detected "Last 0 hours" is not "no window"
  period.dataDays = haveWindow ? Math.max(0.1, Math.round(windowDays * 100) / 100) : 30;
  period.projectDays = 30;
  recalcUsage();
  writeFields();
  writePeriod();
  writeHitRate();
  render();
  flashCosts();
  const s = periodScale();
  const note = haveWindow
    ? `Detected a ${period.dataDays}-day window → scaled ×${(Math.round(s * 100) / 100)} to a 30-day month.`
    : `No “Last N days” line found — assuming ~30 days (no scaling).`;
  const warn = knownSplit ? "" :
    " ⚠ No “in: … / out: …” split found, so everything is costed as fresh input — set the cache hit rate below to model your real split.";
  setPasteMsg(`Loaded ✓ ${note}  ${fmt(usage.input)} in · ${fmt(usage.output)} out · ${fmt(usage.cache_read)} cached / mo${warn}`, !knownSplit);
}

function bindPaste() {
  $("#pasteToggle").addEventListener("click", () => {
    const box = $("#pasteBox");
    box.hidden = !box.hidden;
    $("#pasteToggle").setAttribute("aria-expanded", String(!box.hidden));
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
// quiet auto-refresh every 10 min — skipped while the tab is in the background…
setInterval(() => { if (!document.hidden) load(false); }, REFRESH_MS);
// …so a tab left hidden for an hour comes back stale. Catch up when it returns.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastLiveAt > REFRESH_MS) load(false);
});
