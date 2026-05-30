# Architecture

Reference for anyone modifying the extension. Pair with [PLAN.md](./PLAN.md)
for the *why*; this file is the *what*.

## Components

```
┌─ side panel ─────────────────────────────────────────────────┐
│ sidepanel/sidepanel.{html,css,js}                            │
│   • Bundles flows/*.md at build time (import.meta.glob)      │
│   • Merges with user flows from chrome.storage.local         │
│   • Owns the flow loop (current flow, step index, agentState)│
│   • Drives the multi-agent pipeline + orchestrator           │
│   • Talks to: active tab (content script) + background       │
└──────────────────────────────────────────────────────────────┘
              │                          │
              │ chrome.tabs.sendMessage  │ chrome.runtime.sendMessage
              │ (PING, DISTILL_DOM,      │ (TRANSLATE_STEP, AGENT_STEP,
              │  SHOW_LOADING,           │  CHAT, INGEST_FLOW,
              │  SHOW_OVERLAY,           │  PING_PROVIDER)
              │  CLEAR_OVERLAY,          │
              │  CHAT_REPLY)             │
              ▼                          ▼
┌─ content script ─────────────┐  ┌─ background service worker ──┐
│ content/content.js           │  │ background/service-worker.js │
│   • DOM distiller — static + │  │   • Reads key + config from  │
│     live JS state            │  │     chrome.storage.local     │
│     (value/focused/checked)  │  │   • Multi-agent prompts +    │
│   • Turndown → page markdown │  │     parallel DeepSeek calls  │
│   • Persistent page watcher  │  │   • Local orchestrator merge │
│     → PAGE_CHANGED           │  │   • Ingestion agent          │
│   • Overlay (cursor/ring/    │  │   • Opens sidepanel on       │
│     tooltip), 3 views:       │  │     action click             │
│       step / loading / chat  │  └──────────────────────────────┘
│   • Auto-advance + draggable │                ▲
│     tooltip + alt-rings      │                │ HTTPS
│   • CHAT_QUERY → sidepanel   │                ▼
└──────────────────────────────┘  ┌─ options page ─────────────────┐
                                  │ options/options.{html,css,js}  │
                                  │   • API key + model picker     │
                                  │   • Thinking mode + effort     │
                                  │   • Test connection            │
                                  └────────────────────────────────┘
```

## Provider

**DeepSeek** OpenAI-compatible `/chat/completions` at
`https://api.deepseek.com`. Auth via `Authorization: Bearer <key>`. Body uses
OpenAI chat-completions schema with:

- `temperature: 0` — deterministic across reloads
- `response_format: { type: 'json_object' }` for structured agent calls
- `thinking: { type: 'enabled' | 'disabled', reasoning_effort: 'high' | 'max' }`
  when the user enabled thinking mode in options
- no `max_tokens` (uses model default; 384K for v4 models)

Models exposed:

- `deepseek-v4-flash` (default) — 1M context, 384K max output, fast
- `deepseek-v4-pro` — smartest v4 variant
- `deepseek-chat` / `deepseek-reasoner` — legacy aliases (kept for backward
  compatibility; map onto v4-flash non-thinking and thinking respectively)

## Message contracts

### Side panel → content script (`chrome.tabs.sendMessage`)

| Type            | Payload                                                                                                                          | Response                          |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------|-----------------------------------|
| `PING`          | —                                                                                                                                | `{ok: true}`                      |
| `DISTILL_DOM`   | —                                                                                                                                | `{ok, dom}` (see DOM shape below). **Blocks until DOM quiet** (no mutations for 500ms, max 5s). |
| `SHOW_LOADING`  | `{label?}`                                                                                                                       | `{ok: true}` — flips tooltip to spinner view. |
| `SHOW_OVERLAY`  | `{selector, narration, stepIndex, totalSteps, confidence, blocker, isLast, isAgent?, iter?, maxIter?}`                            | `{ok: true}` — flips tooltip to step view. |
| `CLEAR_OVERLAY` | —                                                                                                                                | `{ok: true}` — hides whole overlay, clears chat history. |
| `CHAT_REPLY`    | `{text, error?}`                                                                                                                 | `{ok: true}` — appended to in-tooltip chat log. |

### Side panel → background (`chrome.runtime.sendMessage`)

| Type             | Payload                                                                                                       | Response                                                                                                                          |
|------------------|---------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `TRANSLATE_STEP` | `{stepText, stepIndex, totalSteps, completedSteps, remainingSteps, flowTitle, flowGoal, hints, knowledge, dom, url, title}` | `{ok, result}` where result has `{currentState, progressAssessment, suggestedStepIndex, doneStepIndices, perStepCandidates, freeFormCandidate, chosenSource, selector, narration, confidence, reasoning, blocker, alternatives, ...}` |
| `AGENT_STEP`     | `{goal, hints, knowledge, history, dom, url, title, iter, maxIter}`                                            | `{ok, result}` where result has `{currentState, progressAssessment, candidateFromPage, candidateFromDocs, chosen, selector, narration, confidence, reasoning, blocker, alternatives, done, ...}` |
| `CHAT`           | `{question, history, goal, flowMode, currentStep, knowledge, dom, url, title}`                                 | `{ok, text}` — plain prose answer (no JSON).                                                                                       |
| `DISTILL_RULES`  | `{goal, currentStep, chatHistory, existingRules, dom, url, title}`                                             | `{ok, rules: string[]}` — 0–3 durable rules distilled from a chat exchange. Side panel appends them to `learnedRules` and injects into subsequent step prompts. |
| `INGEST_FLOW`    | `{raw, filename}`                                                                                              | `{ok, canonicalMd}` — markdown normalised into canonical flow form (frontmatter + split steps + url glob + triggers + mode detection). |
| `PING_PROVIDER`  | —                                                                                                              | `{ok, text}` or `{ok: false, error}` (legacy alias: `PING_ANTHROPIC`).                                                              |

### Content → side panel (`chrome.runtime.sendMessage`, broadcast)

| Type           | Payload                                                  |
|----------------|----------------------------------------------------------|
| `STEP_ADVANCE` | `{action: 'next' | 'prev' | 'done' | 'close'}`           |
| `CHAT_QUERY`   | `{text, history: [{role, text}]}`                        |
| `PAGE_CHANGED` | `{summary: {url, focusedSig}}` — fires when the live DOM diverges from the last distilled snapshot. Sidepanel reruns the current step. |

The side panel registers `chrome.runtime.onMessage` for all three. Background
ignores them.

## Flow modes

Each parsed flow has a `mode` field set by `parseFlow` (sidepanel.js):

- **scripted** — markdown has `## Step N` H2 sections, OR `mode: scripted` in
  the frontmatter. `runCurrentStep` walks the steps.
- **agent** — markdown has `mode: agent`, OR has `goal:` field and no H2
  sections. `runAgentStep` runs in a loop (max 20 iterations) until the
  agent returns `done: true`, user closes, or cap is hit.
- **adhoc** — synthesised when the **Ask the guide** input has no trigger
  match. Becomes an in-memory agent flow with `goal = the question` and
  no URL scope; the full knowledge base picks up the slack.

## URL scope

Each flow may declare `url:` in frontmatter — a Chrome-style glob string (or
list of globs). The side panel:

- Shows the scope under each flow card.
- Refuses to **start** the flow if active tab URL doesn't match (logs which
  URL is needed).
- Aborts **mid-flow** if the user navigates the tab off-scope.

Globs convert to regex by escaping metachars and replacing `*` with `.*`.
No `url:` = runs on any tab.

## Scripted pipeline (multi-agent)

The big one. On every `TRANSLATE_STEP` background fires **N+2 parallel
LLM calls** then merges locally.

```
TRANSLATE_STEP
  └─ Promise.all([
       stateAssessor              ← reads all step texts + live page →
                                    { currentState, currentStepIndex,
                                      doneStepIndices, reasoning }
       stepAgent₀  (step 1)       ← "is MY step applicable now? if so, which
       stepAgent₁  (step 2)         element? otherwise low conf + null"
       stepAgent₂  (step 3)
       ...                          (one per step)
       freeFormPageAgent          ← no step text. just goal + page + history.
                                    "invent the best next click"
     ])
  ↓
  localOrchestrator (no LLM):
    stepFollowing = candidates[ stateAssessor.currentStepIndex ]
    if !stepFollowing.selector && !freeForm.selector → null + blocker
    elif selectors agree                            → pick + +0.1 confidence
    elif one null                                   → pick the other
    elif freeForm.conf >  stepFollowing.conf        → 'invented' (×0.85 discount)
    elif stepFollowing.conf > freeForm.conf         → 'step'
    else (tie)                                      → 'step' (docs win, ×0.9)
```

For 3-step flow: 1 state + 3 per-step + 1 free-form = 5 parallel calls.
Wall-clock ≈ one call. Side panel logs every candidate (★ on applicableNow
step picks, ⚡ on the free-form invention, "orchestrator chose: step|invented|
agreed|neither").

The state assessor's `currentStepIndex` can move the side panel's
`stepIndex` forward or backward — `runCurrentStep` logs "State assessor
moved pointer forward to step N" when this happens. So if the user clicked
through steps 1+2 manually, the assessor sees the post-step-2 page and
fast-forwards to step 3.

## Agent pipeline (free-form / adhoc)

For agent-mode flows (no enumerated steps). Two parallel reasoners + local
merge.

```
AGENT_STEP
  └─ Promise.all([
       pageReasoner   ← goal + completed actions + live page (NO hints/knowledge/stepText).
                        Pure "invent from page" path.
       docsReasoner   ← goal + hints + knowledge + history + live page.
                        Maps docs onto live page.
     ])
  ↓
  mergeCandidates (no LLM):
    same agreement / disagreement / one-null rules as scripted pipeline.
    result includes both candidates so the side panel can show them.
```

`agentState.history` accumulates `{url, selector, narration, completedAt}` —
only when the user actually clicks the highlighted element. Suggestions that
were never clicked don't pollute history (committed in `advance()`, not in
`runAgentStep()`).

## Local orchestrator (no extra LLM)

Both pipelines end in a deterministic merge — see `mergeCandidates` and the
scripted orchestrator block in `background/service-worker.js`. Discount
factors:

- agreement → `+0.1` confidence (capped at 1.0)
- justified disagreement winner → `×0.85`
- tie → `×0.8` to `×0.9`, defaults toward step-following (scripted) or
  page (agent)

No LLM call for the orchestrator — keeps wall-clock low.

## Per-step user click → next step

```
content: user clicks the highlighted element
  ↓
content: maybeAutoAdvanceFromClick / FromKey → signalAdvance('next')
  ↓
sidepanel.advance(+1):
  1. waitForTabReady(8s)         — listens for tabs.onUpdated 'complete'
  2. sleep(150)                   — small settle for client-side rendering
  3. agent-mode: commit pendingSuggestion → agentState.history
  4. scripted: stepIndex += 1
  5. runCurrentStep / runAgentStep:
       prepareTabForStep():
         a. PING content (×15, 250ms gap)         — handles cold inject after nav
         b. SHOW_LOADING (fire-and-forget)        — spinner appears
         c. DISTILL_DOM                            — content waits for DOM quiet
                                                    (MutationObserver, 500ms idle,
                                                     5s cap) before snapshotting
       run multi-agent pipeline (above)
       SHOW_OVERLAY                                — tooltip flips back to step
```

The DOM-quiet wait + the loading spinner together cover the case where the
click triggered async loading after `tabs.onUpdated='complete'` — SPA stacks
that keep rendering 500ms after navigation.

## DOM distiller (content.js)

Walks `document.querySelectorAll(INTERACTIVE_SELECTOR)`:

```
a[href], button, input:not([type=hidden]), select, textarea,
[role="button"], [role="link"], [role="tab"], [role="menuitem"],
[role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"],
[onclick], [data-testid], [contenteditable="true"]
```

For each survivor:

- Visible check (`offsetParent`, computed `display/visibility/opacity`, rect ≥ 2×2).
- Dedupe: drop if any ancestor is also in the interactive set.
- Stable CSS selector — prefers `#id`, then `[data-testid="..."]`, else
  `tag:nth-of-type(n)` chain (max 6 levels).
- Position hint: 3×3 grid (top-left, top-center, top-right, middle-…,
  bottom-…) computed from `getBoundingClientRect`.
- Near label: nearest ancestor with `aria-label`, heading role, `legend`,
  `summary`, or previous-sibling heading text (max ≤80 chars).
- Cap 120 elements, in-viewport first.

Plus up to 20 visible headings.

The content script also calls **Turndown** (`turndown` npm package) to render
`document.body.outerHTML` to compact Markdown. Scripts/styles/svg/iframes are
removed via `turndown.remove([...])`. Result capped at 200KB chars
(~50K tokens). Shipped as `dom.pageMarkdown`.

Per element the distiller also reads **live JS properties** (not the static
HTML attribute, which doesn't reflect user typing or focus):

- `value` — `el.value` (input/textarea/select) or `el.innerText`
  (contenteditable). What the user has actually typed.
- `focused` — `el === document.activeElement`
- `checked` — `el.checked` for checkbox/radio (true/false)
- `disabled` — `el.disabled === true`

The DOM payload also surfaces the focused element at the top level:
`dom.focusedRef` (the matching element's ref id) and `dom.activeElementTag`
(its tag name). The prompt builder renders an explicit
`Focused element: e3 (tag <input>) — the user has clicked into this field.`
line in the page-context block so the model can't miss it.

Output shape:

```ts
{
  url: string,
  title: string,
  headings: Array<{ tag, text }>,
  focusedRef?: string,
  activeElementTag?: string,
  elements: Array<{
    ref: string,            // 'e0', 'e1', ...
    tag, text,
    testid?, id?, ariaLabel?, placeholder?, name?, role?, type?, href?,
    selector: string,
    inViewport: boolean,
    position: 'top-left' | 'top-center' | ... | 'bottom-right',
    nearLabel?: string,
    // Live runtime state (read from JS properties, not HTML attrs):
    value?: string,         // current typed value (omitted when empty)
    focused?: true,
    checked?: boolean,
    disabled?: true,
    empty?: boolean,        // input/textarea/select/contenteditable has no value
  }>,
  pageMarkdown: string,
}
```

All four prompts (translate, agent page, agent docs, chat) take this shape
and format it via `formatDomForPrompt` + `formatRawHtmlBlock` (which now
emits the markdown block, not raw HTML).

## Overlay (content.js + content.css)

Single root `<div id="dga-overlay-root">` appended to `<body>`, all styles
scoped to that id. Children:

1. `.dga-cursor` — SVG arrow, 28×28, opacity 0.7 by default (transparent
   enough not to blot out the target). Fixed position. CSS-transition tween
   on `transform: translate(x, y)` over 500ms with cubic-bezier ease-out.
   Bob keyframe animates the drop shadow.
2. `.dga-ring` — fixed-position glowing border, 2px @ 0.75 opacity, 6px pad
   around the target's bounding rect. Transitions top/left/width/height over
   350ms so it morphs between targets. Pulse keyframe on box-shadow.
3. `.dga-alt-ring` (0..N) — dashed soft rings for "alternatives" returned by
   the model (multi-equivalent picks). 1.5px dashed, 0.55 opacity, 0.04
   tinted background. No pulse, no cursor — just visually indicates "any of
   these works".
4. `.dga-tooltip` — fixed-position card with **three view states** (only one
   visible at a time):
   - `.dga-tooltip-step-view` — header (step counter + confidence chip +
     close ×), body (narration), blocker block, actions (Prev / Chat / Next
     / Done).
   - `.dga-tooltip-loading-view` — header (label + close ×), body (spinner +
     "Re-checking the page and picking the next step…"). Dims ring + cursor
     to 0.4 opacity; auto-advance disarmed.
   - `.dga-tooltip-chat-view` — header (title + Back + close ×), chat log,
     thinking indicator, textarea + Send.

Tracking: capture-phase `scroll` and `resize` listeners call
`repositionOverlay()` via `requestAnimationFrame`.

**Auto-advance.** Capture-phase `click` and `keydown` listeners on
`document`. If the user clicks the highlighted target (or any descendant),
**or any alternative ring's element**, or presses Enter while focused inside
the target, content fires `STEP_ADVANCE {action: 'next'}` itself.
`advanceArmed` flag flips on in `showOverlay()` and off on fire, so one
interaction = one advance. Clicks inside the tooltip are ignored (the
in-tooltip buttons handle them).

**Draggable.** All three view headers have `cursor: grab` and react to
`mousedown` (skipping button clicks) by capturing the offset and listening
for `mousemove`/`mouseup` on document. Position is clamped to the viewport
with a 4px margin. Once dragged, `tooltipUserMoved = true` and
`positionTooltip` honours the user's choice — subsequent step renders
don't auto-snap the tooltip back to the new target. Resets on
`hideOverlay`.

`z-index: 2147483647` on the root.

## Confidence visualisation

`showOverlay` writes `data-confidence` on `#dga-overlay-root`:

- `high` — `confidence >= 0.75` → green
- `med`  — `confidence >= 0.5`  → amber
- `low`  — `confidence <  0.5`  → red

CSS exposes one custom property `--dga-accent: R, G, B` and overrides it
per bucket. Ring border, ring glow, cursor SVG fill, cursor bob keyframe,
ring pulse keyframe, Next/Done/Send buttons, chat input focus ring all
consume `rgba(var(--dga-accent), …)` — single attribute mutation re-themes
the whole overlay. The amber tooltip chip
(`.dga-tooltip-confidence[data-low="1"]`) stays as the textual warning.

## Correct-the-agent chat

The orange **Correct Agent If Wrong** button morphs the tooltip into a chat
pane scoped to ONE purpose: when the agent picks the wrong thing, the user
tells it what's right. A separate distillation pass then turns the agreed
correction into durable rules that are injected into every subsequent
step / agent call AND persisted into the flow's markdown frontmatter so
the next run of the same user flow starts already corrected.

### Chat assessor prompt

Replaces the old plain-prose chat. The model is told it's the
**CORRECTION ASSESSOR** — its only job is to listen, ground the user's
correction against the live page, and decide whether you've understood +
agreed. It is forbidden from giving instructions ("click X", "do Y"); it
only confirms or asks clarifying questions.

Response is structured JSON:

```json
{
  "content": "short conversational reply — confirm understanding or ask clarification",
  "decision": "agreed" | "pending" | "disagreed",
  "reasoning": "one sentence on why this decision"
}
```

- `agreed` — user has explicitly confirmed ("yes", "right", "exactly"). Never set on the first user turn; first turn summarises + asks.
- `disagreed` — user contradicts live page or wants to bail.
- `pending` — default; still gathering info.

### Three terminal buttons + Back

| Button | When enabled | Action |
|---|---|---|
| **Send** (purple) | not busy, not agreed, textarea non-empty | Sends user message to assessor. Reply arrives with a decision. If decision = `agreed`, content flips `userAgreed = true` locally. |
| **Got it ✓** (yellow) | chat history ≥1 turn, not busy, not agreed | Locally appends `"Got it ✓ — you have it right."` user turn + agent ack. Flips `userAgreed = true`. **No LLM call.** Stops the assessor's questioning. |
| **Apply** (green) | `userAgreed === true` | Fires `CHAT_DONE` → distill rules from full convo → persist (if user flow) → close chat → re-run current step. |
| **← Back** (grey) | always | Closes the chat pane. Keeps `chatHistory` so the user can resume. **No** distillation, no re-run. |

Either route (assessor's `decision='agreed'` reply OR explicit Got it ✓
click) flips the same `userAgreed` state. Send + Got it + textarea all
disabled while `userAgreed === true` — user can only Apply or Back.

### Round trip

```
content tooltip                ← user types correction
  ↓ CHAT_QUERY {text, history}
sidepanel.handleChatQuery:
  fresh DISTILL_DOM         (so reply is grounded in current page)
  package: goal, flowMode, currentStep, knowledge, dom, url, title
  ↓ CHAT
background.chatStep:
  buildChatPrompt() (assessor JSON prompt)
  callDeepseek({ jsonMode: true })
  ↓ {ok, text: content, decision, reasoning}
sidepanel
  ↓ CHAT_REPLY {text, error?, decision}    ← content appends to log + flips
content tooltip: appends to chat log         userAgreed if decision='agreed'

…then user clicks Apply (or Got it ✓ → Apply)…

content tooltip
  ↓ CHAT_DONE { history: [...all turns] }
sidepanel.handleChatDone:
  fresh DISTILL_DOM        (so the rule is grounded in current page)
  ↓ DISTILL_RULES { goal, currentStep, chatHistory, existingRules,
                    dom, url, title }
background.distillRules:
  buildDistillRulesPrompt() — sees chat turns + live page + existing rules
  callDeepseek({ jsonMode: true })
  ↓ {ok, rules: ["short imperative rule grounded in page", ...]}
sidepanel:
  appends NEW rules to module-level learnedRules[]
  if activeFlow.source === 'user' → persistRulesIntoUserFlow (rewrites md)
  logs each new rule in the activity feed
  CLOSE_CHAT → content tooltip
  re-runs current step with the new rules
```

Subsequent `TRANSLATE_STEP` / `AGENT_STEP` payloads carry
`learnedRules: []`. Every candidate prompt (page reasoner, docs reasoner,
state assessor, per-step, free-form) emits a
`LEARNED RULES FROM USER CHAT` block above its task instructions, telling
the candidate to follow those rules on this turn.

Distillation only fires on the explicit Apply click (or auto-Apply path
when the user's confirmation flipped the assessor to `agreed`). The
distillation prompt is constrained: 0–3 short rules max, must be specific
(page-/app-/element-level), no generic platitudes, no duplicates of
existing rules.

### Page watcher suppressed during chat

While the chat pane is visible, the content script's persistent page-state
watcher is **suppressed** (`pageWatcherSuppressed = true`) so a stray
PAGE_CHANGED fired by user typing on the real page won't rerun the step
underneath the conversation. Auto-advance is also disarmed.
Re-enabled on closeChat (Back / Apply / hideOverlay).

`learnedRules` resets on flow end (along with `userOverrodeStep`,
`lastAssessorIndex`, `overrideArmed`, `agentState`, etc.). Chat history
resets on Apply (full clear) or hideOverlay. Back keeps it for resume.

### Persistence for user flows

After a correction, if `activeFlow.source === 'user'`,
`persistRulesIntoUserFlow` rewrites the saved markdown:

- Reads the entry from `chrome.storage.local.userFlows`.
- Calls `upsertRulesFrontmatter(raw, rules)` which strips any existing
  `rules:` block from the frontmatter and appends a fresh one:
  ```yaml
  rules:
    - The green Save button is in the top right, not the orange Submit.
    - Customer dropdown needs typing first.
  ```
- Saves the rewritten markdown back.
- `parseFlow` picks the list up on next load via `meta.rules` and exposes
  it on `flow.persistedRules`.
- `startFlow` seeds `learnedRules = [...flow.persistedRules]` on every
  run so the saved corrections apply immediately.

Bundled flows + adhoc questions are NOT persisted — they stay ephemeral
(rules apply this session only, lost on flow end).

## Loading view

Tooltip's third view (between step + chat). Shown by `SHOW_LOADING`
message, hidden by `SHOW_OVERLAY`. Pulse spinner uses
`rgba(var(--dga-accent), …)` so it picks up the accent of the last shown
confidence bucket. `prepareTabForStep` fires `SHOW_LOADING` after PING
succeeds, before the DISTILL_DOM/LLM calls.

The content script also enforces a **DOM-quiet wait** inside the
`DISTILL_DOM` handler: a `MutationObserver` on `document.body` watches for
mutations; the response is held until the page has been still for 500ms (max
5s), so we don't snapshot a half-rendered SPA right after navigation.

## Close button

The tooltip header (in step view AND chat view) carries a Close × button.
Click → fires `STEP_ADVANCE {action: 'close'}` → side panel
`endFlow('user-closed')` → `CLEAR_OVERLAY`. Works for all modes (scripted,
agent, adhoc, mid-chat).

## Alternatives (multi-equivalent picks)

Every candidate prompt's response includes an `alternatives: []` array. When
the step / goal is phrased as "click ONE OF the X" / "ANY of the X" /
"pick a X" and multiple elements equally satisfy the intent (several
objectives in a list, several rows in a table, several cards in a grid), the
model lists the OTHER equivalent selectors there (up to 8 entries).

The orchestrator carries `alternatives` through to the final result. Side
panel forwards them in the `SHOW_OVERLAY` payload. Content's
`renderAlternativeRings` draws softer dashed rings on each equivalent
element (CSS `.dga-alt-ring`). The tooltip body is prefixed: *"Any of these
N highlighted options works — pick whichever you want."*

Auto-advance fires when the user clicks **any** highlighted element —
primary or alternative — so they can pick freely. Rings reposition on
scroll/resize alongside the primary. Cleared on `hideOverlay`.

## Form-state rules (in every candidate prompt)

The distiller emits per-element flags so the model can't conflate FOCUSED
or `placeholder` with actual content:

- `FILLED` plus `current_value="..."` — the user has typed something. Done
  for that field.
- `EMPTY` — input/textarea/select/contenteditable has no actual user
  content. Next action is to type.
- `placeholder_hint="..."` — browser hint text. NOT a value.
- `FOCUSED` — user clicked into the field but may not have typed yet. A
  field can be FOCUSED + EMPTY at the same time.

`COMMON_HARD_RULES` then enforces:

- **Form-field state — read EMPTY and FILLED literally.** `placeholder_hint`
  is NEVER a value. `FOCUSED` is NEVER a value. Only `current_value` is.
- **Submit guard.** Never suggest a submit-style button (Sign In, Login,
  Save, Continue, Submit, Next, Add, Create) while ANY visible input is
  marked `EMPTY`. Pick the next EMPTY input. Narration like "Fill in the
  weight field", not "Click Add".

## Page-state watcher (auto re-run on changes)

While an overlay is visible, the content script runs a persistent watcher
that re-runs the current step whenever the page state diverges from the
last distilled snapshot — no manual Next click needed.

How it works:

- `MutationObserver` on `document.documentElement`
  (`childList, subtree, attributes, characterData`) plus capture-phase
  `input` / `change` / `focusin` / `focusout` listeners. The input listeners
  catch value-only mutations the observer misses.
- 950ms debounce in content: every signal resets a timer; only when the
  page has been still for 950ms do we take a snapshot and compare.
- 400ms second-stage debounce in sidepanel: coalesces bursts of
  PAGE_CHANGED arrivals.
- Snapshot fields: `{url, title, interactiveCount, focusedSig, inputSig}`.
  `focusedSig` = `<TAG>#id[name]::<value-prefix>` (200 chars). `inputSig` =
  concatenation of every input/textarea/select live `.value`, capped 1KB.
- On diff → fire `PAGE_CHANGED` to the side panel.

Side panel `handlePageChanged`:

- 400ms debounce on top of the content-side 800ms (to coalesce bursts).
- If `busy`, queue `pageChangePending` and flush after the in-flight run
  finishes.
- Otherwise calls `runAgentStep({isAutoRerun: true})` or `runCurrentStep()`.
- **`isAutoRerun: true`** for agent mode → skip the `agentState.iter`
  increment. PAGE_CHANGED reruns are state-driven, not user-driven, so they
  don't burn the iteration cap.

Watcher arms in `showOverlay`, disarms in `hideOverlay`. So it only fires
during an active flow.

## Cancellation epoch

Every step runner captures `myEpoch = ++runEpoch` on entry. After each
`await` (`prepareTabForStep`, `TRANSLATE_STEP`, `AGENT_STEP`), they check
`myEpoch !== runEpoch` and bail silently if so. Bailed runners don't mutate
`stepIndex`, `agentState`, don't send `SHOW_OVERLAY`, don't log misleading
results.

`endFlow` bumps `runEpoch` (cancels in-flight) and forces `busy = false`. So
clicking Close mid-LLM-call, or switching flows during a long ingest, never
leaves zombie state painting old overlays.

## Tab reload on flow switch

When the user clicks a different flow card while one is running,
`startFlow` first calls `endFlow('user-switched')`, then **hard-reloads the
tab** via `chrome.tabs.reload(tabId)` and waits with
`waitForTabReady(10s)` for the page to come back. This guarantees the new
flow starts from a clean page state — no half-filled form, no open modal
from the prior flow. Side effect: any unsaved form data the user typed is
lost; explicit trade-off for clean state.

The activity log is also cleared on switch so the user gets fresh
reasoning logs for just the new flow.

## User override reconciliation

When the user hits the Next or Prev button, that intent has to be
reconciled with what the state assessor reads off the live page.

State carried by the side panel:

- `userOverrodeStep` — flipped on by `advance(±1)` when `delta !== 0`. Read
  by `runCurrentStep`. Cleared after the run.
- `lastAssessorIndex` — cached after each scripted run, holding the
  assessor's `suggestedStepIndex`.
- `overrideArmed` — two-click confirm latch.

Rules:

1. **No override + assessor disagrees** → assessor wins, sidepanel
   fast-forwards/rewinds `stepIndex` and logs *"State assessor moved
   pointer forward to step N"*.
2. **Override + assessor agrees** → user pin honoured, full confidence.
3. **Override + assessor disagrees** → user pin honoured BUT
   `t.confidence = min(t.confidence, 0.4)` and a blocker text is appended:
   *"Heads up: the page looks like it's still on step M, but you advanced
   manually. The highlight below might be wrong — close the guide and
   finish the previous step if needed."*
4. **Two-click confirm on forward jumps.** If the user hits Next while
   `lastAssessorIndex === stepIndex` and `!overrideArmed`, the first click
   is refused with a warning log; `overrideArmed` is set; second Next click
   advances. Stops accidental jumps from rocketing the pointer forward
   while the user is still working on the current step.

Auto-advance (target click / Enter key) still uses the same advance code
path; it currently goes through the same two-click latch. That's an open
edge case — see "What this does NOT do".

## Draggable tooltip

The tooltip header is a drag handle. `mousedown` on the header (skipping
buttons) starts `dragState`; `mousemove` updates `top/left` with viewport
clamping (4px margin); `mouseup` ends. Once dragged, `tooltipUserMoved`
flips on and `positionTooltip` no longer auto-snaps the tooltip back to
the target on subsequent step renders — the user put it where they wanted
it. Reset on `hideOverlay`.

Cursor flips between `grab` ↔ `grabbing` during drag. `userSelect: none`
prevents text selection while moving.

## Ingestion agent (drop-zone normalisation)

When the user drops a `.md` file (or multiple), `ingestFiles`:

1. Filters to `.md` files (skipped non-md logged).
2. Sets the drop zone to a busy state (purple solid border, spinner,
   "Normalising N flows with agent…", `pointer-events: none`).
3. Fires one `INGEST_FLOW` background call per file **in parallel**
   (`Promise.all`).
4. Background runs the user's raw markdown through a normalisation prompt:
   id from filename, frontmatter generation, split mashed-action steps,
   extract URL → host-wildcard glob (drop the navigate step), pick mode
   (scripted vs agent), 2-4 triggers.
5. Sidepanel parses the returned canonical markdown via the same
   `parseFlow` as bundled flows.
6. **Storage writes serialised through `saveQueue`** — each `ingestOne`
   waits for previous one's chrome.storage.local write to finish so
   parallel saves don't race. LLM calls stay fully concurrent.

If the ingestion call fails (no API key, timeout), the raw markdown is
saved as-is. `parseFlow` defensively coerces a scripted flow with zero
parsed steps into agent mode so a runnable flow is always produced.

## Build (vite + @crxjs/vite-plugin)

- `vite.config.js` registers `crx({ manifest })` and outputs to `dist/`
- crxjs rewrites `manifest.json` paths to hashed bundle outputs and emits
  loader shims (`service-worker-loader.js`, `content.js-loader-*.js`).
- Flows are bundled into `sidepanel.html-*.js` via
  `import.meta.glob('../flows/*.md', { query: '?raw', eager: true })`.
- `turndown` is bundled into `content.js` via the content script's
  `import TurndownService from 'turndown'`.

Rebuild: `npm run build`. Reload at `chrome://extensions` to pick up changes.

## Storage keys (chrome.storage.local)

| Key                | Type                                              | Purpose                                                                                       |
|--------------------|---------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `deepseekApiKey`   | string                                            | DeepSeek API key                                                                              |
| `anthropicApiKey`  | string                                            | Legacy key from older builds. Read as fallback by `getApiKey()`, removed on next Save.        |
| `model`            | string                                            | Model id. Default `deepseek-v4-flash`.                                                        |
| `thinkingMode`     | `'enabled' | 'disabled'`                          | DeepSeek thinking parameter. Default `'enabled'`.                                              |
| `reasoningEffort`  | `'high' | 'max'`                                  | DeepSeek thinking effort when enabled. Default `'high'`.                                       |
| `userFlows`        | `Array<{ id, raw, addedAt }>`                     | User-supplied flow markdown. Persists across reloads. Re-adding the same `id` overwrites; user `id` shadows a bundled flow with the same `id`. |

Flow progress is in-memory only.

## What this does NOT do

- Tool calling / autonomous click — the agent never acts on the user's behalf.
- Backend / proxy — every call goes from the extension directly to DeepSeek.
- Shadow DOM, cross-origin iframes — out of scope for POC.
- Selector cache / step prefetch — every step fires its multi-agent pipeline
  fresh. Mid-step DOM changes ARE handled now via the page watcher, but each
  rerun still costs an LLM round-trip.
- Distinguish auto-advance click from manual Next button click. Both go
  through the same `STEP_ADVANCE 'next'` path and the same two-click latch.
  Open edge case for the override reconciliation rules.
- Analytics, logging, multi-tenant auth.
