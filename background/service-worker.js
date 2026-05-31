// Dashboard Guide Agent — background service worker
// Holds the DeepSeek API key, makes the translate call, routes lifecycle events.
// DeepSeek API is OpenAI-compatible: bearer auth, /chat/completions, choices[].message.content.

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_THINKING_MODE = 'enabled';
const DEFAULT_REASONING_EFFORT = 'high';

// Make the action button open the side panel on click.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn('[dga] sidePanel.setPanelBehavior failed', e);
  }
  ensureKeepaliveAlarm();
});

// MV3 idles the service worker after ~30s with no events, which adds a
// noticeable cold-start latency to the next LLM call. A periodic alarm
// fires often enough to reset the idle timer so a user mid-flow gets
// warm-path latency. Period is 0.42 min (~25s) — under Chrome's 30s
// shutdown window but well above the 0.5 min minimum for alarms.
const KEEPALIVE_ALARM = 'dga-keepalive';
function ensureKeepaliveAlarm() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.42 });
  } catch (e) {
    console.warn('[dga] keepalive alarm failed', e);
  }
}
chrome.runtime.onStartup.addListener(ensureKeepaliveAlarm);
ensureKeepaliveAlarm();
chrome.alarms.onAlarm.addListener(() => { /* wake-only */ });

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab && typeof tab.windowId === 'number') {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {
    console.warn('[dga] sidePanel.open failed', e);
  }
});

async function getApiKey() {
  const { deepseekApiKey, anthropicApiKey } = await chrome.storage.local.get(['deepseekApiKey', 'anthropicApiKey']);
  // Back-compat with the old key name if user already saved one.
  return deepseekApiKey || anthropicApiKey || '';
}

async function getModel() {
  const { model } = await chrome.storage.local.get('model');
  return model || DEFAULT_MODEL;
}

async function getThinkingConfig() {
  const { thinkingMode, reasoningEffort } = await chrome.storage.local.get(['thinkingMode', 'reasoningEffort']);
  return {
    mode: thinkingMode || DEFAULT_THINKING_MODE,
    effort: reasoningEffort || DEFAULT_REASONING_EFFORT,
  };
}

function formatRawHtmlBlock(dom) {
  if (!dom || !dom.pageMarkdown) return '';
  // The content script renders the live page to Markdown via Turndown so the
  // model gets a dense, structured narrative of the page. Use it for layout +
  // disambiguation. The selector still has to come from the distilled
  // "Interactive elements" list.
  return `\n\nPAGE AS MARKDOWN (live page rendered via Turndown — headings, links, lists, prose; use ONLY as background reading to disambiguate the interactive elements above. Selectors MUST still come from the distilled list, not from this Markdown):\n${dom.pageMarkdown}`;
}

function formatDomForPrompt(dom) {
  const focusedRef = dom && dom.focusedRef;
  const elementsCompact = (dom.elements || []).map(e => {
    const parts = [];
    parts.push(`<${e.tag}>`);
    if (e.testid) parts.push(`testid="${e.testid}"`);
    if (e.id) parts.push(`id="${e.id}"`);
    if (e.ariaLabel) parts.push(`aria-label="${e.ariaLabel}"`);
    if (e.placeholder) parts.push(`placeholder_hint=${JSON.stringify(e.placeholder)}`);
    if (e.name) parts.push(`name="${e.name}"`);
    if (e.role) parts.push(`role="${e.role}"`);
    if (e.type) parts.push(`type="${e.type}"`);
    if (e.href) parts.push(`href="${e.href}"`);
    if (e.text) parts.push(`text=${JSON.stringify(e.text)}`);
    if (typeof e.value === 'string' && e.value.length) {
      parts.push(`current_value=${JSON.stringify(e.value)} FILLED`);
    } else if (e.empty === true) {
      parts.push('EMPTY');
    }
    if (e.checked === true) parts.push('checked');
    if (e.checked === false) parts.push('unchecked');
    if (e.disabled) parts.push('disabled');
    if (e.focused || e.ref === focusedRef) parts.push('FOCUSED');
    if (e.position) parts.push(`position=${e.position}`);
    if (!e.inViewport) parts.push('off-screen');
    const near = e.nearLabel ? `\n      near: ${JSON.stringify(e.nearLabel)}` : '';
    return `  ${e.ref}: ${parts.join(' ')}${near}\n      selector: ${e.selector}`;
  }).join('\n');

  const headings = (dom.headings || []).map(h => `  ${h.tag}: ${h.text}`).join('\n');
  return { elementsCompact, headings };
}

// -------- Prompt fragments shared by every candidate prompt --------

function formatLearnedRulesBlock(learnedRules) {
  if (!Array.isArray(learnedRules) || learnedRules.length === 0) return '';
  const lines = learnedRules.map((r, i) => `  ${i + 1}. ${r}`).join('\n');
  return `\n\nLEARNED RULES FROM USER CHAT (the user corrected the agent in chat — these are durable rules distilled from that conversation; FOLLOW them on this step):\n${lines}`;
}

function commonPageContext({ dom, url, title }) {
  const { elementsCompact, headings } = formatDomForPrompt(dom);
  const focusLine = dom && dom.focusedRef
    ? `Focused element: ${dom.focusedRef} (tag <${dom.activeElementTag || '?'}>) — the user has clicked into this field.`
    : 'Focused element: (none — no input has focus)';
  return `CURRENT PAGE (THE GROUND TRUTH):
URL: ${url}
Title: ${title}
${focusLine}

Section headings:
${headings || '  (none)'}

Interactive elements on the page (with stable CSS selectors; each line shows position + nearby label + live state like FOCUSED / current_value / checked):
${elementsCompact || '  (none found)'}${formatRawHtmlBlock(dom)}`;
}

function formatCompletedScripted(completedSteps) {
  return (completedSteps && completedSteps.length)
    ? completedSteps.map((s, i) => `  ✓ ${i + 1}. DONE — ${s}`).join('\n')
    : '  (none yet — this is step 1)';
}

function formatRemainingScripted(remainingSteps, stepIndex) {
  return (remainingSteps && remainingSteps.length)
    ? remainingSteps.map((s, i) => `  ${(stepIndex || 0) + 2 + i}. ${s}`).join('\n')
    : '  (none — this is the last step)';
}

function formatHistoryAgent(history) {
  return (history && history.length)
    ? history.map((h, i) => {
        const when = h.completedAt ? ` (completed ${h.completedAt})` : '';
        return `  ✓ ${i + 1}. on ${h.url}${when}\n      DONE — clicked selector: ${h.selector}\n      what they did: "${h.narration}"`;
      }).join('\n')
    : '  (none yet — this is the first action)';
}

const CANDIDATE_JSON_SHAPE_AGENT = `{
  "currentState": "<one sentence: where the user is right now, from the live page>",
  "progressAssessment": "<one sentence: what's done vs what's left>",
  "selector": "<CSS selector verbatim from the list above, or null>",
  "narration": "<one short imperative sentence>",
  "confidence": 0.0,
  "reasoning": "<one sentence on why this click is correct>",
  "alternatives": [],
  "blocker": null,
  "done": false
}`;

const CANDIDATE_JSON_SHAPE_SCRIPTED = `{
  "currentState": "<one sentence: where the user is right now>",
  "progressAssessment": "<one sentence: is the page in the right state for the current step?>",
  "selector": "<CSS selector verbatim from the list above, or null>",
  "narration": "<one short imperative sentence>",
  "confidence": 0.0,
  "reasoning": "<one sentence on why this element matches the current step>",
  "alternatives": [],
  "blocker": null
}`;

const COMMON_HARD_RULES = `Hard rules:
- "selector" MUST be copied verbatim from a "selector:" line above, or null. Never invent a selector.
- If the right element isn't on the live page, set selector=null and explain in "blocker". Don't guess.
- "narration" is what the user reads — short, imperative.
- "confidence" 0.0-1.0. Be honest.
- "alternatives": when the user step is phrased as "click ONE OF the X / ANY of the X / pick a X" and multiple elements equally satisfy it (e.g. several objectives in a list, several rows in a table, several cards in a grid), list the OTHER equivalent selectors here (excluding the one in "selector"). Verbatim from the list. Up to 8 entries. When only one element fits, return an empty array. Phrase the narration so the user knows they have a choice (e.g. "Click any of the highlighted objectives — they all work").
- **Form-field state — read EMPTY and FILLED literally.** Each editable input is tagged with one of two flags in the element list:
    • \`FILLED\` plus its \`current_value=...\` — the user has typed something. Treat as done for that field.
    • \`EMPTY\` — the field has NO actual user content. The next action for this field is to TYPE INTO IT.
  \`placeholder_hint="..."\` is **NOT a value**. It is the greyed-out hint text the browser shows in an empty field. An EMPTY field with a placeholder is still EMPTY.
  \`FOCUSED\` is **NOT a value either**. A field can be EMPTY + FOCUSED at the same time (the user clicked into it but hasn't typed yet) — that means "the user is about to type", not "done".
- **Forms specifically:** never suggest clicking a submit button (Sign In, Login, Save, Continue, Submit, Next, Add, Create) while ANY visible input is marked EMPTY. The submit will fail validation. Pick the next EMPTY input and tell the user to fill it. Word the narration like "Type your password" or "Fill in the weight field" — point at the input, not the submit.`;

// -------- Agent-mode candidate prompts (one per parallel reasoner) --------

function buildAgentPagePrompt({ goal, history, dom, url, title, iter, maxIter, learnedRules }) {
  return `You are one of two parallel reasoners. Your job: find the next click PURELY from the live page. You have NO documentation, NO author hints, NO knowledge base. Reason only from the DOM and visible labels — except for any LEARNED RULES below, which the user corrected the agent on and you should respect.

GOAL:
${goal}${formatLearnedRulesBlock(learnedRules)}

✓ COMPLETED ACTIONS (the user has already done these — DO NOT re-suggest):
${formatHistoryAgent(history)}

${commonPageContext({ dom, url, title })}

This is iteration ${iter + 1} of at most ${maxIter}.

Think in two steps:
A — Where am I now? (live page only)
B — Given the goal + completed actions + current state, what is the SINGLE next click that moves forward?

Return ONLY raw JSON in this exact shape:
${CANDIDATE_JSON_SHAPE_AGENT}

${COMMON_HARD_RULES}
- Set "done": true only when the GOAL is achieved (current page proves it). When done, selector may be null and narration should congratulate the user.
- Do NOT pick a selector that already appears in ✓ COMPLETED ACTIONS unless the live page state proves the prior click had no effect.`;
}

function buildAgentDocsPrompt({ goal, hints, knowledge, history, dom, url, title, iter, maxIter, learnedRules }) {
  return `You are one of two parallel reasoners. Your job: follow the author's documentation as closely as possible, mapping the prescribed next step onto the live page.

GOAL:
${goal}

AUTHOR HINTS (your primary guide for this goal):
${hints || '(none)'}

KNOWLEDGE BASE (other authored flows — vocabulary + behaviour reference):
${knowledge || '(empty)'}${formatLearnedRulesBlock(learnedRules)}

✓ COMPLETED ACTIONS (the user has already done these — pick the NEXT one in the documented sequence):
${formatHistoryAgent(history)}

${commonPageContext({ dom, url, title })}

This is iteration ${iter + 1} of at most ${maxIter}.

Think in two steps:
A — What do the hints / knowledge say should happen next (given completed actions)?
B — Which element on the LIVE PAGE matches that prescribed step? If nothing matches, return selector=null and explain in blocker.

Return ONLY raw JSON in this exact shape:
${CANDIDATE_JSON_SHAPE_AGENT}

${COMMON_HARD_RULES}
- Set "done": true only when the GOAL is achieved.
- Do NOT pick a selector that already appears in ✓ COMPLETED ACTIONS.
- If hints/knowledge prescribe an element that simply isn't present, set selector=null and explain — don't substitute.`;
}

// -------- Scripted-mode pipeline: state assessor + per-step + orchestrator --------

function buildStateAssessorPrompt({ allSteps, flowTitle, flowGoal, dom, url, title, learnedRules }) {
  const stepsBlock = allSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
  return `You are the STATE ASSESSOR for a multi-step walkthrough. Your job: look at the LIVE PAGE and the list of steps, then decide where the user currently is.

WALKTHROUGH:
title: ${flowTitle || '(untitled)'}
goal: ${flowGoal || '(no goal stated)'}

ALL STEPS (in order):
${stepsBlock}${formatLearnedRulesBlock(learnedRules)}

${commonPageContext({ dom, url, title })}

Think:
A — What does the live page show? (URL, headings, key elements)
B — Which steps from ALL STEPS look like they've already been done? (e.g. if the user is on the "new issue" form, steps that say "click Issues tab" and "click New issue button" are obviously done)
C — Which step is the user about to do RIGHT NOW (the next un-done one)?

Return ONLY raw JSON:
{
  "currentState": "<one sentence describing the live page>",
  "currentStepIndex": <0-based index — which step the user should do next>,
  "doneStepIndices": [<0-based indices of steps that already look completed>],
  "reasoning": "<one sentence — why this is the right step pointer>"
}

Rules:
- Indices are 0-based (step 1 = index 0).
- doneStepIndices must be a strict prefix of currentStepIndex when steps are sequential, EXCEPT if the user skipped ahead.
- If completely unsure, set currentStepIndex to the smallest un-done index and explain why in reasoning.`;
}

function buildStepCandidatePrompt({ stepText, stepIndex, totalSteps, allSteps, dom, url, title, learnedRules }) {
  const otherSteps = allSteps.map((s, i) => i === stepIndex ? `  ${i + 1}. **MY STEP**: ${s}` : `  ${i + 1}. ${s}`).join('\n');
  return `You are the per-step reasoner for ONE specific step in a multi-step walkthrough. Other reasoners cover the other steps in parallel; an orchestrator will merge our outputs.

YOUR ASSIGNED STEP (step ${stepIndex + 1} of ${totalSteps}):
  ${stepText || '(empty)'}

Full walkthrough (yours marked **MY STEP**):
${otherSteps}${formatLearnedRulesBlock(learnedRules)}

${commonPageContext({ dom, url, title })}

Decide:
A — Does the LIVE PAGE right now match YOUR step? (Is the page in the state where this step would happen?)
B — If yes, point at the element to click. If no, set selector=null and lower confidence.

Return ONLY raw JSON:
{
  "applicableNow": <true if the live page is currently in the right state for MY step, false otherwise>,
  "currentState": "<one sentence: how the page relates to MY step>",
  "selector": "<verbatim from the list, or null>",
  "narration": "<one short imperative sentence for MY step>",
  "confidence": 0.0,
  "reasoning": "<one sentence on why this element matches MY step OR why MY step isn't applicable right now>",
  "blocker": null
}

Rules:
- "selector" verbatim from the "selector:" lines above, or null. Never invent.
- "applicableNow": true ONLY if the page is in the right state for YOUR specific step. If the page is past or before your step, set false.
- "confidence": be honest. 0.8+ only when the page clearly matches your step AND a specific element fits. <0.3 if your step is clearly not applicable.`;
}

// (buildScriptedDocsPrompt, buildScriptedPagePrompt, buildAgentPrompt replaced
//  by state-assessor + per-step pipelines + agent page/docs prompts above.)

async function callDeepseek({ apiKey, model, system, user, jsonMode = true }) {
  const body = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  // Thinking-mode parameters. Only attach when explicitly enabled — disabled
  // mode is sent as { type: 'disabled' } so the v4 model behaves like the
  // legacy non-thinking variant.
  const thinking = await getThinkingConfig();
  if (thinking.mode === 'enabled') {
    body.thinking = { type: 'enabled', reasoning_effort: thinking.effort };
  } else if (thinking.mode === 'disabled') {
    body.thinking = { type: 'disabled' };
  }

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = await res.json();
  const text = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
  return text.trim();
}

function parseJsonLoose(text) {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (!s.startsWith('{')) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) s = m[0];
  }
  return JSON.parse(s);
}

const SYSTEM_PROMPT = 'You output ONLY raw JSON conforming to the schema the user describes. Never wrap responses in markdown fences. Never include prose before or after the JSON.';

// -------- Candidate runners + local merge --------

function normalizeCandidate(parsed) {
  const c = parsed || {};
  return {
    currentState: c.currentState || '',
    progressAssessment: c.progressAssessment || '',
    selector: typeof c.selector === 'string' ? c.selector : null,
    narration: c.narration || '',
    confidence: typeof c.confidence === 'number' ? c.confidence : 0,
    reasoning: c.reasoning || '',
    blocker: c.blocker || null,
    done: c.done === true,
    applicableNow: c.applicableNow === true,
    alternatives: Array.isArray(c.alternatives) ? c.alternatives.filter(s => typeof s === 'string') : [],
  };
}

async function callStateAssessor({ apiKey, model, prompt }) {
  let raw = '';
  try {
    raw = await callDeepseek({ apiKey, model, system: SYSTEM_PROMPT, user: prompt, jsonMode: true });
    const p = parseJsonLoose(raw);
    return {
      currentState: p.currentState || '',
      currentStepIndex: typeof p.currentStepIndex === 'number' ? p.currentStepIndex : null,
      doneStepIndices: Array.isArray(p.doneStepIndices) ? p.doneStepIndices.filter(n => typeof n === 'number') : [],
      reasoning: p.reasoning || '',
      raw,
    };
  } catch (e) {
    return {
      currentState: '',
      currentStepIndex: null,
      doneStepIndices: [],
      reasoning: '',
      raw,
      error: String(e && e.message || e),
    };
  }
}

async function callCandidate({ apiKey, model, prompt }) {
  let raw = '';
  try {
    raw = await callDeepseek({ apiKey, model, system: SYSTEM_PROMPT, user: prompt, jsonMode: true });
    return { ...normalizeCandidate(parseJsonLoose(raw)), raw };
  } catch (e) {
    return {
      ...normalizeCandidate({}),
      raw,
      error: String(e && e.message || e),
    };
  }
}

function mergeCandidates(pageCand, docsCand) {
  let chosen, selector, narration, confidence, reasoning, blocker;
  const done = pageCand.done || docsCand.done;

  if (!pageCand.selector && !docsCand.selector) {
    chosen = 'neither';
    selector = null;
    narration = pageCand.narration || docsCand.narration || '';
    confidence = 0;
    reasoning = 'Neither reasoner found a matching element on the live page.';
    blocker = pageCand.blocker || docsCand.blocker || 'No matching element on this page.';
  } else if (pageCand.selector && docsCand.selector && pageCand.selector === docsCand.selector) {
    chosen = 'agreed';
    selector = pageCand.selector;
    narration = docsCand.narration || pageCand.narration;
    confidence = Math.min(1.0, Math.max(pageCand.confidence, docsCand.confidence) + 0.1);
    reasoning = `Both reasoners agreed. Page: ${pageCand.reasoning} Docs: ${docsCand.reasoning}`;
    blocker = null;
  } else if (!pageCand.selector) {
    chosen = 'docs';
    selector = docsCand.selector;
    narration = docsCand.narration;
    confidence = docsCand.confidence;
    reasoning = `Page reasoner had no candidate; docs picked: ${docsCand.reasoning}`;
    blocker = docsCand.blocker;
  } else if (!docsCand.selector) {
    chosen = 'page';
    selector = pageCand.selector;
    narration = pageCand.narration;
    confidence = pageCand.confidence;
    reasoning = `Docs reasoner had no candidate; page picked: ${pageCand.reasoning}`;
    blocker = pageCand.blocker;
  } else {
    // Both non-null, disagree. Higher confidence wins; ties favour page-only.
    if (pageCand.confidence > docsCand.confidence + 0.001) {
      chosen = 'page';
      selector = pageCand.selector;
      narration = pageCand.narration;
      confidence = pageCand.confidence * 0.85;
      reasoning = `Disagree — chose page (conf ${pageCand.confidence.toFixed(2)} vs docs ${docsCand.confidence.toFixed(2)}). Page: ${pageCand.reasoning}`;
    } else if (docsCand.confidence > pageCand.confidence + 0.001) {
      chosen = 'docs';
      selector = docsCand.selector;
      narration = docsCand.narration;
      confidence = docsCand.confidence * 0.85;
      reasoning = `Disagree — chose docs (conf ${docsCand.confidence.toFixed(2)} vs page ${pageCand.confidence.toFixed(2)}). Docs: ${docsCand.reasoning}`;
    } else {
      chosen = 'page';
      selector = pageCand.selector;
      narration = pageCand.narration;
      confidence = pageCand.confidence * 0.8;
      reasoning = `Tie — defaulted to page (live-grounded). Page: ${pageCand.reasoning}`;
    }
    blocker = null;
  }

  // Inherit the alternatives list from whichever candidate we picked.
  const altsSource = chosen === 'docs' ? docsCand
                   : chosen === 'agreed' ? docsCand
                   : pageCand;
  const alternatives = Array.isArray(altsSource.alternatives) ? altsSource.alternatives : [];

  return {
    currentState: pageCand.currentState || docsCand.currentState,
    progressAssessment: pageCand.progressAssessment || docsCand.progressAssessment,
    candidateFromPage: { ...pageCand, raw: undefined },
    candidateFromDocs: { ...docsCand, raw: undefined },
    chosen,
    selector,
    narration,
    confidence,
    reasoning,
    blocker,
    alternatives,
    done,
  };
}

// Scripted pipeline:
//   • 1 state assessor (which step is the user actually on?)
//   • N per-step agents (one per step — each says "is MY step applicable right now?")
//   • 1 free-form page agent (ignores all steps; picks what it thinks is the best next click)
//   • local orchestrator: compare step-following pick vs free-form pick; higher confidence wins.
async function translateStep(payload) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('No DeepSeek API key set. Open the extension options to paste your key.');
  }
  const model = await getModel();
  const stepIndex = typeof payload.stepIndex === 'number' ? payload.stepIndex : 0;
  const allSteps = [
    ...(payload.completedSteps || []),
    payload.stepText || '',
    ...(payload.remainingSteps || []),
  ];
  const sharedCtx = {
    dom: payload.dom,
    url: payload.url,
    title: payload.title,
  };

  const learnedRules = Array.isArray(payload.learnedRules) ? payload.learnedRules : [];
  const statePromise = callStateAssessor({
    apiKey,
    model,
    prompt: buildStateAssessorPrompt({
      allSteps,
      flowTitle: payload.flowTitle,
      flowGoal: payload.flowGoal,
      learnedRules,
      ...sharedCtx,
    }),
  });
  const candidatePromises = allSteps.map((stepText, i) =>
    callCandidate({
      apiKey,
      model,
      prompt: buildStepCandidatePrompt({
        stepText,
        stepIndex: i,
        totalSteps: allSteps.length,
        allSteps,
        learnedRules,
        ...sharedCtx,
      }),
    })
  );
  const freeFormPromise = callCandidate({
    apiKey,
    model,
    prompt: buildFreeFormPagePrompt({
      goal: payload.flowGoal || payload.flowTitle,
      completedSteps: payload.completedSteps,
      learnedRules,
      ...sharedCtx,
    }),
  });

  const [state, freeForm, ...candidates] = await Promise.all([
    statePromise,
    freeFormPromise,
    ...candidatePromises,
  ]);

  // Step-following pick: candidate at the step the assessor suggests.
  const targetIdx = (state.currentStepIndex != null && state.currentStepIndex >= 0 && state.currentStepIndex < allSteps.length)
    ? state.currentStepIndex
    : stepIndex;
  const stepFollowing = candidates[targetIdx] || candidates[stepIndex] || normalizeCandidate({});

  // Orchestrator. Pick whichever has higher confidence. Ties favour the
  // step-following pick (docs win on equal evidence). Discount disagreement.
  let chosenSource, selector, narration, confidence, reasoning, blocker;
  const margin = 0.001;
  if (!stepFollowing.selector && !freeForm.selector) {
    chosenSource = 'neither';
    selector = null;
    narration = stepFollowing.narration || freeForm.narration || '';
    confidence = 0;
    reasoning = 'Neither step-following nor free-form agent found a matching element.';
    blocker = stepFollowing.blocker || freeForm.blocker || 'No matching element on this page.';
  } else if (stepFollowing.selector && freeForm.selector && stepFollowing.selector === freeForm.selector) {
    chosenSource = 'agreed';
    selector = stepFollowing.selector;
    narration = stepFollowing.narration || freeForm.narration;
    confidence = Math.min(1.0, Math.max(stepFollowing.confidence, freeForm.confidence) + 0.1);
    reasoning = `Step-following and free-form agreed. Step: ${stepFollowing.reasoning} Free-form: ${freeForm.reasoning}`;
    blocker = null;
  } else if (!stepFollowing.selector) {
    chosenSource = 'invented';
    selector = freeForm.selector;
    narration = freeForm.narration;
    confidence = freeForm.confidence;
    reasoning = `Step-following had no element; free-form invented: ${freeForm.reasoning}`;
    blocker = freeForm.blocker;
  } else if (!freeForm.selector) {
    chosenSource = 'step';
    selector = stepFollowing.selector;
    narration = stepFollowing.narration;
    confidence = stepFollowing.confidence;
    reasoning = `Free-form had no candidate; following the step: ${stepFollowing.reasoning}`;
    blocker = stepFollowing.blocker;
  } else if (freeForm.confidence > stepFollowing.confidence + margin) {
    chosenSource = 'invented';
    selector = freeForm.selector;
    narration = freeForm.narration;
    confidence = freeForm.confidence * 0.85;
    reasoning = `Free-form agent invented a higher-confidence pick (${freeForm.confidence.toFixed(2)} vs step ${stepFollowing.confidence.toFixed(2)}). Reason: ${freeForm.reasoning}`;
    blocker = null;
  } else if (stepFollowing.confidence > freeForm.confidence + margin) {
    chosenSource = 'step';
    selector = stepFollowing.selector;
    narration = stepFollowing.narration;
    confidence = stepFollowing.confidence;
    reasoning = `Step-following won (${stepFollowing.confidence.toFixed(2)} vs free-form ${freeForm.confidence.toFixed(2)}). Reason: ${stepFollowing.reasoning}`;
    blocker = null;
  } else {
    chosenSource = 'step';
    selector = stepFollowing.selector;
    narration = stepFollowing.narration;
    confidence = stepFollowing.confidence * 0.9;
    reasoning = `Tied — defaulted to step-following. Reason: ${stepFollowing.reasoning}`;
    blocker = null;
  }

  const perStepCandidates = candidates.map((c, i) => ({
    stepIndex: i,
    stepText: allSteps[i],
    applicableNow: c.applicableNow,
    selector: c.selector,
    narration: c.narration,
    confidence: c.confidence,
    reasoning: c.reasoning,
  }));

  // Alternatives come from whichever candidate was chosen.
  const winnerCand = chosenSource === 'invented' ? freeForm
                   : chosenSource === 'step' ? stepFollowing
                   : chosenSource === 'agreed' ? stepFollowing
                   : null;
  const alternatives = winnerCand && Array.isArray(winnerCand.alternatives)
    ? winnerCand.alternatives.filter(s => s !== selector)
    : [];

  return {
    currentState: state.currentState || stepFollowing.currentState || freeForm.currentState || '',
    progressAssessment: `Assessor suggests step ${targetIdx + 1} of ${allSteps.length}. Done so far: [${(state.doneStepIndices || []).map(i => i + 1).join(', ') || 'none'}].`,
    suggestedStepIndex: targetIdx,
    doneStepIndices: state.doneStepIndices || [],
    perStepCandidates,
    freeFormCandidate: {
      selector: freeForm.selector,
      narration: freeForm.narration,
      confidence: freeForm.confidence,
      reasoning: freeForm.reasoning,
    },
    chosenSource,
    selector,
    narration,
    confidence,
    reasoning,
    alternatives,
    blocker,
    rawState: state.raw,
    rawCandidates: candidates.map(c => c.raw),
    rawFreeForm: freeForm.raw,
  };
}

function buildFreeFormPagePrompt({ goal, completedSteps, dom, url, title, learnedRules }) {
  return `You are the FREE-FORM page reasoner. You DO NOT see the scripted step text. Your job: look at the live page + goal + what's been completed, and pick the SINGLE most natural next click — invent it from the page itself. Respect any LEARNED RULES below (those are corrections the user gave the agent in chat).

GOAL:
${goal || '(no goal stated)'}${formatLearnedRulesBlock(learnedRules)}

✓ COMPLETED STEPS (already done — do not re-pick these):
${formatCompletedScripted(completedSteps)}

${commonPageContext({ dom, url, title })}

Think:
A — What screen / state is the live page in?
B — Given the goal and what's already been done, what is the single best next click? Reason from the page alone — labels, headings, what visibly stands out.

Return ONLY raw JSON:
{
  "currentState": "<one sentence: what the live page is>",
  "selector": "<verbatim from the list, or null>",
  "narration": "<one short imperative sentence>",
  "confidence": 0.0,
  "reasoning": "<one sentence: why this click is the best next move based purely on the live page>",
  "blocker": null
}

Rules:
- selector verbatim from the list. Never invent.
- If the page doesn't suggest a clear next click, set selector=null with a blocker.
- confidence reflects how natural the pick feels given the goal + page.`;
}

async function agentStep(payload) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('No DeepSeek API key set. Open the extension options to paste your key.');
  }
  const model = await getModel();
  const enrichedPayload = {
    ...payload,
    learnedRules: Array.isArray(payload.learnedRules) ? payload.learnedRules : [],
  };
  const pagePrompt = buildAgentPagePrompt(enrichedPayload);
  const docsPrompt = buildAgentDocsPrompt(enrichedPayload);
  const [pageCand, docsCand] = await Promise.all([
    callCandidate({ apiKey, model, prompt: pagePrompt }),
    callCandidate({ apiKey, model, prompt: docsPrompt }),
  ]);
  return { ...mergeCandidates(pageCand, docsCand), rawPage: pageCand.raw, rawDocs: docsCand.raw };
}

function buildChatPrompt({ question, history, goal, flowMode, currentStep, knowledge, dom, url, title }) {
  const { elementsCompact, headings } = dom ? formatDomForPrompt(dom) : { elementsCompact: '', headings: '' };

  const historyBlock = (history && history.length)
    ? history.map(t => `  ${t.role === 'user' ? 'USER' : 'AGENT'}: ${t.text}`).join('\n')
    : '  (no prior turns)';

  return `You are the CORRECTION ASSESSOR for an in-browser guide. The user clicked "Correct Agent If Wrong" because the agent picked the wrong thing. Your ONLY job is to LISTEN to their correction, analyze it against the live page, and decide whether you've understood and the user has agreed — OR whether you need to keep talking.

You do NOT tell the user what to do on the page. You do NOT guide them. You're a listener confirming understanding so the corrected rule can be saved.

GOAL: ${goal || '(none)'}
CURRENT STEP / ITERATION: ${currentStep || '(none)'}
flow mode: ${flowMode || '(unknown)'}

LIVE PAGE:
URL: ${url || '(unknown)'}
Title: ${title || '(unknown)'}

Section headings:
${headings || '  (none)'}

Interactive elements:
${elementsCompact || '  (none captured)'}${formatRawHtmlBlock(dom)}

KNOWLEDGE BASE (other authored flows for vocabulary):
${knowledge || '(empty)'}

CHAT HISTORY (oldest first):
${historyBlock}

USER'S NEW MESSAGE:
${question || '(empty)'}

Think:
A — What is the user correcting? Which element / behaviour are they pointing at?
B — Can you ground that in the LIVE PAGE? Which element matches what they described?
C — Is their intent clear, and have they explicitly confirmed your understanding?

Return ONLY raw JSON in this exact shape:
{
  "content": "<your reply to the user — short, conversational, 1-2 sentences. Either summarise your understanding and ASK them to confirm (e.g. \\"Got it, you mean the green Save button on the right — is that right?\\"), OR ask a clarifying question if their meaning is still unclear.>",
  "decision": "agreed" | "pending" | "disagreed",
  "reasoning": "<one sentence on why this decision>"
}

Decision rules:
- "agreed" — set ONLY when the user has explicitly confirmed your reading. Acceptance words: "yes", "correct", "exactly", "right", "that's it", "ok", "👍". On the user's FIRST correction message, do NOT preemptively mark agreed even if their direction is clear — summarise and ASK first; agreed comes on the next turn when they say yes.
- "disagreed" — the user contradicts the live page OR explicitly says you've still got it wrong and wants to bail.
- "pending" — default. Conversation is developing, more clarification needed, or you just asked a confirm-question and the user hasn't yet replied.

Style:
- "content" is conversational, NOT instructional. No "click X" / "do Y" — only confirming or clarifying.
- Keep it short. Don't dump page state at them.
- "content" never contains JSON / markdown fences — it's plain prose inside the JSON string.`;
}

// Distillation: after a chat exchange we ask the model to extract durable
// rules from the conversation that the step/agent runner should apply on
// subsequent iterations. Lets the user fix agent mistakes by chatting once
// instead of repeating the same correction every step.
function buildDistillRulesPrompt({ goal, chatHistory, existingRules, dom, url, title, currentStep }) {
  const turns = (chatHistory || []).slice(-6).map(t => `  ${t.role === 'user' ? 'USER' : 'AGENT'}: ${t.text}`).join('\n');
  const prev = (existingRules || []).map((r, i) => `  ${i + 1}. ${r}`).join('\n');
  const pageBlock = dom ? `\n\n${commonPageContext({ dom, url, title })}` : '';
  return `You are the RULE DISTILLER for an in-browser guide agent. The user just had a chat with the agent. Extract DURABLE corrections / app-specific knowledge from the conversation that the step picker should apply on the NEXT iterations. Use the LIVE PAGE as ground truth — your rules can reference specific elements you see on the current page.

GOAL the user is working on:
${goal || '(none — adhoc question)'}

CURRENT STEP / ITERATION:
${currentStep || '(none in progress)'}

EXISTING LEARNED RULES (don't repeat these; add new ones if applicable):
${prev || '  (none)'}

RECENT CHAT (most recent at the bottom):
${turns || '  (none)'}${pageBlock}

Now think:
A — What did the user correct or clarify in the chat?
B — Looking at the LIVE PAGE above, which element(s) does that correction map onto?
C — What durable rule(s) should future iterations follow to act on this knowledge?

Return ONLY raw JSON in this shape:
{
  "rules": [
    "<one short imperative rule the agent should follow next time>",
    "..."
  ]
}

Rules:
- Output 0-3 rules. Empty array if the chat was informational only (no correction, no new app knowledge).
- Rules MUST be specific (page-/app-/element-level), grounded in the live page when possible. Reference labels / placements / behaviour you can see.
- Each rule is one sentence, imperative voice.
- Do NOT repeat existing rules.
- Examples of good rules:
    "The green 'Save' button is in the top right of the form, not the orange 'Submit' in the dialog."
    "Customer dropdown needs typing first before options appear; don't try to click an empty dropdown."
    "After filling the form, click 'Add key result' (not 'Save')."
- Examples of bad rules (do not output):
    "Be careful." / "Follow the user's instructions."`;
}

async function distillRules(payload) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No DeepSeek API key set.');
  const model = await getModel();
  const prompt = buildDistillRulesPrompt(payload);
  const raw = await callDeepseek({ apiKey, model, system: SYSTEM_PROMPT, user: prompt, jsonMode: true });
  let parsed;
  try { parsed = parseJsonLoose(raw); } catch { parsed = {}; }
  const rules = Array.isArray(parsed.rules) ? parsed.rules.filter(s => typeof s === 'string' && s.trim()) : [];
  return rules.slice(0, 3);
}

async function chatStep(payload) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No DeepSeek API key set.');
  const model = await getModel();
  const prompt = buildChatPrompt(payload);
  const raw = await callDeepseek({ apiKey, model, system: SYSTEM_PROMPT, user: prompt, jsonMode: true });
  let parsed;
  try { parsed = parseJsonLoose(raw); } catch { parsed = {}; }
  const content = (typeof parsed.content === 'string' && parsed.content.trim()) || raw.trim() || '';
  const decision = ['agreed', 'pending', 'disagreed'].includes(parsed.decision) ? parsed.decision : 'pending';
  const reasoning = parsed.reasoning || '';
  return { content, decision, reasoning };
}

// Normalise a user-dropped markdown file into a canonical flow markdown.
// The user might supply: a numbered list with no frontmatter, multiple actions
// mashed into one bullet, a single sentence goal, a navigation step that
// belongs in the URL scope, etc. We send the raw text to DeepSeek and ask it
// to return canonical markdown the parser can ingest cleanly.
function buildIngestPrompt({ raw, filename }) {
  return `You are the FLOW INGESTION agent. Read arbitrary markdown a user dropped into the extension and produce CANONICAL flow markdown the parser can run. Input can be ANY shape: numbered list, bulleted list, paragraphs of prose, a single sentence goal, mixed sections, partial frontmatter, no frontmatter at all, headings out of order, multiple actions mashed into one line, etc. Your job is to extract intent and emit a clean flow.

CANONICAL OUTPUT FORMAT (exact shape the parser expects):

---
id: <kebab-case slug>
title: <human-readable title>
url: <Chrome-style glob — only include if a URL or host can be inferred>
mode: <"scripted" or "agent">
goal: <one sentence describing the end state the user wants to reach>
triggers:
  - <phrase 1>
  - <phrase 2>
---

# Title

## Step 1
<ONE concrete action>

## Step 2
<ONE concrete action>

(When mode is "agent" the ## Step sections are omitted and the body becomes free-form prose used as hints fed to the agent on every iteration.)

INPUT FILENAME: ${filename || '(unknown)'}

RAW INPUT:
"""
${raw}
"""

Rules — apply to any markdown shape, not just the example above:

1. **One concrete action per step.** If the input bundles multiple actions in one bullet/sentence (any phrasing that mashes verbs together), split them into separate ## Step N entries. A step like "open the menu and click Settings" becomes two steps.

2. **Strip navigation that just gets the user to a URL.** If any step is essentially "go to / navigate to / open <URL>", extract the URL into the \`url:\` frontmatter as a Chrome-style glob. **Always broaden to the host root** — e.g. \`https://app.example.com/login\` becomes \`https://app.example.com/*\`. Never pin the glob to a specific path or subpath unless the input EXPLICITLY restricts the flow to that path. The user routinely starts the same flow from any page on the host (dashboard, settings, deep links). Drop the navigate step from the list — the user is already on the host when they run the flow.

3. **Inline explanatory context.** If the input includes parenthetical definitions, clarifications, or examples for a step (e.g. "(option A means X, option B means Y)"), attach them to the relevant step's prose so the agent has the context. Don't drop nuance.

4. **High-level "fill the form" steps get expanded.** If a step refers vaguely to filling multiple fields or making multiple selections, enumerate each field as its own step.

5. **Mode pick:**
   - \`scripted\` — input is clearly a discrete list of steps the user wants performed in order. Most user-dropped flows.
   - \`agent\` — input is a single high-level goal with no enumerated steps, OR the steps depend heavily on the live page state.

6. **Frontmatter generation:**
   - \`id\`: kebab-case slug **derived from the INPUT FILENAME** (strip extension, lowercase, alphanumerics + dashes only). The filename is what the user picked to identify this specific flow — different files MUST get different ids even if their titles or contents are similar. Only fall back to a title-derived slug if the filename is missing or unhelpful (e.g. \`untitled.md\`).
   - \`title\`: derived from the first H1, or first line, or inferred from the goal. May differ from id.
   - \`url\`: only include when a URL/host can be inferred from the input.
   - \`goal\`: one sentence describing the destination/outcome.
   - \`triggers\`: 2-4 short phrases the user might say to invoke this flow ("create order", "new invoice", etc.). Keep them lowercase, no punctuation.

7. **Preserve user intent.** Don't invent steps the user didn't describe. Don't drop information they did describe. When in doubt, prefer fidelity over brevity.

8. **Output the canonical markdown ONLY.** No JSON wrapping. No code fences around the output. No prose before or after the markdown. The first line of your output must be \`---\`.`;
}

async function ingestFlow(payload) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No DeepSeek API key set.');
  const model = await getModel();
  const prompt = buildIngestPrompt(payload || {});
  const system = 'You output ONLY canonical markdown matching the schema the user describes. No JSON wrapping, no code fences around the markdown, no prose before or after.';
  let text = await callDeepseek({ apiKey, model, system, user: prompt, jsonMode: false });
  text = text.trim();
  // Strip fenced code block if the model wrapped anyway.
  const fence = text.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (fence) text = fence[1].trim();
  return text;
}

async function pingProvider() {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key set');
  const model = await getModel();
  const text = await callDeepseek({
    apiKey,
    model,
    system: 'Respond with the single word OK.',
    user: 'ping',
    jsonMode: false,
  });
  return text;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'TRANSLATE_STEP') {
    translateStep(msg.payload || {})
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'AGENT_STEP') {
    agentStep(msg.payload || {})
      .then(result => sendResponse({ ok: true, result }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'CHAT') {
    chatStep(msg.payload || {})
      .then(result => sendResponse({ ok: true, text: result.content, decision: result.decision, reasoning: result.reasoning }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'DISTILL_RULES') {
    distillRules(msg.payload || {})
      .then(rules => sendResponse({ ok: true, rules }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === 'INGEST_FLOW') {
    ingestFlow(msg.payload || {})
      .then(canonicalMd => sendResponse({ ok: true, canonicalMd }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  // Accept both new and legacy ping message names.
  if (msg.type === 'PING_PROVIDER' || msg.type === 'PING_ANTHROPIC') {
    pingProvider()
      .then(text => sendResponse({ ok: true, text }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  return false;
});
