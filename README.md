# Price Lens

**OpenRouter pricing, de-confused.** Price Lens takes the raw
[OpenRouter models API](https://openrouter.ai/models) — where input, output,
cache-read and cache-write are all priced separately — and turns it into a
single number you actually care about: **what your real monthly usage costs on
every model.**

> **Live site: https://extv.github.io/price-lens/**
>
> It's a static page — no build step, no backend, and your usage figures
> never leave your machine.
> You can also just open `index.html` in any browser.

---

## What it does

- **Costs your real workload.** Enter how many tokens you burn in a month
  (fresh input, output, cached reads, cache writes) and every model in the
  table is re-priced against *your* numbers — not a generic "$/M" sticker.
- **All paid chat-completion models.** 300+ text→text models across every major
  lab — Anthropic, OpenAI, Google, Qwen, Mistral, Meta, DeepSeek, xAI, Cohere,
  Microsoft, NVIDIA, Z.AI, MoonshotAI, MiniMax, Amazon, Perplexity and more.
  Only real, pinnable models: image- and audio-output models are excluded, as
  are `:free` tiers (their $0 sticker isn't a real price), `:batch` variants
  (the same model through the async batch queue at half price — a delivery
  mode, not a model) and everything OpenRouter-specific — the `openrouter/*`
  meta-routers and the `~vendor/x-latest` rolling aliases.
- **Upstream providers per model.** Expand any row to see every provider
  OpenRouter can route that model to — GLM 5.2 has 32 of them — each with its
  own input/output/cache rates, quantization, context, uptime and discount, and
  **your monthly cost on that specific provider**, cheapest first. The catalog
  rate is only the default; the spread between hosts is often 5–10×. Fetched on
  demand when you open a row, then cached.
- **Featured podium.** Three pinned frontier models — Claude Fable 5.1,
  GPT-5.6 Sol and Gemini 3.1 Pro — costed against your usage, with the
  cheapest of the three highlighted, and a bar showing where the money goes.
  Click a card to jump to that model's row. If a pinned id ever leaves the
  catalog, the newest release of that family stands in under its own name.
- **Filter & sort.** Filter by provider (chips are built from the live data —
  the busiest dozen are shown, the rest sit behind a "+N more" toggle), search
  by name/id, and sort by your cost, input $/M, output $/M, context, name, or
  provider.
- **Cache hit-rate modelling.** A slider (plus presets for heavy-agent / mixed
  / low / none) rebalances fresh vs. cached input so you can see how prompt
  caching changes the bill — only for models that actually support it.
- **Period scaling.** Paste a "Last 7 days" usage report and it's scaled up to
  a real 30-day month automatically.
- **Hermes Insights import.** Paste your Insights block and it auto-fills the
  `Tokens: … (in: … / out: …)` figures.
- **Live + offline.** Pricing is fetched live from OpenRouter on load (and
  re-fetched every 10 minutes). If that request fails, it falls back to a
  bundled snapshot so the page always works.

## How pricing is shown

- All rates are list rates and can vary by the provider OpenRouter routes you
  to.
- Cached-read figures assume native prompt caching **where the model supports
  it**; for models without caching, re-sent context (and any "cache write"
  tokens) is billed as fresh input.
- **Routers and aliases are excluded.** OpenRouter reports `-1` for
  `openrouter/auto`, `/fusion`, `/pareto-code` and `/bodybuilder` because you
  pay whatever the model they pick charges, and the `~anthropic/claude-*-latest`
  style aliases are moving pointers rather than models. Neither is something
  you can pin in production, so both are dropped, along with `:batch` variants.
- **Long-context tiers aren't modelled.** Some models (Claude Sonnet 4.5,
  Gemini 3.1 Pro, Qwen 3.6…) bill a higher rate once a single prompt passes a
  threshold, typically 200K tokens. Monthly totals can't know how long each
  request was, so they use the base rate; affected rows carry a **tiered** tag
  and the expanded breakdown spells out the threshold and the higher rates.
- **Per-model rates are the default route.** The headline row shows OpenRouter's
  catalog price; expand it for the real per-provider spread.
- Your usage figures stay entirely in your browser — there is no backend and
  nothing about your workload is uploaded. The page does call OpenRouter for the
  catalog, and expanding a model fetches that model's per-provider pricing, so
  OpenRouter sees which models you look at. The fonts are served by Google
  Fonts, which sees your IP address like any CDN would.

## Project layout

| File                       | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `index.html`               | Page markup and controls                                                |
| `engine.js`                | Cost engine, catalog filters and parsers — pure, shared with the tools  |
| `app.js`                   | State, data load, filtering/sorting, rendering                          |
| `style.css`                | Theme and layout                                                        |
| `snapshot.js`              | Offline fallback catalog (used only when the live fetch fails)          |
| `tools/build-snapshot.mjs` | Regenerates `snapshot.js` from the live API with the same filters       |
| `test/`                    | `node --test` suites for the engine and for site consistency            |
| `.github/workflows/`       | CI (tests on every push) and a weekly snapshot refresh                  |

## Running locally

It's a plain static site, so either works:

```sh
# just open the file
open index.html

# …or serve it (avoids any browser file:// quirks)
python3 -m http.server 8000   # then visit http://localhost:8000
```

There are no dependencies to install. With Node 20+:

```sh
npm test            # engine + site consistency tests
npm run snapshot    # rebuild snapshot.js from the live catalog
```

The snapshot is also rebuilt every Monday by a GitHub Actions workflow, which
commits only when the model data actually changed.

## Found a problem? Open a ticket

If a price looks wrong, a model is missing, something's broken, or you have an
idea — please **[open an issue](../../issues/new/choose)**. Pick the matching
template so we have what we need to act on it:

- 🐞 **Bug report** — something on the page doesn't work.
- 💲 **Model / pricing correction** — a rate is wrong, or a model is
  missing/outdated.
- ✨ **Feature request** — an idea or improvement.

> Not affiliated with OpenRouter. Pricing data comes from OpenRouter's public
> models API.
