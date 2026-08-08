# Price Lens

**OpenRouter pricing, de-confused.** Price Lens takes the raw
[OpenRouter models API](https://openrouter.ai/models) — where input, output,
cache-read and cache-write are all priced separately — and turns it into a
single number you actually care about: **what your real monthly usage costs on
every model.**

> **Live site: https://extv.github.io/price-lens/**
>
> It's a static page — no build step, no backend, nothing leaves your machine.
> You can also just open `index.html` in any browser.

---

## What it does

- **Costs your real workload.** Enter how many tokens you burn in a month
  (fresh input, output, cached reads, cache writes) and every model in the
  table is re-priced against *your* numbers — not a generic "$/M" sticker.
- **All paid chat-completion models.** 300+ text→text models across every major
  lab — Anthropic, OpenAI, Google, Qwen, Mistral, Meta, DeepSeek, xAI, Cohere,
  Microsoft, NVIDIA, Z.AI, MoonshotAI, MiniMax, Amazon, Perplexity and more.
  Image- and audio-output models are intentionally excluded, as are `:free`
  tiers — their $0 sticker isn't a real price and just crowds out the top of
  every cheapest-first sort.
- **Featured podium.** Three pinned frontier models costed against your usage,
  with the cheapest of the three highlighted.
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
- **Router models can't be costed.** OpenRouter reports `-1` for models like
  `openrouter/fusion` — the price depends on whichever model the request is
  routed to. Those rows are tagged `variable`, show `—` instead of a figure,
  and always sort last rather than pretending to be free.
- Your usage figures stay entirely in your browser — nothing is sent anywhere.

## Project layout

| File           | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `index.html`   | Page markup and controls                                       |
| `app.js`       | Data load, cost engine, filtering/sorting, rendering           |
| `style.css`    | Theme and layout                                               |
| `snapshot.js`  | Offline fallback catalog (used only when the live fetch fails) |

## Running locally

It's a plain static site, so either works:

```sh
# just open the file
open index.html

# …or serve it (avoids any browser file:// quirks)
python3 -m http.server 8000   # then visit http://localhost:8000
```

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
