# Dashboard Guide Agent — POC Build Plan

## What this is

A Chrome extension (and later, an embedded script) that teaches people how to use
our company dashboard. A user asks a question in plain English ("how do I add an
order?"), or follows an authored walkthrough, and the agent moves an animated
cursor to the right element, highlights it, and narrates what to do — like Cluely
/ Clicky, but for our dashboard.

The key idea: **flows are written in plain prose, not HTML.** Authors describe a
task the way they'd explain it to a new hire ("Click the New Order button in the
top right, pick a customer, fill in quantity, hit Save"). At runtime the AI maps
that prose to the actual DOM element. No selectors authored by hand. UI changes
don't break flows.

Scope for this POC: **tutorial only — the agent points, highlights, and narrates,
it does not click on the user's behalf.** Internal demo, not published to the
Chrome Web Store.

## Non-goals (explicitly out of scope for the POC)

- No automation / clicking on the user's behalf
- No Cloudflare Worker or backend proxy (each user supplies their own API key)
- No Chrome Web Store publishing
- No multi-tenant auth, logging, or analytics infrastructure
- No embedded-script version yet (extension first; embed is a fast follow)

## Architecture

```
Chrome extension (MV3)
  ├── flows/*.md          authored walkthroughs in plain prose
  ├── flows.json          built from flows/*.md at build time
  ├── DOM distiller        page DOM -> compact JSON of interactive elements
  ├── translator           (step prose + distilled DOM) -> {selector, narration}
  ├── flow player          loops steps: translate -> point + highlight -> Next
  ├── cursor overlay       animated pointer that flies to the target element
  ├── tooltip + highlight  vanilla DOM overlay (ring + positioned tooltip)
  └── options page         user pastes their Anthropic API key once
```

Single Claude call per step. No agent loop, no tool calling, no framework needed.
The substance of the product is the DOM distiller, the translator prompt, and the
cursor/highlight overlay; everything else is plumbing.

### Extension component map

- **manifest.json** (MV3) — declares `host_permissions` for the dashboard origin,
  the side panel, the content script, and the options page.
- **content-script.ts** — injected into the dashboard tab. Owns the page: runs the
  DOM distiller, draws the cursor + highlight + tooltip overlay, listens for the
  user advancing. Talks to the side panel via `chrome.runtime.sendMessage`.
- **sidepanel.html / sidepanel.ts** — the chat UI (Chrome Side Panel API, stays
  open while the user works). Holds the flow player and the conversation log.
- **background.ts** — service worker. Makes the Anthropic calls (keeps the key out
  of page context) and routes messages between side panel and content script.
- **options.html / options.ts** — one-time API key entry, stored in
  `chrome.storage.local`.

## The flow file format

One markdown file per task. Frontmatter for routing, H2 sections for steps. No
selectors, no HTML — just prose.

```markdown
---
id: add-order
title: Add a new order
triggers:
  - add order
  - new order
  - create order
  - how do I make an order
---

# Add a new order

## Step 1
Click the New Order button in the top right of the dashboard.

## Step 2
Pick the customer from the dropdown. If they're not listed, add them first.

## Step 3
Fill in the quantity and click Save.
```

Authors only ever write prose. That makes these files dual-use: they're also
readable docs a new hire could just read top to bottom.

Parsing: `gray-matter` for frontmatter + a small parser for the H2 sections, or a
~20-line regex since the structure is regular. Bundle `flows/*.md` into a
`flows.json` at build time so the extension loads them synchronously.

## The two AI calls

**1. Intent match** (query -> flow id)
Start cheap: string-match the user's query against each flow's `triggers`. Upgrade
to a Claude call (query + list of `{id, title, triggers}` -> best match or "none")
only if the demo shows obvious misses.

**2. Translate** (step prose + distilled DOM -> action)
This is the core. Prompt returns JSON:

```json
{
  "selector": "<CSS selector to highlight, or null>",
  "narration": "<one sentence shown in the tooltip>",
  "confidence": 0.0,
  "reasoning": "<why this element — useful for debugging>",
  "blocker": "<null, or why the element isn't on this page>"
}
```

If `confidence` is low, surface it to the user ("I think you mean this — right?")
rather than silently picking. The `reasoning` field makes live-demo debugging much
easier.

Free-form questions with no matching flow collapse into a single-step translate
call — the question itself becomes the step prose. So we don't have to author
every possible thing someone might ask.

### Translator prompt sketch

```
You are guiding a user through a web dashboard. They are on this page:

URL: {url}
Title: {title}

Interactive elements currently on the page:
{distilled_dom_json}

The user is following this instruction:
"{step_text}"

Return ONLY JSON, no prose, no markdown fences:
{
  "selector": "...",      // CSS selector for the element, or null
  "narration": "...",     // one sentence shown near the element
  "confidence": 0.0,      // 0-1
  "reasoning": "...",     // why you picked this element
  "blocker": null         // or a string if the element isn't on this page
}
```

## The DOM distiller (most important piece)

Raw `outerHTML` is 200–500KB and confuses the model. Instead, walk the DOM and emit
a compact outline of just what matters:

- Interactive elements: `button`, `a`, `input`, `select`, `[role="button"]`,
  `[onclick]`, anything with `data-testid`
- For each: tag, visible text, `data-testid`/`id`/`aria-label`, a CSS path, and
  whether it's currently in the viewport (`getBoundingClientRect`)
- Section headings (`h1`–`h4`, `[role="heading"]`) for structure

Target output ~2–5KB. Quality of this code decides whether the demo feels magical
or shaky. Plan to iterate on it against the real dashboard in devtools.

Pitfalls to handle: skip hidden elements (`offsetParent === null` or
`display:none`), de-duplicate nested clickables (don't emit both a button and the
icon inside it), and for virtualized lists only emit what's rendered.

## The cursor + highlight overlay (Cluely-style)

A full-viewport, `pointer-events: none` overlay layer appended to the page,
holding three things:

1. **Animated cursor** — an absolutely-positioned pointer (SVG or styled div) that
   smoothly tweens from its current position to the center of the target element.
   Use a CSS transition on `transform: translate(x, y)` with an ease-out curve
   (~400–600ms) so it "flies" rather than jumps. A subtle scale/bob on arrival
   sells the effect.
2. **Highlight ring** — a box drawn around the target element's bounding rect
   (4px offset, rounded, soft glow / pulsing animation), recalculated from
   `getBoundingClientRect` whenever the cursor lands.
3. **Tooltip** — a positioned card near the element showing the step narration and
   Prev / Next / Done controls. Flips side if it would overflow the viewport.

Target coordinates come from `getBoundingClientRect()` of the resolved selector —
so unlike Clicky (which uses raw screen coordinates from a screenshot), we point at
real DOM elements and stay accurate even when the layout shifts.

Recompute positions on `scroll` and `resize` (throttled with
`requestAnimationFrame`) so the cursor and ring track the element. If the target is
off-screen, scroll it into view (`scrollIntoView({ behavior: "smooth" })`) before
flying the cursor to it.

## Latency handling

Every step is an LLM call (~1–2s). Two mitigations:

- **Prefetch:** while step N's tooltip is showing, resolve step N+1 in the
  background so it's instant on Next.
- **Cache:** key resolved selectors on `(flow_id, step_index, url_pattern)` so
  re-running a flow is instant after the first pass.

Neither is required for a first working version — add them in polish. While a step
is resolving, show the cursor in a gentle "thinking" idle animation so the wait
doesn't feel dead.

## First real test: guide a Google search

Before touching the company dashboard, validate the entire pipeline against a
public site everyone can reach: walk a user through doing a Google search. It
exercises every part of the system end to end — distiller, translate, cursor
fly-to-element, highlight, narration, advancing steps — with zero internal access
required. If this works, the dashboard is just a different set of selectors.

The test flow, written in the same prose format as any other flow:

```markdown
---
id: google-search
title: Search for something on Google
triggers:
  - search google
  - how do I search
  - google something
---

# Search for something on Google

## Step 1
Click into the search box in the middle of the page.

## Step 2
Type what you're looking for.

## Step 3
Press Enter or click the Google Search button to see results.
```

What it proves at each step:

- **Step 1** — the distiller finds the search input (`textarea[name="q"]` /
  `input[name="q"]`) and the cursor flies to it. Confirms element resolution +
  the fly-to animation on a real page.
- **Step 2** — narration shows; this is a "type" instruction with no single
  clickable target, so it confirms the tooltip handles non-pointing steps
  gracefully (just narrate, maybe highlight the same input).
- **Step 3** — the distiller finds the search button (or the flow accepts Enter),
  confirming multi-candidate disambiguation and end-of-flow handling.

Caveat to expect: Google's markup is heavily obfuscated (random class names,
nested wrappers, sometimes a `textarea` not an `input`). That's actually a *good*
stress test — if the distiller + translate can find the search box on Google, our
own dashboard with stable `data-testid`s will be easy. Run it against
`https://www.google.com` with the extension's `host_permissions` temporarily set
to `https://www.google.com/*`.

Use this as the demo's opening act too: "watch it guide me through Google, then
watch it do the same on our dashboard." Familiar, instantly legible to any
audience.

## Build order

1. **Write the `google-search.md` flow first**, plus 2–3 dashboard flows as pure
   prose. The Google flow is the smoke test that proves the pipeline.
2. **DOM distiller.** Write a first pass, run it in devtools — start on Google,
   then the dashboard — paste output back, tune heuristics until clean and dense.
3. **Translator function.** `(stepText, distilledDom) -> JSON`. One Anthropic call.
   Test standalone against saved DOM snapshots before wiring to UI.
4. **Cursor + highlight + tooltip overlay.** Pure DOM. Get the fly-to-element
   animation feeling smooth against a hardcoded selector before any LLM is involved.
5. **Wire it together.** Pick flow -> loop steps -> translate -> point + highlight
   -> Next.
6. **"Ask anything" path.** Typed question -> one-step translate -> point at element.
7. **Extension scaffolding.** Manifest, content script, side panel, options page,
   message passing.
8. **Demo polish.** Cursor easing, low-confidence UX, "element not on page" state,
   scroll-into-view, the two or three flows that show off the multi-step experience.

## Things that could complicate the build

- **Shadow DOM / web components** — distiller, selector resolution, and the overlay
  must pierce shadow roots and account for their coordinate space.
- **Full page navigations mid-flow** — persist flow progress in `chrome.storage`
  and resume after the content script re-injects on the new page.
- **Cross-origin iframes** — a content script can't reach into them without
  declaring those origins in the manifest and injecting separately; the cursor
  can't be drawn across the iframe boundary either.
- **CSP on the dashboard** — a strict `Content-Security-Policy` can block injected
  styles/scripts; the extension's content script is generally exempt, but verify.
- **High z-index app chrome** — the overlay needs a z-index above everything; watch
  for modals/dropdowns in the dashboard that might sit on top of the cursor.

## Open decisions to lock before starting

- [ ] Dashboard URL pattern for `host_permissions` (e.g. `https://app.company.com/*`)
- [ ] API key via options page (cleaner) vs hardcoded config (faster for POC)
- [ ] Plain TS vs React for the side panel UI (TS is lighter at this scale)
- [ ] Flows bundled at build time vs fetched from a URL (bundled = simpler POC)
- [ ] Intent match: trigger string-match (start here) vs Claude call (upgrade later)
- [ ] Cursor style: realistic pointer vs branded custom shape

## Prerequisites

- Anthropic API key
- Ability to run the extension against the real dashboard (not an inaccessible
  staging clone)
- Confirm dashboard DOM specifics: Shadow DOM usage, iframes, CSP that might block
  injected scripts

## Next concrete step

Start with the Google smoke test, not the dashboard — it derisks everything with
zero access requirements. Open `https://www.google.com`, open devtools, and run
the first pass of the DOM distiller there. Useful first signal: run
`document.querySelectorAll('button, a, input, select, textarea, [role="button"]').length`
on both Google and the dashboard and share the output — that tells us what kind of
HTML we're tuning the distiller against. Once the cursor reliably flies to Google's
search box and walks all three steps, repoint at the dashboard.
