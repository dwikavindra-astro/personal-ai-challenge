const els = {
  apiKey: document.getElementById('apiKey'),
  model: document.getElementById('model'),
  thinkingMode: document.getElementById('thinkingMode'),
  reasoningEffort: document.getElementById('reasoningEffort'),
  save: document.getElementById('save'),
  test: document.getElementById('test'),
  clear: document.getElementById('clear'),
  toggle: document.getElementById('toggleVisibility'),
  status: document.getElementById('status'),
};

load();
els.save.addEventListener('click', save);
els.test.addEventListener('click', test);
els.clear.addEventListener('click', clearKey);
els.toggle.addEventListener('click', toggleVisibility);

async function load() {
  const { deepseekApiKey, anthropicApiKey, model, thinkingMode, reasoningEffort } = await chrome.storage.local.get([
    'deepseekApiKey', 'anthropicApiKey', 'model', 'thinkingMode', 'reasoningEffort',
  ]);
  const existing = deepseekApiKey || anthropicApiKey || '';
  if (existing) els.apiKey.value = existing;
  if (model && Array.from(els.model.options).some(o => o.value === model)) {
    els.model.value = model;
  }
  if (thinkingMode && Array.from(els.thinkingMode.options).some(o => o.value === thinkingMode)) {
    els.thinkingMode.value = thinkingMode;
  }
  if (reasoningEffort && Array.from(els.reasoningEffort.options).some(o => o.value === reasoningEffort)) {
    els.reasoningEffort.value = reasoningEffort;
  }
}

async function save() {
  const key = els.apiKey.value.trim();
  const model = els.model.value;
  const thinkingMode = els.thinkingMode.value;
  const reasoningEffort = els.reasoningEffort.value;
  await chrome.storage.local.set({
    deepseekApiKey: key,
    model,
    thinkingMode,
    reasoningEffort,
  });
  await chrome.storage.local.remove('anthropicApiKey');
  show(key ? 'Saved. You can close this tab.' : 'Cleared.', 'ok');
}

async function clearKey() {
  els.apiKey.value = '';
  await chrome.storage.local.remove(['deepseekApiKey', 'anthropicApiKey']);
  show('API key cleared.', 'info');
}

function toggleVisibility() {
  const isPwd = els.apiKey.type === 'password';
  els.apiKey.type = isPwd ? 'text' : 'password';
  els.toggle.textContent = isPwd ? 'Hide' : 'Show';
}

async function test() {
  show('Testing...', 'info');
  await chrome.storage.local.set({
    deepseekApiKey: els.apiKey.value.trim(),
    model: els.model.value,
    thinkingMode: els.thinkingMode.value,
    reasoningEffort: els.reasoningEffort.value,
  });
  await chrome.storage.local.remove('anthropicApiKey');
  const resp = await chrome.runtime.sendMessage({ type: 'PING_PROVIDER' });
  if (resp && resp.ok) {
    show(`OK — model replied: ${resp.text.slice(0, 80)}`, 'ok');
  } else {
    show(`Failed: ${resp && resp.error || 'unknown error'}`, 'error');
  }
}

function show(msg, level) {
  els.status.textContent = msg;
  els.status.className = `status ${level}`;
}
