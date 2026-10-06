/* =========================================================================
   Price Lens — app logic
   Live OpenRouter pricing → cost your real monthly usage on every model.
   Pure pricing/catalog rules live in engine.js (shared with the snapshot
   builder and the tests); this file is state, fetch and rendering.
   ========================================================================= */

"use strict";

const {
  fmt, esc, money, perM, ctxFmt, parseNum,
  cost, tierOf, costBarWidth, providerOf, hasVision, pick, cmpVersion,
  parseUsage
} = window.PriceLens;

const API = "https://openrouter.ai/api/v1/models";
const REFRESH_MS = 10 * 60 * 1000;
const STORAGE_KEY = "pricelens-v3";
const MAX_COMPARE = 4;

// Generic sample workload so the page is alive on first load.
// Replace via the field inputs or by pasting your own Hermes Insights block.
const DEFAULTS = {
  input:       20000000,   // fresh / uncached prompt
  output:      3000000,    // completion
  cache_read:  60000000,   // re-sent cached context  (= total − in − out)
  cache_write: 0
};

// Typical heavy agent: bootstrap re-cache + heartbeat + tool loops.
const AGENT_PRESET = {
  input:       8200000,
  output:      2100000,
  cache_read:  84000000,
  cache_write: 9000000
};

const IMPORT_HINTS = {
  openclaw: "Reads 🧮 Tokens + 🗄️ Cache from /status, a “Last N days” line, and usage.cost JSON.",
  hermes:   "Reads Tokens: <total> (in: … / out: …) from a Hermes Insights block.",
  auto:     "Tries OpenClaw formats first (they carry the cache split), then Hermes Insights."
};

// Always-shown hero trio: the newest release of each family (`rx` or a listed
// id). A pin used to win outright, so GPT-5.6 Sol stayed featured after GPT-6
// Sol shipped. The listed ids now only break version ties, in order, and give
// the card its short label; anything else is shown under its own name.
const FEATURED = [
  { ids: ["anthropic/claude-fable-5.1"],                                              rx: /^anthropic\/claude-fable-[\d.]+$/,       label: "Fable 5.1" },
  { ids: ["openai/gpt-6-sol"],                                                        rx: /^openai\/gpt-[\d.]+-sol$/,               label: "GPT-6 Sol" },
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
  upstage: "Upstage", "ibm-granite": "IBM", sakana: "Sakana", xiaomi: "Xiaomi", meituan: "Meituan",
  kwaipilot: "Kwaipilot", poolside: "Poolside", writer: "Writer", bytedance: "ByteDance",
  thinkingmachines: "Thinking Machines", "aion-labs": "AionLabs"
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
let compareIds = [];                   // pinned model ids, in the order the user picked them
let compareOpen = false;               // expanded compare workspace
let compareNotice = "";
let importSrc = "openclaw";
let suppressUrlWrite = false;

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
    const rank = id => { const i = spec.ids.indexOf(id); return i < 0 ? spec.ids.length : i; };
    const d = all.filter(x => spec.rx.test(x.m.id) || spec.ids.includes(x.m.id))
                 .sort((a, b) => cmpVersion(b.m.id, a.m.id) || rank(a.m.id) - rank(b.m.id))[0] || null;
    return { spec, d, label: d && spec.ids.includes(d.m.id) ? spec.label : d ? d.name : spec.label };
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
        <div class="pod-rank"><span class="pod-medal">★</span> featured${best ? `<span class="pod-flag">cheapest of ${costs.length}</span>` : ""}</div>
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

/* ---- compare ------------------------------------------------------------- */
// Pinned models live by id, so they survive a filter change — but they must not
// outlive the catalog: a model OpenRouter drops has no price to compare.
function syncCompareWithCatalog(all) {
  const live = new Set(all.map(d => d.m.id));
  compareIds = compareIds.filter(id => live.has(id));
  if (!compareIds.length) compareOpen = false;
}

function selectedCompare(all) {
  const byId = new Map(all.map(d => [d.m.id, d]));
  return compareIds.map(id => byId.get(id)).filter(Boolean);
}

function toggleCompare(id) {
  const i = compareIds.indexOf(id);
  if (i >= 0) {
    compareIds.splice(i, 1);
    compareNotice = "";
  } else if (compareIds.length >= MAX_COMPARE) {
    compareNotice = `Compare up to ${MAX_COMPARE} models — remove one to add another.`;
  } else {
    compareIds.push(id);
    compareNotice = "";
  }
  render();
}

// "unknown" rows (variable pricing → NaN total) can never win a cost comparison.
// Among priced rows, a genuinely $0-rate model is preferred *after* the paid ones:
// the table tags those rows "free", and render()/renderDash already treat the
// cheapest real option as total > 0. A pinned $0 model only wins the badge when
// nothing paid is pinned, so the panel never contradicts the dashboard.
function compareWinners(selected) {
  const priced = selected.filter(d => isFinite(d.c.total));
  const paid = priced.filter(d => d.c.total > 0);
  const pickBest = (list, score) =>
    list.length ? list.reduce((a, b) => score(a) <= score(b) ? a : b) : null;
  const cheapest = pickBest(paid.length ? paid : priced, d => d.c.total);
  const largestCtx = pickBest(selected, d => -(d.m.context_length || 0));
  const lowestInput = pickBest(paid.length ? paid : priced, d => d.c.inR);
  return {
    cheapestId: cheapest && cheapest.m.id,
    contextId: largestCtx && largestCtx.m.id,
    inputId: lowestInput && lowestInput.m.id
  };
}

function compareSummary(selected, winners) {
  const cheapest = selected.find(d => d.m.id === winners.cheapestId);
  const context = selected.find(d => d.m.id === winners.contextId);
  const cacheCount = selected.filter(d => d.c.hasCache).length;
  const parts = [];
  if (cheapest) parts.push(`Cheapest: <b>${esc(cheapest.name)}</b> ${money(cheapest.c.total)}/mo`);
  if (context) parts.push(`Largest context: <b>${esc(context.name)}</b> ${ctxFmt(context.m.context_length)}`);
  parts.push(`${cacheCount}/${selected.length} cache-capable`);
  return parts.join(" · ");
}

function winnerTags(d, winners) {
  const tags = [];
  if (d.m.id === winners.cheapestId) tags.push("cheapest");
  if (d.m.id === winners.contextId) tags.push("largest context");
  if (d.m.id === winners.inputId) tags.push("lowest input");
  if (d.c.hasCache) tags.push("cache");
  if (hasVision(d.m)) tags.push("vision");
  if (d.c.unknown) tags.push("variable pricing");
  return tags.map(t => `<span class="compare-tag">${esc(t)}</span>`).join("");
}

// Same four tones as the podium split and the usage-field markers, so a pinned
// card and its table row read as the same model's money.
function costStack(c) {
  if (c.unknown) return `<div class="compare-stack no-cost" aria-label="Pricing varies by routed provider"></div>`;
  const parts = [
    { label: "fresh", value: c.cIn, cls: "tone-1" },
    { label: "output", value: c.cOut, cls: "tone-2" },
    { label: "cache", value: c.cCr, cls: "tone-3" },
    { label: "write", value: c.cCw, cls: "tone-4" }
  ].filter(p => p.value > 0);
  if (!parts.length || c.total <= 0) return `<div class="compare-stack no-cost" aria-label="No billable cost"></div>`;
  return `<div class="compare-stack" aria-label="Cost breakdown">${parts.map(p =>
    `<span class="seg ${p.cls}" style="width:${Math.max(3, p.value / c.total * 100).toFixed(1)}%" title="${esc(p.label)} ${money(p.value)}"></span>`
  ).join("")}</div>`;
}

function compareCard(d, winners) {
  const c = d.c;
  return `
    <article class="compare-card">
      <div class="compare-model-head">
        <span class="m-dot" style="--c:${esc(d.meta.color)}"></span>
        <div class="m-copy">
          <div class="compare-provider">${esc(d.meta.label)}</div>
          <h3>${esc(d.name)}</h3>
          <p>${esc(d.m.id)}</p>
        </div>
      </div>
      <div class="compare-total">${money(c.total)}<small>/mo</small></div>
      <div class="compare-tags">${winnerTags(d, winners)}</div>
      ${costStack(c)}
      <dl class="compare-facts">
        <div><dt>Context</dt><dd>${ctxFmt(d.m.context_length)}</dd></div>
        <div><dt>Input</dt><dd>${perM(c.inR)}/M</dd></div>
        <div><dt>Output</dt><dd>${perM(c.outR)}/M</dd></div>
        <div><dt>Cache read</dt><dd>${c.hasCache ? `${perM(c.crR)}/M` : "input rate"}</dd></div>
      </dl>
      <div class="compare-breakdown">
        <span>Fresh ${money(c.cIn)}</span>
        <span>Output ${money(c.cOut)}</span>
        <span>Cache ${money(c.cCr)}</span>
      </div>
      <button class="compare-remove" type="button" data-compare-remove="${esc(d.m.id)}">Remove</button>
    </article>`;
}

function renderCompare(all) {
  syncCompareWithCatalog(all);
  const selected = selectedCompare(all);
  const hasSelection = selected.length > 0;
  const drawer = $("#compareDrawer");
  const workspace = $("#compareWorkspace");
  // The pinned drawer only earns its space while picking. Once the workspace is
  // expanded it is redundant, and as a fixed element it floats over the cards'
  // Remove buttons — so it stands down and the workspace owns the screen.
  drawer.hidden = !hasSelection || compareOpen;
  workspace.hidden = !(hasSelection && compareOpen);
  document.body.classList.toggle("compare-active", hasSelection && !compareOpen);
  if (!hasSelection) {
    drawer.innerHTML = "";
    workspace.innerHTML = "";
    return;
  }

  const winners = compareWinners(selected);
  drawer.innerHTML = `
    <div class="compare-drawer-inner">
      <div class="compare-drawer-main">
        <div class="compare-eyebrow">${selected.length}/${MAX_COMPARE} pinned</div>
        <div class="compare-drawer-summary">${compareSummary(selected, winners)}</div>
        ${compareNotice ? `<div class="compare-notice">${esc(compareNotice)}</div>` : ""}
      </div>
      <div class="compare-pills">
        ${selected.map(d => `
          <button class="compare-pill" type="button" data-compare-remove="${esc(d.m.id)}" title="Remove ${esc(d.name)}">
            <span class="m-dot" style="--c:${esc(d.meta.color)}"></span>${esc(d.name)}<span aria-hidden="true">×</span>
          </button>`).join("")}
      </div>
      <div class="compare-actions">
        <button class="btn-load compare-open" type="button" data-compare-action="open" ${selected.length < 2 ? "disabled" : ""}>Compare</button>
        <button class="btn-reset" type="button" data-compare-action="clear">Clear</button>
      </div>
    </div>`;

  if (!compareOpen) {
    workspace.innerHTML = "";
    return;
  }

  workspace.innerHTML = `
    <div class="compare-head">
      <div>
        <p class="compare-cap">Pinned model comparison</p>
        <h2>${selected.length} models, your usage</h2>
        <p>${compareSummary(selected, winners)}</p>
      </div>
      <div class="compare-head-actions">
        <button class="btn-reset" type="button" data-compare-action="close">Collapse</button>
        <button class="btn-reset" type="button" data-compare-action="clear">Clear</button>
      </div>
    </div>
    <div class="compare-card-grid">
      ${selected.map(d => compareCard(d, winners)).join("")}
    </div>`;
}

function row(d, scale) {
  const c = d.c;
  const w = costBarWidth(c.total, scale.lo, scale.hi);
  const free = c.inR === 0 && c.outR === 0;   // a $0 rate, not a $0 bill from zero usage
  const tier = tierOf(d.m);
  const id = esc(d.m.id), open = openId === d.m.id;
  const pinned = compareIds.includes(d.m.id);
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
          <div class="m-copy">
            <div class="m-title">${esc(d.name)}${tags}</div>
            <div class="m-id">${id}</div>
            <div class="m-prov">${esc(d.meta.label)}</div>
          </div>
          <button type="button" class="pin-btn ${pinned ? "on" : ""}" data-compare-id="${id}"
                  aria-pressed="${pinned}"
                  aria-label="${pinned ? "Remove from comparison" : "Add to comparison"}: ${esc(d.name)}">
            <span aria-hidden="true">${pinned ? "✓" : "+"}</span>
          </button>
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
    // One provider can list several endpoints — "openai/flex" (half price, slow),
    // "openai/fast" (2×), "azure/us" (regional, +10%). Without the variant they
    // read as duplicate rows at different prices.
    const variant = String(e.tag || "").split("/").slice(1).join("/");
    return `
      <tr class="${best ? "prov-best" : ""}">
        <td class="prov-nm">${esc(e.provider_name || e.name || "—")}${
          variant ? `<span class="tag">${esc(variant)}</span>` : ""}${
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
  renderCompare(all);
  renderDash(all);
  persistState();

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
  // Leave the box being typed in alone: rewriting it mid-edit snapped an emptied
  // field back to 30 (backspace then "7" gave "307") and ate a trailing "." so
  // decimals couldn't be entered. It is normalised on blur instead.
  const act = document.activeElement;
  if (act !== $("#p_data")) $("#p_data").value = period.dataDays;
  if (act !== $("#p_proj")) $("#p_proj").value = period.projectDays;
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
// This freezes the current monthly numbers as the new base and drops scaling so
// the split is literal — but if the data came from a shorter window (a real
// 7-day report scaled ×4.29), that provenance vanishes silently. Record it so
// the hint can say so instead of the multiplier just flipping to ×1.
let periodDropped = 1;
function applyHit(rate) {
  const total = usage.input + usage.cache_read;
  const cached = Math.round(total * rate);
  const s = periodScale();
  if (Math.abs(s - 1) > 0.001) periodDropped = s;
  base = { ...usage };
  period.dataDays = period.projectDays;
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
  // If a drag replaced a scaled projection, say what happened to the window.
  const dropped = periodDropped > 1.001
    ? ` <b>⚠</b> Your ${periodDropped.toFixed(2)}× projection was baked in — the figures above are now literal monthly counts.`
    : "";
  $("#hitHint").innerHTML =
    `→ <b>${fmt(usage.cache_read)}</b> cached read · <b>${fmt(usage.input)}</b> fresh input / ${period.projectDays}-day mo. ` +
    `Only changes cost for cache-capable models — Anthropic needs explicit cache breakpoints; OpenAI/Gemini/DeepSeek auto-cache.` + dropped;
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
    periodDropped = 1;
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
  for (const sel of ["#p_data", "#p_proj"]) {
    $(sel).addEventListener("input", upd);
    $(sel).addEventListener("blur", () => writePeriod());
  }
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
    const pin = e.target.closest("[data-compare-id]");
    if (pin) {                       // pinning must not also open the row's breakdown
      e.stopPropagation();
      toggleCompare(pin.dataset.compareId);
      return;
    }
    const tr = e.target.closest("tr.row"); if (tr) toggleRow(tr);
  });
  $("#rows").addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest("[data-compare-id]")) return;   // the button handles its own activation
    const tr = e.target.closest("tr.row"); if (!tr) return;
    e.preventDefault();
    toggleRow(tr);
  });

  // pinned-model drawer + workspace (open / collapse / clear / remove)
  const compareClick = e => {
    const remove = e.target.closest("[data-compare-remove]");
    if (remove) {
      compareIds = compareIds.filter(id => id !== remove.dataset.compareRemove);
      compareNotice = "";
      render();
      return;
    }
    const action = e.target.closest("[data-compare-action]");
    if (!action) return;
    if (action.dataset.compareAction === "open") {
      compareOpen = true;
      compareNotice = "";
      render();
      requestAnimationFrame(() => $("#compareWorkspace").scrollIntoView({
        behavior: REDUCED && REDUCED.matches ? "auto" : "smooth", block: "start"
      }));
    } else if (action.dataset.compareAction === "close") {
      compareOpen = false;
      render();
    } else if (action.dataset.compareAction === "clear") {
      compareIds = [];
      compareOpen = false;
      compareNotice = "";
      render();
    }
  };
  $("#compareDrawer").addEventListener("click", compareClick);
  $("#compareWorkspace").addEventListener("click", compareClick);
}

/* ---- usage import -------------------------------------------------------- */
function setPasteMsg(text, isErr) {
  const el = $("#pasteMsg");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

function applyImportedUsage(parsed) {
  base = {
    input: parsed.input,
    output: parsed.output,
    cache_read: parsed.cache_read,
    cache_write: parsed.cache_write
  };
  // A detected "Last 0 hours" is a window, not a missing one.
  const haveWindow = parsed.windowDays != null;
  period.dataDays = haveWindow ? Math.max(0.1, Math.round(parsed.windowDays * 100) / 100) : 30;
  period.projectDays = 30;
  recalcUsage();
  writeFields();
  writePeriod();
  writeHitRate();
  render();
  flashCosts();
  persistState();

  const s = periodScale();
  const srcLabel = parsed.source === "openclaw-json" ? "OpenClaw JSON"
    : parsed.source === "openclaw" ? "OpenClaw /status"
    : "Hermes Insights";
  const note = haveWindow
    ? `Detected a ${period.dataDays}-day window → scaled ×${(Math.round(s * 100) / 100)} to a 30-day month.`
    : `No “Last N days” line found — assuming ~30 days (no scaling).`;
  // "total − in − out = cached reads" only holds when the in/out split was real.
  // Otherwise we can't tell cheap cached reads from full-price fresh input, and
  // guessing "all cache" understates the bill by an order of magnitude.
  const warn = parsed.knownSplit === false
    ? " ⚠ No cache split found, so everything is costed as fresh input — set the cache hit rate below to model your real split."
    : "";
  setPasteMsg(`Loaded ✓ ${srcLabel} · ${note}  ${fmt(usage.input)} in · ${fmt(usage.output)} out · ${fmt(usage.cache_read)} cached / mo${warn}`, !parsed.knownSplit);
}

function loadImport() {
  const text = $("#pasteArea").value;
  const parsed = parseUsage(text, importSrc);
  if (!parsed) {
    const hint = importSrc === "hermes"
      ? "Couldn't find a “Tokens: … (in: … / out: …)” line — paste the full Insights block."
      : "Couldn't parse that — try /status (🧮 Tokens + 🗄️ Cache lines), a “↕️ in/out” footer, or usage.cost JSON.";
    setPasteMsg(hint, true);
    return;
  }
  applyImportedUsage(parsed);
}

function writeImportHint() {
  const el = $("#importHint");
  if (el) el.textContent = IMPORT_HINTS[importSrc] ?? "";
  const ph = {
    openclaw: "Paste OpenClaw /status output here.\n\n🧮 Tokens: 8.2m in / 2.1m out\n🗄️ Cache: 91% hit · 84m cached, 9m new\n\nAlso accepts /usage cost footers and usage.cost JSON.",
    hermes: "Paste your Hermes Insights output here.\nThe line it reads is:  Tokens: 331,234,491 (in: 56,828,463 / out: 1,669,359)\n→ in = fresh input · out = output · (total − in − out) = cached reads.",
    auto: "Paste any supported usage report — /status, /usage cost, JSON, or Hermes Insights."
  }[importSrc];
  if (ph) $("#pasteArea").placeholder = ph;
}

function bindImport() {
  $("#pasteToggle").addEventListener("click", () => {
    const box = $("#pasteBox");
    box.hidden = !box.hidden;
    $("#pasteToggle").setAttribute("aria-expanded", String(!box.hidden));
    if (!box.hidden) { writeImportHint(); $("#pasteArea").focus(); }
  });
  $("#importTabs").addEventListener("click", e => {
    const tab = e.target.closest(".import-tab"); if (!tab) return;
    importSrc = tab.dataset.src;
    $$("#importTabs .import-tab").forEach(t => {
      const on = t === tab;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
    });
    writeImportHint();
    persistState();
  });
  $("#pasteLoad").addEventListener("click", loadImport);
  $("#pasteArea").addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); loadImport(); }
  });
  writeImportHint();
}

function applyPreset(preset, label) {
  base = { ...preset };
  period = { dataDays: 30, projectDays: 30 };
  recalcUsage();
  writeFields();
  writePeriod();
  writeHitRate();
  render();
  flashCosts();
  persistState();
  setPasteMsg(`Loaded ✓ ${label}`, false);
}

function bindPresets() {
  $("#presetBtn").addEventListener("click", () => {
    applyPreset(AGENT_PRESET, "heavy-agent preset — 8.2m in / 2.1m out / 84m cached reads / 9m writes");
  });
}

/* ---- dashboard + persistence --------------------------------------------- */
function renderDash(all) {
  const dash = $("#dash");
  if (!dash) return;
  const paid = all.filter(d => isFinite(d.c.total) && d.c.total > 0)
                  .sort((a, b) => a.c.total - b.c.total);
  if (!paid.length) { dash.hidden = true; return; }
  dash.hidden = false;

  const cheapest = paid[0];
  const priciest = paid[paid.length - 1];
  const median = paid[Math.floor(paid.length / 2)];
  const hr = Math.round(hitRate() * 100);
  const cacheCapable = all.filter(d => d.c.hasCache).length;

  $("#dashCheapest").innerHTML =
    `<span class="dash-k">Cheapest</span><span class="dash-v">${money(cheapest.c.total)}<small>/mo</small></span>` +
    `<span class="dash-s">${esc(cheapest.name)}</span>`;
  $("#dashSpread").innerHTML =
    `<span class="dash-k">Cost spread</span><span class="dash-v">${money(priciest.c.total - cheapest.c.total)}</span>` +
    `<span class="dash-s">${money(cheapest.c.total)} → ${money(priciest.c.total)} across ${paid.length} models</span>`;
  $("#dashCache").innerHTML =
    `<span class="dash-k">Your cache hit</span><span class="dash-v">${hr}%</span>` +
    `<span class="dash-s">${cacheCapable} of ${all.length} models support native caching</span>`;
  $("#dashModels").innerHTML =
    `<span class="dash-k">Median model</span><span class="dash-v">${money(median.c.total)}<small>/mo</small></span>` +
    `<span class="dash-s">${all.length} priced models in the catalog</span>`;
}

/* State is saved twice on purpose: localStorage restores your own last visit,
   and the URL hash is what a Share link carries. The hash wins on load so a
   link someone sent you isn't overwritten by your own stale session. */
function packState() {
  return { base, period, filterProv, query, sortMode, compareIds, compareOpen, importSrc };
}

function unpackState(s) {
  if (!s || typeof s !== "object") return;
  if (s.base) base = { ...DEFAULTS, ...s.base };
  if (s.period) period = { dataDays: 30, projectDays: 30, ...s.period };
  if (s.filterProv) filterProv = s.filterProv;
  if (typeof s.query === "string") query = s.query;
  if (s.sortMode) sortMode = s.sortMode;
  if (Array.isArray(s.compareIds)) compareIds = compareIds.concat(s.compareIds).slice(0, MAX_COMPARE);
  if (typeof s.compareOpen === "boolean") compareOpen = s.compareOpen;
  if (IMPORT_HINTS[s.importSrc]) importSrc = s.importSrc;
}

function persistState() {
  if (suppressUrlWrite) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(packState())); } catch { /* private mode / quota */ }
  writeUrl();
}

function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) unpackState(JSON.parse(raw));
  } catch { /* corrupt entry — fall back to defaults */ }
}

function encodeUrlState() {
  const parts = [
    `u=${[base.input, base.output, base.cache_read, base.cache_write].join(",")}`,
    `pd=${period.dataDays}`, `pp=${period.projectDays}`
  ];
  if (compareIds.length) parts.push(`c=${compareIds.map(encodeURIComponent).join(",")}`);
  if (filterProv !== "all") parts.push(`p=${encodeURIComponent(filterProv)}`);
  if (query) parts.push(`q=${encodeURIComponent(query)}`);
  if (sortMode !== "cost-asc") parts.push(`s=${sortMode}`);
  if (compareOpen) parts.push("co=1");
  return "#" + parts.join("&");
}

function readUrlState() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  if (![...params.keys()].length) return false;
  const u = params.get("u");
  if (u) {
    const [inp, out, cr, cw] = u.split(",").map(n => parseNum(n) || 0);
    base = { input: inp, output: out, cache_read: cr, cache_write: cw };
  }
  if (params.has("pd")) period.dataDays = Math.max(0.1, parseNum(params.get("pd")) || 30);
  if (params.has("pp")) period.projectDays = Math.max(0.1, parseNum(params.get("pp")) || 30);
  if (params.has("c")) compareIds = params.get("c").split(",").filter(Boolean).slice(0, MAX_COMPARE);
  if (params.has("p")) filterProv = params.get("p");
  if (params.has("q")) { query = params.get("q"); $("#search").value = query; }
  if (params.has("s")) { sortMode = params.get("s"); $("#sort").value = sortMode; }
  compareOpen = params.has("co");
  return true;
}

function writeUrl() {
  if (suppressUrlWrite) return;
  const next = encodeUrlState();
  if (location.hash !== next) history.replaceState(null, "", location.pathname + location.search + next);
}

function bindShare() {
  $("#shareBtn").addEventListener("click", async () => {
    // location.origin is the literal string "null" on file:// — build from href
    // so a locally opened page still produces a link that opens the same page.
    const url = location.href.split("#")[0] + encodeUrlState();
    try {
      await navigator.clipboard.writeText(url);
      setPasteMsg("Share link copied ✓ — it carries your usage, filters and pinned models.", false);
    } catch {
      prompt("Copy this link:", url);
    }
  });
}

/* ---- boot ---------------------------------------------------------------- */
// Restore before the first render: a hash first (a link someone sent you),
// otherwise your own last session. Suppress writes until the restored state is
// applied, or the restore itself would overwrite both stores.
suppressUrlWrite = true;
if (!readUrlState()) loadPersistedState();
recalcUsage();
writeFields();
writePeriod();
writeHitRate();
suppressUrlWrite = false;
bindUsage();
bindPeriod();
bindHit();
bindControls();
bindImport();
bindPresets();
bindShare();
load(false);
// quiet auto-refresh every 10 min — skipped while the tab is in the background…
setInterval(() => { if (!document.hidden) load(false); }, REFRESH_MS);
// …so a tab left hidden for an hour comes back stale. Catch up when it returns.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - lastLiveAt > REFRESH_MS) load(false);
});
