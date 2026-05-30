// Dashboard Guide Agent — content script
// Owns the page: runs the DOM distiller and draws the cursor/highlight/tooltip overlay.
// Talks to the side panel via chrome.runtime messages.

import TurndownService from 'turndown';

// Turndown converts the live page HTML → markdown. Dense, structured,
// LLM-friendly. Configured to keep links and inline code; drops noise.
const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
});
// Drop tags whose contents are pure noise for navigation context.
turndown.remove(['script', 'style', 'noscript', 'svg', 'link', 'meta', 'template', 'iframe']);

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[onclick]',
  '[data-testid]',
  '[contenteditable="true"]',
].join(',');

const HEADING_SELECTOR = 'h1, h2, h3, h4, [role="heading"]';

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  return true;
}

function inViewport(rect) {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
}

function visibleText(el) {
  const raw = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  return raw.length > 120 ? raw.slice(0, 117) + '...' : raw;
}

function cssPath(el) {
  if (!(el instanceof Element)) return '';
  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return '#' + CSS.escape(el.id);
  const testid = el.getAttribute('data-testid');
  if (testid) return `[data-testid="${cssEscapeAttr(testid)}"]`;
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
    let sel = cur.tagName.toLowerCase();
    if (cur.id && /^[a-zA-Z][\w-]*$/.test(cur.id)) {
      sel = '#' + CSS.escape(cur.id);
      parts.unshift(sel);
      break;
    }
    const tid = cur.getAttribute && cur.getAttribute('data-testid');
    if (tid) {
      sel += `[data-testid="${cssEscapeAttr(tid)}"]`;
      parts.unshift(sel);
      break;
    }
    const parent = cur.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(cur) + 1;
        sel += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(sel);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

function cssEscapeAttr(v) {
  return v.replace(/"/g, '\\"');
}

function isNestedInsideInteractive(el, interactiveSet) {
  let p = el.parentElement;
  while (p && p !== document.body) {
    if (interactiveSet.has(p)) return true;
    p = p.parentElement;
  }
  return false;
}

function positionHint(rect) {
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const v = cy < vh / 3 ? 'top' : cy < (2 * vh) / 3 ? 'middle' : 'bottom';
  const h = cx < vw / 3 ? 'left' : cx < (2 * vw) / 3 ? 'center' : 'right';
  return `${v}-${h}`;
}

function nearLabel(el) {
  // Walk up to ~6 ancestors looking for context: aria-label, role=heading,
  // legend, label, summary, or a previous-sibling heading text.
  let cur = el.parentElement;
  let depth = 0;
  while (cur && cur !== document.body && depth < 6) {
    const aria = cur.getAttribute && cur.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 80);
    if (cur.matches && cur.matches('legend, summary, label, [role="heading"], [role="region"][aria-label], section[aria-label], nav[aria-label]')) {
      const t = visibleText(cur);
      if (t) return t.slice(0, 80);
    }
    // Look at the cur's previous heading sibling.
    let sib = cur.previousElementSibling;
    let sCount = 0;
    while (sib && sCount < 3) {
      if (sib.matches && sib.matches('h1, h2, h3, h4, [role="heading"]')) {
        const t = visibleText(sib);
        if (t) return t.slice(0, 80);
      }
      sib = sib.previousElementSibling;
      sCount++;
    }
    cur = cur.parentElement;
    depth++;
  }
  return undefined;
}

function liveValue(el) {
  // The HTML `value="..."` attribute reflects the *initial* value, not what
  // the user has typed. The JS .value property is the live one.
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const v = el.value;
    if (typeof v === 'string' && v.length) {
      return v.length > 200 ? v.slice(0, 197) + '...' : v;
    }
  }
  if (el.isContentEditable) {
    const t = (el.innerText || '').trim();
    if (t.length) return t.length > 200 ? t.slice(0, 197) + '...' : t;
  }
  return undefined;
}

// True when an editable field has no actual user content. Used to flag
// EMPTY in the prompt so the model can't confuse a focused-but-empty input
// (or a placeholder string) with a filled value.
function isEmptyInput(el) {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    return !el.value || el.value.length === 0;
  }
  if (tag === 'SELECT') {
    return !el.value || el.value.length === 0;
  }
  if (el.isContentEditable) {
    const t = (el.innerText || '').trim();
    return t.length === 0;
  }
  return false;
}

function liveCheckedState(el) {
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el.type || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return !!el.checked;
  }
  return undefined;
}

function describeElement(el, ref) {
  const rect = el.getBoundingClientRect();
  const focused = el === document.activeElement;
  return {
    ref,
    tag: el.tagName.toLowerCase(),
    text: visibleText(el),
    testid: el.getAttribute('data-testid') || undefined,
    id: el.id || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    name: el.getAttribute('name') || undefined,
    role: el.getAttribute('role') || undefined,
    type: el.getAttribute('type') || undefined,
    href: el.tagName === 'A' ? (el.getAttribute('href') || undefined) : undefined,
    selector: cssPath(el),
    inViewport: inViewport(rect),
    position: positionHint(rect),
    nearLabel: nearLabel(el),
    // Live runtime state — read from JS properties, not HTML attributes,
    // so we see what the user has actually typed / focused / toggled.
    value: liveValue(el),
    focused: focused || undefined,
    checked: liveCheckedState(el),
    disabled: el.disabled === true ? true : undefined,
    // Editable input is genuinely empty (no value at all). Placeholder text
    // is NOT a value — we flag empty independently so the prompt is clear.
    empty: (
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
        ? isEmptyInput(el)
        : undefined
    ),
  };
}

function distill() {
  const interactive = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(isVisible);
  const interactiveSet = new Set(interactive);
  const filtered = interactive.filter(el => !isNestedInsideInteractive(el, interactiveSet));

  // Cap output: in-viewport first, then off-screen, max 120 total.
  filtered.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const av = inViewport(ra) ? 0 : 1;
    const bv = inViewport(rb) ? 0 : 1;
    if (av !== bv) return av - bv;
    return (ra.top - rb.top) || (ra.left - rb.left);
  });

  const capped = filtered.slice(0, 120);
  const elements = capped.map((el, i) => describeElement(el, `e${i}`));

  const headings = Array.from(document.querySelectorAll(HEADING_SELECTOR))
    .filter(isVisible)
    .slice(0, 20)
    .map(el => ({ tag: el.tagName.toLowerCase(), text: visibleText(el) }));

  // Find the currently focused element among the distilled set so the prompt
  // can call it out at top level (not just as a per-element flag).
  const focusedEl = document.activeElement;
  let focusedRef;
  if (focusedEl && focusedEl !== document.body) {
    for (const e of elements) {
      try {
        if (document.querySelector(e.selector) === focusedEl) {
          focusedRef = e.ref;
          break;
        }
      } catch {}
    }
  }

  return {
    url: location.href,
    title: document.title,
    headings,
    elements,
    focusedRef,
    activeElementTag: focusedEl ? focusedEl.tagName.toLowerCase() : undefined,
    // Page rendered to Markdown via Turndown. Dense, structured, LLM-friendly.
    pageMarkdown: pageToMarkdown(),
  };
}

const MAX_PAGE_MARKDOWN = 200_000;
function pageToMarkdown() {
  try {
    let md = turndown.turndown(document.body || document.documentElement);
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    if (md.length > MAX_PAGE_MARKDOWN) {
      md = md.slice(0, MAX_PAGE_MARKDOWN) + '\n\n...[truncated]';
    }
    return md;
  } catch (e) {
    console.warn('[dga] turndown failed', e);
    return '';
  }
}

// (pageToMarkdown above uses Turndown — replaces the previous hand-rolled DOM
// JSON walker.)

// -------- Page-state watcher --------
// Persistent MutationObserver + input listener. After the page has been idle
// for ~800ms following any mutation, we snapshot a few cheap state markers
// and compare against the last snapshot. If anything material changed, we
// fire PAGE_CHANGED to the side panel so it can re-run the current step
// without waiting for the user to click Next.
let pageWatcherStarted = false;
let pageWatcherActive = false;       // only fire while a flow is running
let pageWatcherSuppressed = false;   // hard-pause while the chat pane is open
let lastPageSnapshot = null;
let pageChangeTimer = 0;

// True when a node is part of our own overlay UI (or absent). Mutations,
// focus moves, and value reads on overlay-owned elements are noise — they're
// the plugin's own activity, not real page state changes.
function isOverlayNode(node) {
  if (!node) return false;
  const root = overlay && overlay.root;
  if (!root) return false;
  if (node === root) return true;
  if (node.nodeType === 1 && root.contains(node)) return true;
  if (node.nodeType !== 1 && node.parentNode && root.contains(node.parentNode)) return true;
  return false;
}

function pageSnapshot() {
  const focused = document.activeElement;
  let focusedSig = '';
  // If the user is focused inside the overlay (e.g. the chat textarea), that
  // is plugin state — don't count it as page state.
  if (focused && focused !== document.body && !isOverlayNode(focused)) {
    try {
      const id = focused.id ? `#${focused.id}` : '';
      const name = focused.getAttribute && focused.getAttribute('name') ? `[name=${focused.getAttribute('name')}]` : '';
      const v = (focused.value !== undefined ? focused.value : (focused.isContentEditable ? focused.innerText : '')) || '';
      focusedSig = `${focused.tagName}${id}${name}::${v.slice(0, 200)}`;
    } catch {}
  }
  const inputs = document.querySelectorAll('input, textarea, select');
  let inputSig = '';
  let interactiveCount = 0;
  for (const i of inputs) {
    if (isOverlayNode(i)) continue;
    inputSig += `|${i.value || ''}`;
    if (inputSig.length > 1000) break;
  }
  for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (!isOverlayNode(el)) interactiveCount++;
  }
  return {
    url: location.href,
    title: document.title,
    interactiveCount,
    focusedSig,
    inputSig,
  };
}

function snapshotsDiffer(a, b) {
  if (!a || !b) return true;
  return a.url !== b.url
    || a.title !== b.title
    || a.interactiveCount !== b.interactiveCount
    || a.focusedSig !== b.focusedSig
    || a.inputSig !== b.inputSig;
}

function startPageWatcher() {
  if (pageWatcherStarted) return;
  pageWatcherStarted = true;

  const schedule = () => {
    if (!pageWatcherActive) return;
    if (pageWatcherSuppressed) return; // chat pane open — user is focusing on correcting
    if (pageChangeTimer) clearTimeout(pageChangeTimer);
    pageChangeTimer = setTimeout(() => {
      pageChangeTimer = 0;
      if (!pageWatcherActive || pageWatcherSuppressed) return;
      const snap = pageSnapshot();
      if (snapshotsDiffer(lastPageSnapshot, snap)) {
        lastPageSnapshot = snap;
        try {
          chrome.runtime.sendMessage({ type: 'PAGE_CHANGED', summary: { url: snap.url, focusedSig: snap.focusedSig } });
        } catch (e) {
          // sidepanel may not be listening; ignore.
        }
      }
    }, 950);
  };

  // Drop mutation records whose target lives inside our own overlay so we
  // don't re-trigger ourselves every time we paint a ring or update the
  // tooltip body.
  const onMutation = (records) => {
    if (!pageWatcherActive) return;
    let anyRealMutation = false;
    for (const rec of records) {
      if (!isOverlayNode(rec.target)) { anyRealMutation = true; break; }
    }
    if (!anyRealMutation) return;
    schedule();
  };

  // Drop input/change/focus events that originate inside the overlay (chat
  // textarea, buttons). Same reason: our own UI shouldn't kick a rerun.
  const onPageEvent = (e) => {
    if (!pageWatcherActive) return;
    if (isOverlayNode(e.target)) return;
    schedule();
  };

  try {
    const observer = new MutationObserver(onMutation);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
  } catch (e) {
    console.warn('[dga] page watcher failed to attach', e);
  }
  document.addEventListener('input', onPageEvent, { capture: true, passive: true });
  document.addEventListener('change', onPageEvent, { capture: true, passive: true });
  document.addEventListener('focusin', onPageEvent, { capture: true, passive: true });
  document.addEventListener('focusout', onPageEvent, { capture: true, passive: true });
}

function armPageWatcher() {
  startPageWatcher();
  pageWatcherActive = true;
  lastPageSnapshot = pageSnapshot();
}

function disarmPageWatcher() {
  pageWatcherActive = false;
  if (pageChangeTimer) {
    clearTimeout(pageChangeTimer);
    pageChangeTimer = 0;
  }
  lastPageSnapshot = null;
}

// Wait for DOM to be quiet — no mutations for `idleMs`. Useful after a click
// that triggers async loading: tabs.onUpdated='complete' fires when the
// initial document loads, but SPAs keep rendering after that. We watch the
// MutationObserver and only resolve once the page has been still for a beat.
function waitForDomQuiet(idleMs = 500, maxMs = 5000) {
  return new Promise((resolve) => {
    if (!document.body) {
      setTimeout(() => resolve(false), 0);
      return;
    }
    let lastChange = Date.now();
    const observer = new MutationObserver(() => {
      lastChange = Date.now();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const start = Date.now();
    const check = () => {
      const now = Date.now();
      if (now - lastChange >= idleMs) {
        observer.disconnect();
        resolve(true);
        return;
      }
      if (now - start >= maxMs) {
        observer.disconnect();
        resolve(false);
        return;
      }
      setTimeout(check, 100);
    };
    setTimeout(check, idleMs);
  });
}

// -------- Overlay --------

const OVERLAY_ID = 'dga-overlay-root';
let overlay = null;
let trackRaf = 0;
let currentTarget = null;

// Alternative-element rings. When a step is "click any of N objectives" the
// model returns the primary selector + a list of equivalents; we glow a
// softer ring on each equivalent element so the user knows they're free to
// pick any of them.
let altRings = [];      // [{ element, ring }]

function renderAlternativeRings(selectors, primarySelector) {
  for (const r of altRings) if (r.ring && r.ring.parentNode) r.ring.parentNode.removeChild(r.ring);
  altRings = [];
  if (!overlay || !Array.isArray(selectors) || selectors.length === 0) return;
  for (const sel of selectors) {
    if (!sel || sel === primarySelector) continue;
    let alt = null;
    try { alt = document.querySelector(sel); } catch { alt = null; }
    if (!alt || !document.body.contains(alt)) continue;
    const ring = document.createElement('div');
    ring.className = 'dga-alt-ring';
    overlay.root.appendChild(ring);
    altRings.push({ element: alt, ring, selector: sel });
  }
  positionAlternativeRings();
}

function positionAlternativeRings() {
  if (!altRings.length) return;
  for (const r of altRings) {
    if (!r.element || !document.body.contains(r.element)) {
      if (r.ring) r.ring.style.display = 'none';
      continue;
    }
    const rect = r.element.getBoundingClientRect();
    const pad = 4;
    Object.assign(r.ring.style, {
      display: 'block',
      top: `${rect.top - pad}px`,
      left: `${rect.left - pad}px`,
      width: `${rect.width + pad * 2}px`,
      height: `${rect.height + pad * 2}px`,
    });
  }
}

function clearAlternativeRings() {
  for (const r of altRings) if (r.ring && r.ring.parentNode) r.ring.parentNode.removeChild(r.ring);
  altRings = [];
}

function ensureOverlay() {
  if (overlay && document.body.contains(overlay.root)) return overlay;
  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';

  const cursor = document.createElement('div');
  cursor.className = 'dga-cursor';
  cursor.innerHTML = `
    <svg viewBox="0 0 24 24" width="32" height="32" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 2 L21 12 L13 13 L9 22 Z" fill="#7c3aed" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>
  `;

  const ring = document.createElement('div');
  ring.className = 'dga-ring';

  const tooltip = document.createElement('div');
  tooltip.className = 'dga-tooltip';
  tooltip.innerHTML = `
    <div class="dga-tooltip-loading-view" hidden>
      <div class="dga-tooltip-header">
        <span class="dga-loading-label">Thinking…</span>
        <button class="dga-btn-close" type="button" title="Close guide" aria-label="Close guide">×</button>
      </div>
      <div class="dga-loading-body">
        <div class="dga-spinner"></div>
        <div class="dga-loading-text">Re-checking the page and picking the next step…</div>
      </div>
    </div>
    <div class="dga-tooltip-step-view">
      <div class="dga-tooltip-header">
        <span class="dga-tooltip-step"></span>
        <span class="dga-tooltip-confidence"></span>
        <button class="dga-btn-close" type="button" title="Close guide" aria-label="Close guide">×</button>
      </div>
      <div class="dga-tooltip-body"></div>
      <div class="dga-tooltip-blocker"></div>
      <div class="dga-tooltip-actions">
        <button class="dga-btn dga-btn-prev" type="button">Prev</button>
        <button class="dga-btn dga-btn-chat" type="button" title="Correct the agent if it picked the wrong thing">Correct Agent If Wrong</button>
        <button class="dga-btn dga-btn-next" type="button">Next</button>
        <button class="dga-btn dga-btn-done" type="button">Done</button>
      </div>
    </div>
    <div class="dga-tooltip-chat-view" hidden>
      <div class="dga-tooltip-header">
        <span>Correct the agent</span>
        <button class="dga-btn dga-chat-back" type="button" title="Cancel — keep chat, don't apply changes">← Back</button>
        <button class="dga-btn-close dga-btn-close-chat" type="button" title="Close guide" aria-label="Close guide">×</button>
      </div>
      <div class="dga-chat-log"></div>
      <div class="dga-chat-thinking" hidden>Agent thinking…</div>
      <textarea class="dga-chat-input" rows="2" placeholder="Tell the agent what it got wrong. Your correction becomes a rule baked into this flow."></textarea>
      <div class="dga-tooltip-actions">
        <button class="dga-btn dga-chat-send" type="button">Send</button>
        <button class="dga-btn dga-chat-gotit" type="button" title="Tell the agent it got it right — stops the back-and-forth">Got it ✓</button>
        <button class="dga-btn dga-chat-apply" type="button" title="Apply the agreed correction as a rule and re-run the step" disabled>Apply</button>
      </div>
    </div>
  `;
  tooltip.style.pointerEvents = 'auto';

  root.appendChild(ring);
  root.appendChild(cursor);
  root.appendChild(tooltip);
  document.body.appendChild(root);

  // Drag-to-move on any tooltip header.
  for (const header of tooltip.querySelectorAll('.dga-tooltip-header')) {
    header.style.cursor = 'grab';
    header.addEventListener('mousedown', (e) => {
      // Ignore drags that start on a button — they should fire click instead.
      if (e.target.closest('button')) return;
      startTooltipDrag(e);
    });
  }

  tooltip.querySelector('.dga-btn-prev').addEventListener('click', () => signalAdvance('prev'));
  tooltip.querySelector('.dga-btn-next').addEventListener('click', () => signalAdvance('next'));
  tooltip.querySelector('.dga-btn-done').addEventListener('click', () => signalAdvance('done'));
  tooltip.querySelector('.dga-btn-chat').addEventListener('click', () => openChat());
  tooltip.querySelector('.dga-chat-back').addEventListener('click', () => userCancelledChat());
  tooltip.querySelector('.dga-chat-send').addEventListener('click', () => sendChat());
  tooltip.querySelector('.dga-chat-gotit').addEventListener('click', () => userGotItChat());
  tooltip.querySelector('.dga-chat-apply').addEventListener('click', () => userAppliedChat());
  for (const closeBtn of tooltip.querySelectorAll('.dga-btn-close')) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Hide the overlay locally regardless of whether the side panel is open
      // / listening. Then notify the side panel so it can tear down flow state.
      hideOverlay();
      signalAdvance('close');
    });
  }
  tooltip.querySelector('.dga-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendChat();
    }
  });

  overlay = { root, cursor, ring, tooltip };
  window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
  window.addEventListener('resize', schedulePosition, { passive: true });
  return overlay;
}

function signalAdvance(action) {
  chrome.runtime.sendMessage({ type: 'STEP_ADVANCE', action });
}

// Tooltip drag state. Once the user has moved the tooltip we stop auto-
// positioning it next to the target — they put it where they want it.
let tooltipUserMoved = false;
let dragState = null;

function startTooltipDrag(e) {
  if (!overlay) return;
  e.preventDefault();
  const t = overlay.tooltip;
  const rect = t.getBoundingClientRect();
  dragState = {
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
  };
  for (const header of t.querySelectorAll('.dga-tooltip-header')) {
    header.style.cursor = 'grabbing';
  }
  t.style.userSelect = 'none';
  document.addEventListener('mousemove', onTooltipDragMove);
  document.addEventListener('mouseup', endTooltipDrag);
}

function onTooltipDragMove(e) {
  if (!dragState || !overlay) return;
  const t = overlay.tooltip;
  let left = e.clientX - dragState.offsetX;
  let top = e.clientY - dragState.offsetY;
  const margin = 4;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (left < margin) left = margin;
  if (top < margin) top = margin;
  if (left + t.offsetWidth > vw - margin) left = vw - t.offsetWidth - margin;
  if (top + t.offsetHeight > vh - margin) top = vh - t.offsetHeight - margin;
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
  tooltipUserMoved = true;
}

function endTooltipDrag() {
  dragState = null;
  if (overlay) {
    for (const header of overlay.tooltip.querySelectorAll('.dga-tooltip-header')) {
      header.style.cursor = 'grab';
    }
    overlay.tooltip.style.userSelect = '';
  }
  document.removeEventListener('mousemove', onTooltipDragMove);
  document.removeEventListener('mouseup', endTooltipDrag);
}

// Auto-advance: when the user actually clicks the highlighted element (or
// presses Enter while focused inside it), advance the flow. We disarm
// immediately on fire so a single interaction can't double-advance.
let advanceArmed = false;

function maybeAutoAdvanceFromClick(e) {
  if (!advanceArmed || !currentTarget) return;
  const el = currentTarget.element;
  if (!el || !document.body.contains(el)) return;
  // Ignore clicks inside our own tooltip — those are handled by button handlers.
  if (overlay && overlay.tooltip.contains(e.target)) return;
  // Primary target hit.
  if (el === e.target || el.contains(e.target)) {
    advanceArmed = false;
    signalAdvance('next');
    return;
  }
  // Alternative hit — user picked an equivalent option.
  for (const r of altRings) {
    if (!r.element || !document.body.contains(r.element)) continue;
    if (r.element === e.target || r.element.contains(e.target)) {
      advanceArmed = false;
      signalAdvance('next');
      return;
    }
  }
}

function maybeAutoAdvanceFromKey(e) {
  if (!advanceArmed || !currentTarget) return;
  if (e.key !== 'Enter') return;
  const el = currentTarget.element;
  if (!el || !document.body.contains(el)) return;
  const active = document.activeElement;
  if (el === active || el.contains(active)) {
    advanceArmed = false;
    signalAdvance('next');
  }
}

document.addEventListener('click', maybeAutoAdvanceFromClick, true);
document.addEventListener('keydown', maybeAutoAdvanceFromKey, true);

function schedulePosition() {
  if (trackRaf) return;
  trackRaf = requestAnimationFrame(() => {
    trackRaf = 0;
    repositionOverlay();
  });
}

function repositionOverlay() {
  if (!overlay) return;
  positionAlternativeRings();
  if (!currentTarget) return;
  const el = currentTarget.element;
  if (!el || !document.body.contains(el)) {
    hideOverlay();
    return;
  }
  const rect = el.getBoundingClientRect();
  positionRing(rect);
  positionCursor(rect);
  positionTooltip(rect);
}

function positionRing(rect) {
  const pad = 6;
  Object.assign(overlay.ring.style, {
    display: 'block',
    top: `${rect.top - pad}px`,
    left: `${rect.left - pad}px`,
    width: `${rect.width + pad * 2}px`,
    height: `${rect.height + pad * 2}px`,
  });
}

function positionCursor(rect) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  overlay.cursor.style.transform = `translate(${cx - 4}px, ${cy - 4}px)`;
  overlay.cursor.style.opacity = '1';
}

function positionTooltip(rect) {
  const t = overlay.tooltip;
  t.style.display = 'block';
  if (tooltipUserMoved) return; // honour the user's drag position
  // measure tooltip
  const tw = t.offsetWidth || 280;
  const th = t.offsetHeight || 120;
  const margin = 14;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  // Prefer below
  let top = rect.bottom + margin;
  let left = rect.left;
  if (top + th > vh - 8) top = rect.top - th - margin;
  if (top < 8) top = 8;
  if (left + tw > vw - 8) left = vw - tw - 8;
  if (left < 8) left = 8;
  t.style.top = `${top}px`;
  t.style.left = `${left}px`;
}

function showOverlay({ selector, alternatives, narration, stepIndex, totalSteps, confidence, blocker, isLast, isAgent, iter, maxIter }) {
  ensureOverlay();
  hideLoading();
  // Repaint alternative-element rings so the user can see every equivalent
  // choice (e.g. "click any of these objectives — they all work").
  renderAlternativeRings(alternatives || [], selector);
  let el = null;
  if (selector) {
    try { el = document.querySelector(selector); } catch (e) { el = null; }
  }

  // Drive the overlay accent colour from confidence so the ring / cursor /
  // tooltip glow all shift together (see CSS --dga-accent).
  const bucket = typeof confidence !== 'number'
    ? 'med'
    : confidence >= 0.75 ? 'high'
    : confidence >= 0.5  ? 'med'
    : 'low';
  overlay.root.dataset.confidence = bucket;

  if (el) {
    currentTarget = { element: el, selector };
    advanceArmed = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  } else {
    currentTarget = null;
    advanceArmed = false;
    overlay.ring.style.display = 'none';
    overlay.cursor.style.opacity = '0';
  }
  // Start (or re-arm) the page-state watcher so any subsequent DOM / input
  // changes trigger a PAGE_CHANGED message to the side panel.
  armPageWatcher();

  const t = overlay.tooltip;
  const stepEl = t.querySelector('.dga-tooltip-step');
  if (isAgent) {
    stepEl.textContent = `Step ${(iter || 0) + 1} of up to ${maxIter || 0}`;
  } else if (totalSteps > 0) {
    stepEl.textContent = `Step ${stepIndex + 1} of ${totalSteps}`;
  } else {
    stepEl.textContent = 'Guide';
  }
  const confEl = t.querySelector('.dga-tooltip-confidence');
  if (typeof confidence === 'number') {
    confEl.textContent = `conf ${Math.round(confidence * 100)}%`;
    confEl.dataset.low = confidence < 0.5 ? '1' : '0';
  } else {
    confEl.textContent = '';
  }
  const altCount = altRings.length;
  let bodyText = narration || '';
  if (altCount > 0) {
    bodyText = `Any of these ${altCount + 1} highlighted options works — pick whichever you want. ${bodyText}`;
  }
  t.querySelector('.dga-tooltip-body').textContent = bodyText;
  const blk = t.querySelector('.dga-tooltip-blocker');
  if (blocker) {
    blk.textContent = blocker;
    blk.style.display = 'block';
  } else {
    blk.textContent = '';
    blk.style.display = 'none';
  }
  const nextBtn = t.querySelector('.dga-btn-next');
  const doneBtn = t.querySelector('.dga-btn-done');
  const prevBtn = t.querySelector('.dga-btn-prev');
  if (isLast) {
    nextBtn.style.display = 'none';
    doneBtn.style.display = 'inline-block';
  } else {
    nextBtn.style.display = 'inline-block';
    doneBtn.style.display = 'none';
  }
  if (isAgent) {
    // Agent decides direction; Prev is meaningless.
    prevBtn.style.display = 'none';
  } else {
    prevBtn.style.display = 'inline-block';
    prevBtn.disabled = stepIndex <= 0;
  }

  if (el) {
    // wait one frame for layout, then position
    requestAnimationFrame(repositionOverlay);
  } else {
    // tooltip-only: center it
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    overlay.tooltip.style.display = 'block';
    overlay.tooltip.style.top = `${vh / 2 - 60}px`;
    overlay.tooltip.style.left = `${vw / 2 - 140}px`;
  }
}

function hideOverlay() {
  if (!overlay) return;
  overlay.ring.style.display = 'none';
  overlay.cursor.style.opacity = '0';
  overlay.tooltip.style.display = 'none';
  clearAlternativeRings();
  currentTarget = null;
  advanceArmed = false;
  closeChat();
  chatHistory = [];
  userAgreed = false;
  tooltipUserMoved = false; // fresh flow starts auto-positioning again
  disarmPageWatcher();
}

function showLoading(label) {
  ensureOverlay();
  const t = overlay.tooltip;
  t.style.display = 'block';
  t.querySelector('.dga-tooltip-step-view').hidden = true;
  t.querySelector('.dga-tooltip-chat-view').hidden = true;
  const loadingView = t.querySelector('.dga-tooltip-loading-view');
  loadingView.hidden = false;
  loadingView.querySelector('.dga-loading-label').textContent = label || 'Thinking…';
  // Park the tooltip near the previous target if we have one, otherwise centre.
  if (currentTarget && currentTarget.element && document.body.contains(currentTarget.element)) {
    const rect = currentTarget.element.getBoundingClientRect();
    positionTooltip(rect);
  } else {
    t.style.top = `${window.innerHeight / 2 - 60}px`;
    t.style.left = `${window.innerWidth / 2 - 160}px`;
  }
  // Dim the ring + cursor while we're thinking.
  overlay.ring.style.opacity = '0.4';
  overlay.cursor.style.opacity = '0.4';
  advanceArmed = false; // never auto-advance during a loading state
}

function hideLoading() {
  if (!overlay) return;
  const t = overlay.tooltip;
  t.querySelector('.dga-tooltip-loading-view').hidden = true;
  t.querySelector('.dga-tooltip-step-view').hidden = false;
  overlay.ring.style.opacity = '1';
  // cursor opacity is set by showOverlay
}

// -------- Chat pane --------

let chatHistory = [];   // [{ role: 'user'|'assistant', text }]
let chatBusy = false;
// User has explicitly told the agent "you got it right" (Got it ✓ button OR
// the assessor flagged decision='agreed' in its reply). Once true, Send +
// Got it are disabled and Apply is enabled.
let userAgreed = false;

function openChat() {
  if (!overlay) return;
  overlay.tooltip.querySelector('.dga-tooltip-loading-view').hidden = true;
  overlay.tooltip.querySelector('.dga-tooltip-step-view').hidden = true;
  overlay.tooltip.querySelector('.dga-tooltip-chat-view').hidden = false;
  // Suppress the page-state watcher while the chat is open. User is
  // focused on correcting; we don't want a stray PAGE_CHANGED firing a
  // step rerun underneath them.
  pageWatcherSuppressed = true;
  // Also disarm auto-advance so they can't accidentally complete the step
  // mid-correction.
  advanceArmed = false;
  // Render any prior chat turns from this flow.
  renderChatLog();
  const input = overlay.tooltip.querySelector('.dga-chat-input');
  setTimeout(() => input.focus(), 50);
}

function closeChat() {
  if (!overlay) return;
  const chatView = overlay.tooltip.querySelector('.dga-tooltip-chat-view');
  const stepView = overlay.tooltip.querySelector('.dga-tooltip-step-view');
  if (chatView) chatView.hidden = true;
  if (stepView) stepView.hidden = false;
  // Re-enable the page watcher (showOverlay will also re-arm advance).
  pageWatcherSuppressed = false;
}

// User clicked Back — cancel correction. Just close the pane; keep chat
// history so they can resume if they reopen the chat. No distillation, no
// step re-run.
function userCancelledChat() {
  closeChat();
}

// User clicked "Close & Apply" — finalise the correction. Send the full
// conversation to the side panel for distillation, then clear chat history.
// Side panel will persist new rules + re-run the current step.
function userAppliedChat() {
  if (!userAgreed) return; // disabled state — must agree first
  const history = chatHistory.slice();
  closeChat();
  chatHistory = [];
  userAgreed = false;
  if (overlay) renderChatLog();
  try {
    chrome.runtime.sendMessage({ type: 'CHAT_DONE', payload: { history } });
  } catch (e) {
    // sidepanel may not be listening; nothing we can do.
  }
}

function renderChatLog() {
  const logEl = overlay.tooltip.querySelector('.dga-chat-log');
  logEl.innerHTML = '';
  for (const turn of chatHistory) {
    const row = document.createElement('div');
    row.className = `dga-chat-row dga-chat-${turn.role}`;
    row.textContent = turn.text;
    logEl.appendChild(row);
  }
  logEl.scrollTop = logEl.scrollHeight;
  updateChatButtonStates();
}

function updateChatButtonStates() {
  if (!overlay) return;
  const sendBtn = overlay.tooltip.querySelector('.dga-chat-send');
  const gotitBtn = overlay.tooltip.querySelector('.dga-chat-gotit');
  const applyBtn = overlay.tooltip.querySelector('.dga-chat-apply');
  const inputEl = overlay.tooltip.querySelector('.dga-chat-input');
  if (sendBtn) sendBtn.disabled = userAgreed || chatBusy;
  if (gotitBtn) gotitBtn.disabled = userAgreed || chatBusy || chatHistory.length === 0;
  if (applyBtn) applyBtn.disabled = !userAgreed;
  if (inputEl) inputEl.disabled = userAgreed;
}

function setChatThinking(on) {
  if (!overlay) return;
  overlay.tooltip.querySelector('.dga-chat-thinking').hidden = !on;
  chatBusy = on;
  updateChatButtonStates();
}

function sendChat() {
  if (chatBusy) return;
  const input = overlay.tooltip.querySelector('.dga-chat-input');
  const text = (input.value || '').trim();
  if (!text) return;
  chatHistory.push({ role: 'user', text });
  input.value = '';
  renderChatLog();
  chatBusy = true;
  setChatThinking(true);
  chrome.runtime.sendMessage({
    type: 'CHAT_QUERY',
    payload: {
      text,
      // Send only the recent slice — keep prompt small.
      history: chatHistory.slice(-8),
    },
  });
}

function receiveChatReply(payload) {
  setChatThinking(false);
  const reply = (payload && payload.text) || '';
  const error = payload && payload.error;
  const decision = payload && payload.decision;
  if (error) {
    chatHistory.push({ role: 'assistant', text: `(error) ${error}` });
  } else {
    chatHistory.push({ role: 'assistant', text: reply || '(no reply)' });
  }
  if (!error && decision === 'agreed') {
    userAgreed = true;
  }
  renderChatLog();
}

// "Got it ✓" — user signals the agent it has it right. Adds a confirmation
// turn, marks the conversation as agreed locally, and disables further
// back-and-forth. Apply is now enabled.
function userGotItChat() {
  if (userAgreed) return;
  if (chatHistory.length === 0) return;
  chatHistory.push({ role: 'user', text: 'Got it ✓ — you have it right.' });
  chatHistory.push({ role: 'assistant', text: 'Acknowledged. Click Apply to save the rule.' });
  userAgreed = true;
  renderChatLog();
}

// -------- Message router --------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'DISTILL_DOM') {
    // Wait for the DOM to settle before snapshotting — gets us past async
    // post-navigation rendering that fires after tabs.onUpdated='complete'.
    (async () => {
      try {
        await waitForDomQuiet(500, 5000);
        const dom = distill();
        sendResponse({ ok: true, dom });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async response
  }
  if (msg.type === 'SHOW_OVERLAY') {
    try {
      showOverlay(msg.payload || {});
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return false;
  }
  if (msg.type === 'CLEAR_OVERLAY') {
    hideOverlay();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'SHOW_LOADING') {
    try {
      showLoading(msg.payload && msg.payload.label);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return false;
  }
  if (msg.type === 'CLOSE_CHAT') {
    try {
      closeChat();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return false;
  }
  if (msg.type === 'CHAT_REPLY') {
    try {
      receiveChatReply(msg.payload || {});
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
    return false;
  }
  return false;
});
