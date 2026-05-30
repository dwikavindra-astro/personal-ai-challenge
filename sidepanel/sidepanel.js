// Dashboard Guide Agent — side panel
// Owns the flow loop. Bundled flows ship in flows/*.md; user-supplied flows
// arrive via drag-and-drop or the file picker and persist in chrome.storage.local.

// Bundled flows resolved at build time via @crxjs/vite + import.meta.glob.
const flowModules = import.meta.glob('../flows/*.md', { query: '?raw', import: 'default', eager: true });

const AGENT_MAX_ITER = 20;

const els = {
  flowList: document.getElementById('flowList'),
  askInput: document.getElementById('askInput'),
  askBtn: document.getElementById('askBtn'),
  log: document.getElementById('log'),
  openOptions: document.getElementById('openOptions'),
  bannerOptions: document.getElementById('bannerOptions'),
  keyBanner: document.getElementById('keyBanner'),
  dropZone: document.getElementById('dropZone'),
  addFlowBtn: document.getElementById('addFlowBtn'),
  addFlowInput: document.getElementById('addFlowInput'),
  dropZoneBusyLabel: document.getElementById('dropZoneBusyLabel'),
};

let flows = [];
let activeFlow = null;
let stepIndex = 0;
let agentState = null;
let busy = false;
// When the user explicitly hits Next or Prev we trust their move and do NOT
// let the state-assessor pull stepIndex back to where the page state implies.
let userOverrodeStep = false;
// Bumped by close / new-flow-start. In-flight step runners capture the value
// at entry and bail after every await if it's changed, so cancelled work
// never mutates state or paints an overlay.
let runEpoch = 0;
// Captured from the last completed scripted run so advance() can compare the
// user's intent with what the assessor actually saw on the page.
let lastAssessorIndex = null;
// Two-click override: when the user clicks Next while the page still looks
// like the current step, we don't jump ahead silently — we arm this flag,
// warn, and require a second Next click to actually advance.
let overrideArmed = false;
// Rules distilled from the user's in-flow chat. Injected into every agent
// / scripted prompt on subsequent steps so the user can fix mistakes via
// conversation. Reset on flow end.
let learnedRules = [];

init();

async function init() {
  wireUi();
  await loadFlows();
  await checkApiKey();
}

// -------- UI --------

function wireUi() {
  els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.bannerOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.askBtn.addEventListener('click', onAsk);
  els.askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onAsk();
  });

  // Drop zone + file picker
  els.addFlowBtn.addEventListener('click', () => els.addFlowInput.click());
  els.addFlowInput.addEventListener('change', async (e) => {
    await ingestFiles(Array.from(e.target.files || []));
    els.addFlowInput.value = '';
  });
  for (const ev of ['dragenter', 'dragover']) {
    els.dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropZone.classList.add('drag');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    els.dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropZone.classList.remove('drag');
    });
  }
  els.dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!e.dataTransfer || !e.dataTransfer.files) return;
    await ingestFiles(Array.from(e.dataTransfer.files));
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'STEP_ADVANCE') {
      if (!activeFlow) return;
      if (msg.action === 'next') advance(+1);
      else if (msg.action === 'prev') advance(-1);
      else if (msg.action === 'done') endFlow('done');
      else if (msg.action === 'close') endFlow('user-closed');
      return;
    }
    if (msg.type === 'PAGE_CHANGED') {
      handlePageChanged();
      return;
    }
    if (msg.type === 'CHAT_DONE') {
      handleChatDone(msg.payload || {});
      return;
    }
    if (msg.type === 'CHAT_QUERY') {
      handleChatQuery(msg.payload || {}, sender);
      return;
    }
  });
}

// -------- Page-state change handling --------
// Content fires PAGE_CHANGED whenever the live DOM diverges from what we
// last distilled. We rerun the current step against the new state so the
// agent's pick stays in sync — no manual click required. Debounce here in
// case multiple PAGE_CHANGED messages arrive in quick succession.
let pageChangeDebounce = 0;
let pageChangePending = false;

function handlePageChanged() {
  if (!activeFlow) return;
  if (busy) {
    // A run is already in flight — queue a rerun for when it settles.
    pageChangePending = true;
    return;
  }
  if (pageChangeDebounce) clearTimeout(pageChangeDebounce);
  pageChangeDebounce = setTimeout(async () => {
    pageChangeDebounce = 0;
    if (!activeFlow || busy) {
      if (busy) pageChangePending = true;
      return;
    }
    log('Page state changed — re-running current step.', 'info');
    if (activeFlow.mode === 'agent') {
      await runAgentStep({ isAutoRerun: true });
    } else {
      await runCurrentStep();
    }
    if (pageChangePending && !busy) {
      pageChangePending = false;
      handlePageChanged();
    }
  }, 400);
}

// -------- In-flow chat router --------

async function handleChatQuery(payload, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (!tabId) return;

  // Capture context for the chat call.
  const tab = await getActiveTab();
  const url = (tab && tab.url) || '';
  let dom = null;
  if (tab && tab.id === tabId) {
    const distill = await sendToTab(tabId, { type: 'DISTILL_DOM' }).catch(() => null);
    if (distill && distill.ok) dom = distill.dom;
  }

  const currentStepText = (() => {
    if (!activeFlow) return '';
    if (activeFlow.mode === 'agent') {
      return agentState ? `Iteration ${agentState.iter + 1}/${agentState.maxIter}. Last narration: ${agentState.lastNarration || '(none)'}.` : '';
    }
    const step = activeFlow.steps && activeFlow.steps[stepIndex];
    return step ? `Step ${stepIndex + 1}/${activeFlow.steps.length}: ${step.text}` : '';
  })();

  log(`Chat: ${payload.text}`, 'info');

  const resp = await chrome.runtime.sendMessage({
    type: 'CHAT',
    payload: {
      question: payload.text || '',
      history: Array.isArray(payload.history) ? payload.history : [],
      goal: activeFlow ? (activeFlow.goal || activeFlow.title || '') : '',
      flowMode: activeFlow ? activeFlow.mode : 'none',
      currentStep: currentStepText,
      knowledge: buildKnowledge(url),
      dom,
      url,
      title: dom ? dom.title : (tab && tab.title) || '',
    },
  });

  const reply = (resp && resp.ok) ? resp.text : '';
  const decision = (resp && resp.ok) ? resp.decision : 'pending';
  const error = (resp && !resp.ok) ? resp.error : null;
  if (error) log(`Chat error: ${error}`, 'error');
  else log(`Chat reply [${decision}]: ${reply.slice(0, 120)}${reply.length > 120 ? '…' : ''}`, decision === 'agreed' ? 'ok' : 'info');

  await sendToTab(tabId, {
    type: 'CHAT_REPLY',
    payload: { text: reply, error, decision },
  }).catch(() => {});
  // Note: we no longer auto-finalise on decision='agreed'. The content side
  // flips into agreed state (disables Send + Got it, enables Apply); the
  // user still has to explicitly click Apply to commit the correction.
}

async function handleChatDone(payload) {
  if (!activeFlow) return;
  const history = Array.isArray(payload.history) ? payload.history : [];
  if (history.length === 0) return;

  // Re-distil with the FULL conversation so the final rule reflects the
  // whole back-and-forth, not just one turn.
  const tab = await getActiveTab();
  let dom = null;
  let url = (tab && tab.url) || '';
  let title = (tab && tab.title) || '';
  if (tab && tab.id) {
    const distill = await sendToTab(tab.id, { type: 'DISTILL_DOM' }).catch(() => null);
    if (distill && distill.ok) {
      dom = distill.dom;
      url = dom.url;
      title = dom.title;
    }
  }
  const currentStepText = (() => {
    if (activeFlow.mode === 'agent') {
      return agentState ? `Iteration ${agentState.iter + 1}/${agentState.maxIter}. Last narration: ${agentState.lastNarration || '(none)'}.` : '';
    }
    const step = activeFlow.steps && activeFlow.steps[stepIndex];
    return step ? `Step ${stepIndex + 1}/${activeFlow.steps.length}: ${step.text}` : '';
  })();

  log('Distilling rules from the correction conversation…', 'info');
  await distillAndApplyRules({
    goal: activeFlow.goal || activeFlow.title || '',
    currentStep: currentStepText,
    chatTurns: history,
    dom,
    url,
    title,
  });
}

async function distillAndApplyRules({ goal, currentStep, chatTurns, dom, url, title }) {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'DISTILL_RULES',
      payload: {
        goal,
        currentStep,
        chatHistory: chatTurns,
        existingRules: learnedRules,
        dom,
        url,
        title,
      },
    });
    if (!resp || !resp.ok) {
      if (resp && resp.error) log(`Rule distillation failed: ${resp.error}`, 'warn');
      return;
    }
    const newRules = Array.isArray(resp.rules) ? resp.rules : [];
    if (newRules.length === 0) return;
    const added = [];
    for (const r of newRules) {
      if (!learnedRules.includes(r)) {
        learnedRules.push(r);
        added.push(r);
      }
    }
    if (added.length === 0) return;
    log(`Learned ${added.length} new rule(s) from chat:`, 'ok');
    for (const r of added) log(`  • ${r}`, 'info');

    // Persist into the user flow's raw markdown so future runs of this
    // flow start with the correction already applied. Only user flows are
    // mutable — bundled flows + adhoc questions stay ephemeral.
    if (activeFlow && activeFlow.source === 'user') {
      try {
        await persistRulesIntoUserFlow(activeFlow.id, learnedRules);
        log('Saved rules into the flow markdown.', 'ok');
      } catch (e) {
        log(`Couldn't persist rules: ${e && e.message || e}`, 'warn');
      }
    }

    // Close the chat pane and re-run the current step against the new
    // rules — the user agreed (the correction landed), so we don't keep
    // them sitting in the chat view.
    const activeTab = await getActiveTab();
    if (activeTab && activeTab.id) {
      await sendToTab(activeTab.id, { type: 'CLOSE_CHAT' }).catch(() => {});
    }
    log('Revising the step with the new rule(s)…', 'info');
    if (activeFlow && !busy) {
      if (activeFlow.mode === 'agent') {
        await runAgentStep({ isAutoRerun: true });
      } else {
        await runCurrentStep();
      }
    }
  } catch (e) {
    log(`Distillation error: ${e && e.message || e}`, 'warn');
  }
}

// Rewrite a user flow's raw markdown to carry the latest learned rules in
// its frontmatter under `rules:`. Parsed back on the next load via
// `meta.rules` → `flow.persistedRules`.
async function persistRulesIntoUserFlow(flowId, rules) {
  const { userFlows = [] } = await chrome.storage.local.get('userFlows');
  const idx = userFlows.findIndex(f => f.id === flowId);
  if (idx < 0) return;
  const entry = userFlows[idx];
  const oldRaw = entry.raw || '';
  const newRaw = upsertRulesFrontmatter(oldRaw, rules);
  if (newRaw === oldRaw) return;
  const next = [...userFlows];
  next[idx] = { ...entry, raw: newRaw, addedAt: entry.addedAt || new Date().toISOString() };
  await chrome.storage.local.set({ userFlows: next });
}

// Rewrite the frontmatter to include `rules:` as a multi-line YAML list.
// Replaces an existing rules block if present. Returns the new markdown.
function upsertRulesFrontmatter(raw, rules) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  let frontmatter = '';
  let body = raw;
  if (m) { frontmatter = m[1]; body = m[2]; }
  // Strip any existing rules: block (the key line + its indented list items).
  const lines = frontmatter.split('\n');
  const stripped = [];
  let skipping = false;
  for (const line of lines) {
    if (/^rules\s*:\s*$/.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (/^\s+-\s+/.test(line)) continue;
      skipping = false;
    }
    stripped.push(line);
  }
  // Append fresh rules block.
  const rulesBlock = rules.length
    ? ['rules:', ...rules.map(r => `  - ${escapeYamlScalar(r)}`)].join('\n')
    : '';
  const newFm = [stripped.join('\n').trimEnd(), rulesBlock].filter(Boolean).join('\n');
  return `---\n${newFm}\n---\n${body}`;
}

function escapeYamlScalar(s) {
  if (!s) return '""';
  // Quote if it contains anything yamlish.
  if (/[:#&*!|>'"%@`{}\[\],]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

// -------- Flow loading (bundled + user) --------

async function loadFlows() {
  const bundled = [];
  for (const [path, raw] of Object.entries(flowModules)) {
    try {
      const flow = parseFlow(raw, path);
      if (flow) bundled.push({ ...flow, source: 'bundled' });
    } catch (e) {
      console.warn('[dga] failed to parse bundled flow', path, e);
    }
  }

  const { userFlows = [] } = await chrome.storage.local.get('userFlows');
  const user = [];
  for (const entry of userFlows) {
    try {
      const flow = parseFlow(entry.raw, entry.id);
      if (flow) user.push({ ...flow, source: 'user', addedAt: entry.addedAt });
    } catch (e) {
      console.warn('[dga] failed to parse user flow', entry.id, e);
    }
  }

  // User flows shadow bundled flows with the same id.
  const userIds = new Set(user.map(f => f.id));
  const dedupedBundled = bundled.filter(f => {
    if (userIds.has(f.id)) {
      console.warn(`[dga] user flow "${f.id}" shadows bundled flow with same id`);
      return false;
    }
    return true;
  });

  dedupedBundled.sort((a, b) => a.title.localeCompare(b.title));
  user.sort((a, b) => a.title.localeCompare(b.title));

  flows = [...dedupedBundled, ...user];
  renderFlows();
}

// Parallel ingestion. Spawns one ingestion agent call per file, awaits all,
// then refreshes the flow list ONCE at the end so the side panel doesn't
// thrash with N renders.
// Each file runs its own ingestion-agent LLM call fully in parallel. The
// only serialised step is the chrome.storage.local read-modify-write that
// persists the flow — without that the parallel calls would race and the
// last-writer would drop the earlier additions. The save queue keeps the
// LLM calls fully concurrent and only blocks at the storage write.
let saveQueue = Promise.resolve();

async function ingestFiles(files) {
  const mdFiles = files.filter(f => f && /\.md$/i.test(f.name));
  const skipped = files.filter(f => f && !/\.md$/i.test(f.name));
  for (const f of skipped) log(`Skipped "${f.name}" — not a .md file.`, 'warn');
  if (mdFiles.length === 0) return;
  if (mdFiles.length > 1) {
    log(`Ingesting ${mdFiles.length} files in parallel…`, 'info');
  }
  setIngestBusy(mdFiles.length);
  try {
    await Promise.all(mdFiles.map(ingestOne));
  } finally {
    setIngestBusy(0);
  }
  await loadFlows();
}

function setIngestBusy(count) {
  if (count > 0) {
    els.dropZone.classList.add('busy');
    els.dropZone.querySelector('.drop-zone-busy').hidden = false;
    if (els.dropZoneBusyLabel) {
      els.dropZoneBusyLabel.textContent = count === 1
        ? 'Normalising flow with agent…'
        : `Normalising ${count} flows with agent…`;
    }
  } else {
    els.dropZone.classList.remove('busy');
    els.dropZone.querySelector('.drop-zone-busy').hidden = true;
  }
}

async function ingestOne(file) {
  let raw;
  try {
    raw = await file.text();
  } catch (e) {
    log(`Couldn't read "${file.name}": ${e.message}`, 'error');
    return;
  }

  log(`Ingesting "${file.name}" — normalising with agent…`, 'info');
  let mdToSave = raw;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'INGEST_FLOW',
      payload: { raw, filename: file.name },
    });
    if (resp && resp.ok && typeof resp.canonicalMd === 'string' && resp.canonicalMd.trim()) {
      mdToSave = resp.canonicalMd.trim();
      log(`Normalised "${file.name}" via agent.`, 'ok');
    } else {
      log(`Ingestion agent unavailable for "${file.name}": ${resp && resp.error || 'no response'}. Saving raw markdown.`, 'warn');
    }
  } catch (e) {
    log(`Ingestion error for "${file.name}": ${e && e.message || e}. Saving raw markdown.`, 'warn');
  }

  let parsed;
  try {
    parsed = parseFlow(mdToSave, file.name);
    if (!parsed || !parsed.id) {
      throw new Error('flow has no id (set id: in frontmatter or rely on ingestion agent)');
    }
  } catch (err) {
    log(`Couldn't parse "${file.name}": ${err.message}`, 'error');
    return;
  }

  // Serialise the storage write so parallel ingests don't clobber each other,
  // while keeping the LLM calls above fully concurrent.
  saveQueue = saveQueue.then(() => saveUserFlow({
    id: parsed.id,
    raw: mdToSave,
    addedAt: new Date().toISOString(),
  }));
  try {
    await saveQueue;
    log(`Added flow "${parsed.title}" (mode: ${parsed.mode}, ${parsed.steps.length} steps).`, 'ok');
  } catch (err) {
    log(`Couldn't save "${file.name}": ${err && err.message || err}`, 'error');
  }
}

// Back-compat wrapper.
async function ingestFile(file) {
  await ingestFiles([file]);
}

async function saveUserFlow(entry) {
  const { userFlows = [] } = await chrome.storage.local.get('userFlows');
  const next = userFlows.filter(f => f.id !== entry.id);
  next.push(entry);
  await chrome.storage.local.set({ userFlows: next });
}

async function deleteUserFlow(id) {
  const { userFlows = [] } = await chrome.storage.local.get('userFlows');
  await chrome.storage.local.set({ userFlows: userFlows.filter(f => f.id !== id) });
  log(`Deleted flow "${id}".`, 'info');
  await loadFlows();
}

// -------- Rendering --------

function renderFlows() {
  els.flowList.innerHTML = '';

  if (flows.length === 0) {
    els.flowList.innerHTML = '<div class="log-entry info">No flows yet. Drop a .md file above to add one.</div>';
    return;
  }

  const bundled = flows.filter(f => f.source === 'bundled');
  const user = flows.filter(f => f.source === 'user');

  if (user.length === 0) {
    for (const f of bundled) els.flowList.appendChild(renderFlowItem(f));
    return;
  }

  if (bundled.length > 0) {
    const h = document.createElement('div');
    h.className = 'flow-group-title';
    h.textContent = 'Bundled';
    els.flowList.appendChild(h);
    for (const f of bundled) els.flowList.appendChild(renderFlowItem(f));
  }

  const h2 = document.createElement('div');
  h2.className = 'flow-group-title';
  h2.textContent = 'Your flows';
  els.flowList.appendChild(h2);
  for (const f of user) els.flowList.appendChild(renderFlowItem(f));
}

function renderFlowItem(flow) {
  const btn = document.createElement('button');
  btn.className = 'flow-item';
  btn.type = 'button';
  btn.dataset.id = flow.id;

  const title = document.createElement('span');
  title.className = 'flow-title';
  title.textContent = flow.title;

  const meta = document.createElement('span');
  meta.className = 'flow-meta';
  const scope = flow.urlPatterns && flow.urlPatterns.length ? flow.urlPatterns.join(', ') : 'any page';
  const modeLabel = flow.mode === 'agent' ? 'agent' : `${flow.steps.length} steps`;
  meta.textContent = `${modeLabel} · ${scope}`;

  btn.appendChild(title);
  btn.appendChild(meta);
  btn.addEventListener('click', () => startFlow(flow));

  if (flow.source === 'user') {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'flow-delete';
    del.title = 'Delete this flow';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteUserFlow(flow.id);
    });
    btn.appendChild(del);
  }

  return btn;
}

function markActiveFlow(flowId) {
  for (const node of els.flowList.querySelectorAll('.flow-item')) {
    node.classList.toggle('active', node.dataset.id === flowId);
  }
}

async function checkApiKey() {
  const { deepseekApiKey, anthropicApiKey } = await chrome.storage.local.get(['deepseekApiKey', 'anthropicApiKey']);
  const hasKey = !!(deepseekApiKey || anthropicApiKey);
  els.keyBanner.classList.toggle('hidden', hasKey);
}

function log(msg, level = 'info') {
  const row = document.createElement('div');
  row.className = `log-entry ${level}`;
  row.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
}

// -------- Flow lifecycle --------

async function onAsk() {
  const q = els.askInput.value.trim();
  if (!q || busy) return;

  const matched = matchTrigger(q);
  if (matched) {
    log(`Matched flow: ${matched.title}`, 'ok');
    startFlow(matched);
    return;
  }
  // No trigger match → adhoc agent flow. The agent loop has the full knowledge
  // base of authored flows injected into every call, so it can correlate the
  // question against what the user has documented.
  log(`No trigger matched "${q}" — running agent with your knowledge base.`, 'info');
  startFlow({
    id: 'adhoc',
    title: q,
    triggers: [],
    urlPatterns: [],
    mode: 'agent',
    goal: q,
    hints: '',
    steps: [],
    source: 'adhoc',
  });
}

// Aggregate every parsed flow into a compact knowledge corpus that the agent
// gets on every iteration. Lets the model correlate the user's question
// (e.g. "how do I add an order?") with what the user has authored
// (e.g. the add-order flow's hints about the customer dropdown).
function buildKnowledge(currentUrl) {
  if (!flows || flows.length === 0) return '';
  const sections = [];
  for (const f of flows) {
    if (!f) continue;
    // Skip the adhoc flow itself if it ever sneaks in.
    if (f.source === 'adhoc') continue;
    // Prefer flows scoped to the current page, but include unscoped ones too.
    const scopeRelevant = !f.urlPatterns || f.urlPatterns.length === 0
      ? true
      : f.urlPatterns.some(g => urlMatchesGlob(currentUrl, g));
    if (!scopeRelevant && currentUrl) continue;

    const scope = (f.urlPatterns && f.urlPatterns.length) ? f.urlPatterns.join(', ') : 'any page';
    const lines = [
      `--- FLOW: ${f.title} (id=${f.id}) ---`,
      `scope: ${scope}`,
      `mode: ${f.mode}`,
    ];
    if (f.mode === 'agent') {
      if (f.goal) lines.push(`goal: ${truncate(f.goal, 200)}`);
      if (f.hints) lines.push(`hints: ${truncate(f.hints, 500)}`);
    } else {
      const stepsText = (f.steps || []).map((s, i) => `  ${i + 1}. ${s.text}`).join('\n');
      if (stepsText) lines.push(`steps:\n${truncate(stepsText, 600)}`);
    }
    sections.push(lines.join('\n'));
    if (sections.join('\n\n').length > 3500) break;
  }
  return sections.join('\n\n');
}

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function matchTrigger(query) {
  const q = query.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const f of flows) {
    for (const t of f.triggers) {
      const tl = t.toLowerCase();
      if (q.includes(tl) || tl.includes(q)) {
        const score = Math.min(tl.length, q.length);
        if (score > bestScore) {
          best = f;
          bestScore = score;
        }
      }
    }
  }
  return best;
}

async function startFlow(flow) {
  // If a flow is currently running, cancel it AND hard-reload the tab so the
  // new flow starts from a clean page state. Without the reload we'd re-use
  // whatever half-finished state the prior flow left behind (filled fields,
  // open dialogs, scroll position).
  const wasMidFlow = !!(activeFlow || busy);
  if (wasMidFlow) {
    log(`Cancelling current flow to start "${flow.title}".`, 'info');
    await endFlow('user-switched');
    if (els.log) els.log.innerHTML = '';
    const reloadTab = await getActiveTab();
    if (reloadTab && reloadTab.id) {
      log('Reloading the tab for a clean view…', 'info');
      try {
        await chrome.tabs.reload(reloadTab.id);
        await waitForTabReady(reloadTab.id, 10000);
      } catch (e) {
        log(`Tab reload failed: ${e && e.message || e}`, 'warn');
      }
    }
  }
  const tab = await getActiveTab();
  const url = tab && tab.url;
  if (!flowMatchesUrl(flow, url)) {
    const expected = flow.urlPatterns.join(' or ');
    log(`"${flow.title}" only runs on ${expected}. Current tab: ${url || 'unknown'}.`, 'error');
    return;
  }
  activeFlow = flow;
  markActiveFlow(flow.id);
  els.askInput.value = '';
  // Seed learnedRules with any persisted corrections from the flow's
  // frontmatter so prior chat-distilled rules apply on this run.
  learnedRules = Array.isArray(flow.persistedRules) ? [...flow.persistedRules] : [];
  if (learnedRules.length) {
    log(`Loaded ${learnedRules.length} persisted rule(s) from this flow.`, 'info');
  }

  if (flow.mode === 'agent') {
    agentState = {
      history: [],
      pendingSuggestion: null,
      iter: 0,
      maxIter: AGENT_MAX_ITER,
      lastNarration: '',
    };
    log(`Starting agent flow "${flow.title}" (goal: ${flow.goal})`, 'ok');
    await runAgentStep();
  } else {
    stepIndex = 0;
    log(`Starting "${flow.title}" (${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'})`, 'ok');
    await runCurrentStep();
  }
}

async function advance(delta) {
  if (!activeFlow) return;

  // Both modes: the user just interacted with the highlighted element, so
  // any click that triggers navigation needs to be waited out before the
  // next step. Otherwise the next distill races a half-loaded page and the
  // LLM picks against stale DOM.
  const tab = await getActiveTab();
  if (tab && tab.id) await waitForTabReady(tab.id, 8000);
  await sleep(150);

  if (activeFlow.mode === 'agent') {
    if (agentState && agentState.pendingSuggestion) {
      agentState.history.push({
        ...agentState.pendingSuggestion,
        completedAt: new Date().toISOString(),
      });
      agentState.pendingSuggestion = null;
    }
    await runAgentStep();
    return;
  }

  const next = stepIndex + delta;
  if (next >= activeFlow.steps.length) {
    endFlow('done');
    return;
  }
  if (next < 0) return;

  // Two-click override for forward jumps: if the assessor's last read said
  // the page is still on the current step and the user hits Next, refuse the
  // first click. Warn them; require a second Next to actually advance. This
  // stops us from racing to step 3 while the user is still working on step 2.
  if (delta === +1
      && lastAssessorIndex !== null
      && lastAssessorIndex === stepIndex
      && !overrideArmed) {
    overrideArmed = true;
    log(`Page still looks like step ${stepIndex + 1}. Finish it first, or click Next again to skip ahead anyway.`, 'warn');
    return;
  }

  if (delta !== 0) userOverrodeStep = true;
  overrideArmed = false;
  stepIndex = next;
  await runCurrentStep();
}

async function endFlow(reason) {
  const level = reason === 'cap-reached' ? 'warn'
    : reason === 'goal-complete' ? 'ok'
    : 'ok';
  log(`Flow ended (${reason}).`, level);
  // Cancel any in-flight step runners — they'll bail on their next await.
  runEpoch += 1;
  activeFlow = null;
  stepIndex = 0;
  agentState = null;
  userOverrodeStep = false;
  lastAssessorIndex = null;
  overrideArmed = false;
  learnedRules = [];
  busy = false;
  els.askBtn.disabled = false;
  markActiveFlow(null);
  await sendToActiveTab({ type: 'CLEAR_OVERLAY' }).catch(() => {});
}

// -------- Scripted runner --------

async function runCurrentStep() {
  if (!activeFlow || busy) return;
  const myEpoch = ++runEpoch;
  busy = true;
  els.askBtn.disabled = true;
  try {
    const step = activeFlow.steps[stepIndex];
    log(`Step ${stepIndex + 1}/${activeFlow.steps.length}: ${step.text}`, 'info');

    const prep = await prepareTabForStep();
    if (myEpoch !== runEpoch) return;
    if (!prep) return;
    const { tab, dom } = prep;

    const translate = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_STEP',
      payload: {
        stepText: step.text,
        stepIndex,
        totalSteps: activeFlow.steps.length,
        completedSteps: activeFlow.steps.slice(0, stepIndex).map(s => s.text),
        remainingSteps: activeFlow.steps.slice(stepIndex + 1).map(s => s.text),
        flowTitle: activeFlow.title,
        flowGoal: activeFlow.goal || activeFlow.title,
        hints: activeFlow.hints || '',
        knowledge: buildKnowledge(dom.url),
        learnedRules,
        dom,
        url: dom.url,
        title: dom.title,
      },
    });
    if (myEpoch !== runEpoch) return;
    if (!translate || !translate.ok) {
      log(`Translate failed: ${translate && translate.error}`, 'error');
      return;
    }
    const t = translate.result;
    logTranslation(t);

    // Reconciling user override vs state assessor:
    //   • No override + assessor disagrees → assessor wins (fast-forward).
    //   • Override + assessor agrees → fine, user is in sync.
    //   • Override + assessor disagrees → user pin wins, BUT discount
    //     confidence and surface a warning so the user knows the page state
    //     doesn't match where they think they are. Often happens when the
    //     user clicks Next before actually completing the previous step.
    let overrideMismatch = false;
    if (userOverrodeStep) {
      if (typeof t.suggestedStepIndex === 'number'
          && t.suggestedStepIndex !== stepIndex
          && t.suggestedStepIndex >= 0
          && t.suggestedStepIndex < activeFlow.steps.length) {
        overrideMismatch = true;
        log(`User pinned step ${stepIndex + 1} but assessor reads the page as step ${t.suggestedStepIndex + 1}. Continuing with the user's pick — confidence reduced.`, 'warn');
      } else {
        log(`User pinned step ${stepIndex + 1}; assessor agrees.`, 'info');
      }
    } else if (typeof t.suggestedStepIndex === 'number'
        && t.suggestedStepIndex !== stepIndex
        && t.suggestedStepIndex >= 0
        && t.suggestedStepIndex < activeFlow.steps.length) {
      const direction = t.suggestedStepIndex > stepIndex ? 'forward' : 'back';
      log(`State assessor moved pointer ${direction} to step ${t.suggestedStepIndex + 1}.`, 'warn');
      stepIndex = t.suggestedStepIndex;
    }
    userOverrodeStep = false;

    // Cache the assessor's read so advance() can require a two-click confirm
    // when the user tries to skip ahead while the page is still on this step.
    lastAssessorIndex = typeof t.suggestedStepIndex === 'number'
      ? t.suggestedStepIndex
      : stepIndex;

    // Apply the mismatch penalty to the final pick.
    if (overrideMismatch) {
      t.confidence = Math.min(t.confidence, 0.4);
      t.blocker = (t.blocker ? `${t.blocker}\n\n` : '')
        + `Heads up: the page looks like it's still on step ${(t.suggestedStepIndex ?? stepIndex) + 1}, but you advanced manually. The highlight below might be wrong — close the guide and finish the previous step if needed.`;
    }

    const isLast = stepIndex === activeFlow.steps.length - 1;
    await sendToTab(tab.id, {
      type: 'SHOW_OVERLAY',
      payload: {
        selector: t.selector,
        alternatives: Array.isArray(t.alternatives) ? t.alternatives : [],
        narration: t.narration,
        stepIndex,
        totalSteps: activeFlow.steps.length,
        confidence: t.confidence,
        blocker: t.blocker,
        isLast,
        isAgent: false,
      },
    });
  } catch (e) {
    log(`Step error: ${e && e.message || e}`, 'error');
  } finally {
    busy = false;
    els.askBtn.disabled = false;
  }
}

// -------- Agent runner --------

async function runAgentStep(opts = {}) {
  const { isAutoRerun = false } = opts;
  if (!activeFlow || activeFlow.mode !== 'agent' || busy) return;
  if (!agentState) return;
  if (agentState.iter >= agentState.maxIter) {
    endFlow('cap-reached');
    return;
  }
  const myEpoch = ++runEpoch;
  busy = true;
  els.askBtn.disabled = true;
  try {
    log(`Agent iteration ${agentState.iter + 1}/${agentState.maxIter} — goal: ${activeFlow.goal}`, 'info');

    const prep = await prepareTabForStep();
    if (myEpoch !== runEpoch) return;
    if (!prep) return;
    const { tab, dom } = prep;

    const knowledge = buildKnowledge(dom.url);
    const resp = await chrome.runtime.sendMessage({
      type: 'AGENT_STEP',
      payload: {
        goal: activeFlow.goal,
        hints: activeFlow.hints || '',
        knowledge,
        learnedRules,
        history: agentState.history,
        dom,
        url: dom.url,
        title: dom.title,
        iter: agentState.iter,
        maxIter: agentState.maxIter,
      },
    });
    if (myEpoch !== runEpoch) return;
    if (!resp || !resp.ok) {
      log(`Agent call failed: ${resp && resp.error}`, 'error');
      return;
    }
    const t = resp.result;
    logTranslation(t);

    // Park the suggestion as PENDING. It only gets committed to history
    // when the user actually interacts (STEP_ADVANCE 'next' in advance()).
    if (t.selector) {
      agentState.pendingSuggestion = { url: dom.url, selector: t.selector, narration: t.narration };
    } else {
      agentState.pendingSuggestion = null;
    }
    agentState.lastNarration = t.narration;

    if (t.done === true) {
      // Show the celebratory tooltip briefly, then end.
      await sendToTab(tab.id, {
        type: 'SHOW_OVERLAY',
        payload: {
          selector: t.selector,
          narration: t.narration || 'Goal complete.',
          stepIndex: agentState.iter,
          totalSteps: 0,
          confidence: t.confidence,
          blocker: t.blocker,
          isLast: true,
          isAgent: true,
          iter: agentState.iter,
          maxIter: agentState.maxIter,
        },
      });
      setTimeout(() => endFlow('goal-complete'), 1200);
      return;
    }

    await sendToTab(tab.id, {
      type: 'SHOW_OVERLAY',
      payload: {
        selector: t.selector,
        alternatives: Array.isArray(t.alternatives) ? t.alternatives : [],
        narration: t.narration,
        stepIndex: agentState.iter,
        totalSteps: 0,
        confidence: t.confidence,
        blocker: t.blocker,
        isLast: false,
        isAgent: true,
        iter: agentState.iter,
        maxIter: agentState.maxIter,
      },
    });

    if (!isAutoRerun) agentState.iter += 1;
  } catch (e) {
    log(`Agent step error: ${e && e.message || e}`, 'error');
  } finally {
    busy = false;
    els.askBtn.disabled = false;
  }
}

function logTranslation(t) {
  const conf = typeof t.confidence === 'number' ? `${(t.confidence * 100).toFixed(0)}%` : '?';
  const level = (t.confidence || 0) < 0.5 ? 'warn' : 'ok';
  if (t.currentState) log(`  where I am: ${t.currentState}`, 'info');
  if (t.progressAssessment) log(`  progress: ${t.progressAssessment}`, 'info');

  // Agent-mode dual candidates (page + docs).
  if (t.candidateFromPage) {
    const c = t.candidateFromPage;
    const cc = typeof c.confidence === 'number' ? `${(c.confidence * 100).toFixed(0)}%` : '?';
    log(`  page-only candidate: ${c.selector || '(none)'} [${cc}] — ${c.reasoning || ''}`, 'info');
  }
  if (t.candidateFromDocs) {
    const c = t.candidateFromDocs;
    const cc = typeof c.confidence === 'number' ? `${(c.confidence * 100).toFixed(0)}%` : '?';
    log(`  doc-only candidate:  ${c.selector || '(none)'} [${cc}] — ${c.reasoning || ''}`, 'info');
  }
  if (t.chosen) log(`  chose: ${t.chosen}`, 'info');

  // Scripted-mode per-step candidates.
  if (Array.isArray(t.perStepCandidates)) {
    for (const c of t.perStepCandidates) {
      const cc = typeof c.confidence === 'number' ? `${(c.confidence * 100).toFixed(0)}%` : '?';
      const mark = c.applicableNow ? '★' : ' ';
      log(`  ${mark} step ${c.stepIndex + 1}: ${c.selector || '(none)'} [${cc}] — ${c.reasoning || ''}`, c.applicableNow ? 'ok' : 'info');
    }
  }
  if (t.freeFormCandidate) {
    const f = t.freeFormCandidate;
    const fc = typeof f.confidence === 'number' ? `${(f.confidence * 100).toFixed(0)}%` : '?';
    log(`  ⚡ free-form (invent own): ${f.selector || '(none)'} [${fc}] — ${f.reasoning || ''}`, 'info');
  }
  if (Array.isArray(t.doneStepIndices) && t.doneStepIndices.length) {
    log(`  state assessor marks done: steps ${t.doneStepIndices.map(i => i + 1).join(', ')}`, 'info');
  }
  if (typeof t.suggestedStepIndex === 'number') {
    log(`  state assessor suggests step ${t.suggestedStepIndex + 1}`, 'info');
  }
  if (t.chosenSource) log(`  orchestrator chose: ${t.chosenSource}`, 'info');

  log(`Picked: ${t.selector || '(none)'}  [conf ${conf}]`, level);
  if (t.reasoning) log(`  reason: ${t.reasoning}`, 'info');
  if (t.blocker) log(`  blocker: ${t.blocker}`, 'warn');
  if (t.done) log('  agent reports goal complete', 'ok');
}

// -------- Shared step prelude --------

async function prepareTabForStep() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    log('No active tab.', 'error');
    return null;
  }
  if (!isInjectableUrl(tab.url)) {
    log(`Cannot guide on this page (${tab.url || 'unknown URL'}). Open a regular site first.`, 'error');
    return null;
  }
  if (!flowMatchesUrl(activeFlow, tab.url)) {
    const expected = activeFlow.urlPatterns.join(' or ');
    log(`Active tab navigated away from ${expected}. Stopping flow.`, 'error');
    endFlow('navigated-away');
    return null;
  }
  let pong = null;
  for (let i = 0; i < 15; i++) {
    pong = await sendToTab(tab.id, { type: 'PING' }).catch(() => null);
    if (pong && pong.ok) break;
    await sleep(250);
  }
  if (!pong || !pong.ok) {
    log('Content script not loaded on this tab. Reload the page once after installing.', 'error');
    return null;
  }
  // Show "thinking" UI on the tooltip while we re-distill + call the LLMs.
  // Fire-and-forget; we don't care if the message races a content reload.
  sendToTab(tab.id, {
    type: 'SHOW_LOADING',
    payload: { label: 'Re-checking page state…' },
  }).catch(() => {});
  const distill = await sendToTab(tab.id, { type: 'DISTILL_DOM' });
  if (!distill || !distill.ok) {
    log(`Distiller failed: ${distill && distill.error}`, 'error');
    return null;
  }
  log(`Distilled ${distill.dom.elements.length} interactive elements.`, 'info');
  return { tab, dom: distill.dom };
}

// -------- Tab helpers --------

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0];
}

function isInjectableUrl(url) {
  if (!url) return false;
  return /^https?:\/\//.test(url) || url.startsWith('file://');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Resolve when the tab is fully loaded again. Used after a user click that
// might be navigating away. Gives the click ~200ms to trigger navigation,
// then waits for tabs.onUpdated status='complete' (or already-complete).
function waitForTabReady(tabId, maxMs = 8000) {
  return new Promise(async (resolve) => {
    // Give the click a beat to flip the tab into 'loading' if it's going to.
    await sleep(200);
    let initial;
    try {
      initial = await chrome.tabs.get(tabId);
    } catch (e) {
      resolve(false);
      return;
    }
    if (!initial || initial.status === 'complete') {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(ok);
    };
    const onUpdated = (id, info, tab) => {
      if (id !== tabId) return;
      if (info && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => finish(false), maxMs);
  });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(resp);
    });
  });
}

async function sendToActiveTab(msg) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return null;
  return sendToTab(tab.id, msg);
}

// -------- Flow parser --------

function parseFlow(raw, path) {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  let meta = {};
  let body = raw;
  if (fm) {
    meta = parseFrontmatter(fm[1]);
    body = fm[2];
  }

  // Parse H2 sections into scripted steps.
  const steps = [];
  const lines = body.split('\n');
  let current = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      if (current) steps.push(current);
      current = { index: steps.length, header: h2[1].trim(), text: '' };
      continue;
    }
    if (current) {
      if (current.text) current.text += ' ';
      current.text += line.trim();
    }
  }
  if (current) steps.push(current);
  for (const s of steps) s.text = s.text.replace(/\s+/g, ' ').trim();

  const id = meta.id || path.split('/').pop().replace(/\.md$/, '');
  const title = meta.title || id;
  const triggers = Array.isArray(meta.triggers) ? meta.triggers : [];
  // Persisted corrections from prior chat sessions. Survive across runs of
  // the same user flow (lives in the flow's frontmatter).
  const persistedRules = Array.isArray(meta.rules) ? meta.rules.filter(s => typeof s === 'string') : [];

  let urlPatterns = [];
  if (typeof meta.url === 'string' && meta.url) urlPatterns = [meta.url];
  else if (Array.isArray(meta.url)) urlPatterns = meta.url.filter(s => typeof s === 'string' && s);

  // Mode resolution (precedence: explicit mode > goal+no-h2 > h2-default > scripted).
  const explicitMode = typeof meta.mode === 'string' ? meta.mode.toLowerCase() : null;
  let mode;
  if (explicitMode === 'agent') mode = 'agent';
  else if (explicitMode === 'scripted') mode = 'scripted';
  else if (steps.length === 0 && meta.goal) mode = 'agent';
  else mode = 'scripted';

  // Defensive: a scripted flow with zero parsed steps can't run. Fall back to
  // agent mode so the flow at least executes against the live page using the
  // body prose as hints. The user dropped something the parser couldn't
  // extract steps from — better to guess intent than crash on undefined.text.
  if (mode === 'scripted' && steps.length === 0) {
    mode = 'agent';
  }

  // Body becomes agent hints: strip first H1, collapse whitespace.
  const hints = body
    .replace(/^#\s+.*$/m, '')
    .replace(/\s+/g, ' ')
    .trim();

  const goal = (typeof meta.goal === 'string' && meta.goal.trim()) || title || id;

  return { id, title, triggers, urlPatterns, mode, goal, hints, steps, persistedRules };
}

function urlMatchesGlob(url, glob) {
  if (!url || !glob) return false;
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp('^' + escaped + '$');
  return re.test(url);
}

function flowMatchesUrl(flow, url) {
  if (!flow.urlPatterns || flow.urlPatterns.length === 0) return true;
  return flow.urlPatterns.some(g => urlMatchesGlob(url, g));
}

function parseFrontmatter(text) {
  const out = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest === '') {
      const list = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        list.push(lines[i].replace(/^\s+-\s+/, '').trim());
        i++;
      }
      out[key] = list;
      continue;
    }
    out[key] = stripQuotes(rest);
    i++;
  }
  return out;
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
