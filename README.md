# Dashboard Guide Agent

A Chrome MV3 extension that teaches people how to use a web app. The user asks
a question in plain English ("how do I add an order?") — or picks a pre-authored
walkthrough — and an animated cursor flies to the right element, draws a glowing
ring around it, and pops a tooltip explaining what to do.

This is the POC build described in [PLAN.md](./PLAN.md). It is **tutorial only**:
the agent points, highlights, and narrates. It never clicks for you.

## What you need

- Chrome (or any Chromium ≥ 114 with `chrome.sidePanel` support)
- A DeepSeek API key (the user supplies their own — there is no backend)

## Install (2 minutes)

1. Go to the [Releases](../../releases) page and download `dashboard-guide.zip`
   from the latest release.
2. Unzip it into a permanent folder (do **not** delete the folder afterwards —
   Chrome reads the files live from disk).
3. Open `chrome://extensions`.
4. Toggle **Developer mode** on (top right).
5. Click **Load unpacked** and pick the unzipped folder.
6. Click the extension's puzzle-piece icon and pin **Dashboard Guide Agent**.

To update later: download the new zip, unzip over the same folder (or into a
new one and re-pick it via **Load unpacked**), then hit the reload icon on
the extension card.

### Build from source instead

If you'd rather build it yourself (Node ≥ 18 required):

```bash
npm install
npm run build      # outputs dist/
```

Then **Load unpacked** → pick `dist/`. `npm run release` rebuilds and zips
`dist/` into `dashboard-guide.zip` for distribution.

## Drop in your DeepSeek API key

1. Get a key at [platform.deepseek.com](https://platform.deepseek.com/) → **API Keys** → Create
2. Right-click the extension icon → **Options** (or open the side panel and
   click **Settings**)
3. Paste your key (`sk-...`)
4. Pick a model:
   - **`deepseek-v4-flash`** (default) — 1M context window, 384K max output,
     fast. Plenty for navigation.
   - **`deepseek-v4-pro`** — smartest variant. Slower, more thorough reasoning.
   - **`deepseek-chat` / `deepseek-reasoner`** — legacy aliases. Kept for
     back-compat with older configs.
5. Pick **Thinking mode**:
   - **enabled** (default) — extended reasoning, recommended
   - **disabled** — faster + cheaper
6. **Reasoning effort** (when thinking is on): `high` (default) or `max` for
   deepest reasoning at higher cost.
7. **Save**, then **Test connection** to confirm.

The key lives in `chrome.storage.local` on this machine only. It is sent to
`https://api.deepseek.com` directly from the extension's service worker and
nowhere else.

## Use it

1. Open any normal site — start with `https://www.google.com` (the smoke test)
2. Click the extension's toolbar icon → side panel opens
3. Two ways to drive the guide:
   - **Click a flow card** in the side panel to run a specific authored flow.
   - **Drag a `.md` file** onto the drop zone to add your own flow at runtime
     — no rebuild, persists in `chrome.storage.local`.
4. Watch the cursor fly. Either click the highlighted element (or press Enter
   if it's an input) to auto-advance, or hit **Next** in the tooltip.
5. **A spinner shows up between steps.** That's the agent re-checking the page
   state and running the multi-agent pipeline (state assessor + per-step +
   free-form reasoners, in parallel). Once the DOM has been still for half a
   second and the LLMs have voted, the tooltip flips back to the next step.
6. **The agent auto-reacts to live page changes.** While the overlay is up,
   the content script watches for DOM mutations and value changes. If you
   type into a search box, focus another input, or the page mutates on its
   own, the agent re-runs the current step against the new state — no
   manual click needed.
7. **Multi-pick steps.** When a step says "click one of the objectives" and
   the page has several equivalent options, the agent draws a softer
   dashed ring around each. Pick any of them — auto-advance fires for any
   highlighted element.
8. **Drag the tooltip.** If it covers what you need to see, grab the
   tooltip header and drop it anywhere. It stays where you put it for the
   rest of the flow.
9. **Correct the agent.** Click the orange **Correct Agent If Wrong**
   button when the agent picks the wrong thing. Chat opens. Three terminal
   buttons:
   - **Send** — type the correction ("no, the green one on the right, not
     the orange one in the dialog"). The agent acts as an **assessor** —
     it confirms understanding and asks if it has it right. It never tells
     you what to click. Argue back-and-forth as much as you want.
   - **Got it ✓** — once you and the agent are aligned, click this to
     freeze agreement. Send + textarea disable; Apply enables. (You can
     also just type "yes" — the assessor flips to agreed automatically.)
   - **Apply** — fires the rule distillation: 0–3 durable rules extracted
     from the conversation + the live DOM, appended to the flow's
     `learnedRules`, **persisted into the flow's markdown** (if it's one
     of your user flows — bundled flows stay ephemeral), then the current
     step re-runs with the new rules applied. Chat clears.
   - **← Back** — bail out of chat without applying. Keeps the conversation
     for next time you reopen.
   Page-state watcher is suppressed while chat is open so a stray edit on
   the page doesn't kick off a step rerun mid-correction.
10. **Close anytime.** Hit the **×** in the tooltip header to end the flow at
    any step. Cancels any in-flight LLM calls immediately.
11. **Switching flows reloads the tab.** Clicking a different flow card while
    one is running cancels the current flow, hard-reloads the tab for a
    clean page state, then starts the new flow.

On a fresh install, reload the tab once so the content script is injected.

## Add your own flow (no rebuild needed)

Drag one or more `.md` files onto the **Drop a .md file here** zone at the
top of the side panel, or click **Choose file…** to pick them. While the
drop zone is busy you'll see a spinner labelled **Normalising N flows with
agent…** — that's the **ingestion agent** rewriting your raw markdown into
canonical flow form before saving:

- Splits mashed-together actions ("Click edit icon, click Add KR") into
  separate `## Step N` entries.
- Extracts navigation steps ("Navigate to https://app.example.com/login")
  into a host-wildcard `url:` glob and drops the navigate step (the user
  is already on the host when the flow runs).
- Generates `id` (from the filename, so different files always get
  different ids — no overwrite when titles collide), `title`, `goal`, and
  2–4 `triggers`.
- Picks `mode` (scripted vs agent) based on input shape.
- Multiple files ingest **fully in parallel** — N files = ~1 LLM round-trip
  wall-clock, not N×.

The normalised flow shows up immediately under **Your flows** and survives
Chrome restarts (persisted to `chrome.storage.local`). Click the **×** on
any user flow to delete it.

If the ingestion agent fails (no API key, timeout, etc.) the raw markdown
gets saved as-is and the parser falls back to agent mode using the body as
hints, so a runnable flow is always produced.

The bundled flows shipped with the extension (Google search, Wikipedia,
GitHub issue, add-order) live under `flows/`; those are starter examples that
re-bundle on `npm run build`. You don't need to touch them to add your own.

### Scripted mode — explicit steps

```markdown
---
id: my-scripted-flow
title: My walkthrough
url: https://app.company.com/*    # glob — flow refuses to run on any other URL
triggers:
  - do the thing
  - how do I X
---

## Step 1
Click the big blue button at the top right.

## Step 2
Type a name into the field that appears.

## Step 3
Hit Save.
```

Each step runs a **multi-agent pipeline in parallel** (one call wall-clock):

- a **state assessor** asks "where in the walkthrough is the user right now?"
- one **per-step reasoner per step** evaluates "does my assigned step apply to
  the live page? if yes, which element?"
- a **free-form page reasoner** ignores all the step text and picks what it
  thinks is the best next click from the page alone
- a **local orchestrator** picks whichever has highest confidence (step
  vs invented). Ties go to the step-following pick (docs win on equal
  evidence). All candidates show up in the side-panel activity log.

So if the docs say "click Issues tab" but the user is already on the new-issue
form (because they got there a different way), the state assessor fast-forwards
the pointer and the free-form reasoner suggests "fill the title field" — the
orchestrator picks the higher-confidence move instead of dumbly pointing back
at the Issues tab.

### Agent mode — abstract goal, no scripted steps

For tasks where you don't want to hand-author every step, write a goal and
let the agent figure out the click sequence itself:

```markdown
---
id: my-agent-flow
title: Add a new order
url: https://app.company.com/*
mode: agent
goal: Add a new order to the system and land on the order detail page.
triggers:
  - add order
  - new order
---

Customers are picked from the "Customer" dropdown — start typing the customer
name to filter. Quantity must be greater than zero. The "Save" button is in
the top-right and is only enabled once required fields are filled.
```

Each iteration runs a **two-reasoner pipeline in parallel**:

- a **page-only reasoner** ignores all docs and picks the most natural next
  click from the live page + goal + history
- a **docs reasoner** maps the author hints + knowledge base onto the live
  page
- the local orchestrator picks the higher-confidence one; ties favour the
  page-only pick (live-grounded). Both candidates show up in the activity
  log so you can see exactly when the agent overrode the docs.

The body prose (after the frontmatter) is fed to the docs reasoner as
**hints** on every iteration — useful for app-specific quirks the agent
couldn't infer from the DOM.

The ring colour tracks confidence:

- **Green** — confidence ≥ 0.75 (agent is sure)
- **Amber** — confidence ≥ 0.5  (reasonable guess)
- **Red**   — confidence <  0.5  (agent is unsure; tooltip chip also turns amber)

Agent loops cap at **20 iterations** to prevent runaway calls. The agent ends
the flow itself by returning `done: true` when the goal is achieved.

### Next/Prev override

Next/Prev are explicit user moves and beat the state assessor's read of the
page. With one safety net:

- If the assessor says you're **still on the current step** when you click
  Next, the first click is refused with a warning ("Page still looks like
  step N — click Next again to skip ahead"). A second Next click forces
  the advance.
- If the assessor sees the page is **already past** the current step, Next
  just advances normally — no two-click gate.
- If you override and the new step turns out to disagree with the page,
  the highlight on that next step is shown but confidence is capped (red
  ring) and the tooltip warns you the page may not be ready.

Prev is always honoured immediately.

### Form-state awareness

The model knows about live input state:

- **Focused ≠ done.** A focused-but-empty field is treated as
  "needs typing", not "already handled" — the agent points at it and says
  "fill in the X" instead of jumping to Submit.
- **Submit guard.** The agent won't suggest clicking Sign In / Save /
  Continue / Submit while any visible input lacks a value. It fills the
  empties first.

### Field reference

| Field        | Mode      | Notes                                                                                  |
|--------------|-----------|----------------------------------------------------------------------------------------|
| `id`         | both      | Required. Unique slug — re-adding a flow with the same id overwrites.                  |
| `title`      | both      | Human-readable name shown in the side panel.                                           |
| `url`        | both      | Chrome-style glob (`*`) or list of globs. Flow refuses to start on a non-matching tab. |
| `triggers`   | both      | Optional list of phrases (stored in markdown for reference; no UI consumer currently). |
| `mode`       | both      | `agent` or `scripted`. Defaults to `agent` if `goal:` is set and no `## Step` exists.  |
| `goal`       | agent     | Required for agent mode. The end state, in plain English.                              |
| body prose   | agent     | Becomes hints injected into every agent call.                                          |
| `## Step N`  | scripted  | One LLM call per H2 section; the prose under it is the per-step instruction.           |

## Project layout

```
manifest.json              MV3 manifest
background/service-worker  DeepSeek API caller (translate + agent) + message router
content/content.js         DOM distiller + cursor/ring/tooltip overlay
content/content.css        Overlay styles (all scoped to #dga-overlay-root)
sidepanel/                 Chat UI + scripted+agent flow players + drop-zone for user flows
options/                   API key entry, model picker, connection test
flows/*.md                 Bundled starter walkthroughs (scripted + agent examples)
popup/                     Unused template scaffolding (left in tree, not wired up)
icons/                     Toolbar icons
vite.config.js             Vite + @crxjs/vite-plugin build
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the message flow, the prompt, and
the design notes that matter when you start tweaking this.

## Known limits (POC)

- No Shadow-DOM piercing yet — the distiller only walks the light DOM
- No cross-origin iframes — content script doesn't reach in
- No prefetch / no selector cache — every step fires its multi-agent pipeline
  fresh (parallel, but still ~1–3s on average)
- Element resolution happens once per step; the cursor doesn't re-resolve if
  the page mutates mid-step (only re-positions on scroll/resize). The DOM-quiet
  wait before each distill handles the navigation case but not arbitrary
  mid-step DOM churn.

These are the natural next steps; see PLAN.md for the full follow-up list.
