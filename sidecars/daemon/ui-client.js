(() => {
  'use strict';

  const GLOBAL_KEY = '__agAccountSwitcherUi';
  const STYLE_ID = 'ag-account-switcher-style';
  const POPOVER_ID = 'ag-as-popover';
  const TOAST_ID = 'ag-as-toast';
  const ROOT_ATTR = 'data-ag-as-node';
  const OWNED_ATTR = 'data-ag-owned';
  const FOOTER_ATTR = 'data-ag-as-footer';
  const COLLAPSED_ATTR = 'data-ag-as-collapsed';
  const SETTINGS_ATTR = 'data-ag-as-settings';

  // Clean up previous instance cleanly for hot-reload idempotency
  try {
    if (window[GLOBAL_KEY] && typeof window[GLOBAL_KEY].destroy === 'function') {
      window[GLOBAL_KEY].destroy();
    }
  } catch {
    // ignore hot-reload cleanup error
  }

  const NO_TRANSLATE_ATTRS = {
    [OWNED_ATTR]: '1',
    [ROOT_ATTR]: '1',
    translate: 'no',
    'data-no-translate': 'true',
    'data-ag-localization-skip': 'true',
    'data-agy-no-translate': 'true',
    'data-antigravity-zh-skip': '1',
  };

  function markOwned(el) {
    if (!el) return el;
    for (const [k, v] of Object.entries(NO_TRANSLATE_ATTRS)) {
      el.setAttribute(k, v);
    }
    return el;
  }

  function createEl(tag, className, attrs) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    markOwned(el);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined && v !== null) el.setAttribute(k, String(v));
      }
    }
    return el;
  }

  function createSvg(width, height, pathNodes, extraAttrs) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.flexShrink = '0';
    if (extraAttrs) {
      for (const [k, v] of Object.entries(extraAttrs)) {
        svg.setAttribute(k, String(v));
      }
    }
    for (const item of pathNodes) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', item.tag);
      for (const [k, v] of Object.entries(item.attrs)) {
        node.setAttribute(k, String(v));
      }
      svg.appendChild(node);
    }
    return markOwned(svg);
  }

  function editIconSvg(size) {
    return createSvg(size || 12, size || 12, [
      { tag: 'path', attrs: { d: 'M12 20h9' } },
      { tag: 'path', attrs: { d: 'M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z' } },
    ]);
  }

  function refreshIconSvg(size) {
    return createSvg(size || 12, size || 12, [
      { tag: 'path', attrs: { d: 'M21 12a9 9 0 1 1-2.64-6.36' } },
      { tag: 'polyline', attrs: { points: '21 3 21 9 15 9' } },
    ]);
  }

  // =========================================================================
  // RPC BRIDGE & LIVE PUSH HANDLER
  // =========================================================================
  let rpcSeq = 0;
  const pendingRpc = new Map();

  function resolveRpc(id, rawJson) {
    const entry = pendingRpc.get(id);
    if (!entry) return;
    pendingRpc.delete(id);
    clearTimeout(entry.timer);
    try {
      const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
      entry.resolve(parsed);
    } catch (err) {
      entry.reject(err);
    }
  }

  window.__agAccountSwitcherResolve = resolveRpc;

  function handlePushUpdate(rawPayload) {
    if (destroyed || !rawPayload) return;
    let data = rawPayload;
    if (typeof rawPayload === 'string') {
      try {
        data = JSON.parse(rawPayload);
      } catch {
        return;
      }
    }
    if (data && data.ok && Array.isArray(data.accounts)) {
      const nextActiveId = data.activeId || null;
      if (state.activeId && nextActiveId && nextActiveId !== state.activeId) {
        state.liveQuota = null;
      }
      state.accounts = data.accounts;
      state.activeId = nextActiveId;
      state.loading = false;
      syncFromPulseShadowDom();
      updateFooterContent();
      if (state.popoverOpen && !state.editingAccountId) {
        renderPopover();
      }
    }
  }

  window.__agAccountSwitcherOnUpdate = handlePushUpdate;

  function waitForBridge(maxWaitMs) {
    if (typeof window.__agAccountSwitcherCall === 'function') {
      return Promise.resolve(window.__agAccountSwitcherCall);
    }
    return new Promise((resolve) => {
      const started = Date.now();
      const iv = setInterval(() => {
        if (destroyed) {
          clearInterval(iv);
          resolve(null);
          return;
        }
        if (typeof window.__agAccountSwitcherCall === 'function') {
          clearInterval(iv);
          resolve(window.__agAccountSwitcherCall);
          return;
        }
        if (Date.now() - started >= maxWaitMs) {
          clearInterval(iv);
          resolve(null);
        }
      }, 100);
    });
  }

  async function rpcCall(action, payload) {
    if (destroyed) return { ok: false, error: 'UI destroyed' };
    const callFn = await waitForBridge(3000);
    if (typeof callFn !== 'function') {
      return { ok: false, error: 'RPC bağlantısı hazır değil' };
    }
    const id = `ag_as_${++rpcSeq}_${Date.now().toString(36)}`;
    const timeoutMs = action === 'switch-account' ? 45000 : 15000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`RPC timeout (${action})`));
      }, timeoutMs);
      pendingRpc.set(id, { resolve, reject, timer });
      try {
        callFn(JSON.stringify({ id, action, payload: payload || {} }));
      } catch (err) {
        clearTimeout(timer);
        pendingRpc.delete(id);
        reject(err);
      }
    });
  }

  // =========================================================================
  // STATE & FORMATTING HELPERS
  // =========================================================================
  let destroyed = false;
  const state = {
    accounts: [],
    activeId: null,
    liveQuota: null, // { quota5h, quotaWeekly, reset5h, resetWeekly, updatedAtMs }
    loading: true,
    isSwitching: false,
    switchingTargetId: null,
    popoverOpen: false,
    editingAccountId: null,
    editingDraft: '',
    toast: null, // { message, tone: 'info' | 'error' }
  };

  let toastTimer = null;
  let mountRaf = 0;
  let startupRetryTimer = null;
  let liveQuotaTimer = null;
  let sidebarResizeObs = null;
  let domObserver = null;
  let htmlAttrObserver = null;
  let pulseShadowObs = null;
  let pulseObservedHost = null;
  let prevPulseBridge = null;
  let ourPulseBridge = null;
  let lastBridgeAtMs = 0;
  let livePollInFlight = false;

  // Mounted DOM references
  let footerContainer = null;
  let settingsBtn = null;
  let labelBtn = null;
  let labelTextEl = null;
  let quotaBtn = null;
  let sep1 = null;
  let sep2 = null;
  let fallbackWrap = null;
  let fallbackOrigParent = null;
  let fallbackOrigNext = null;
  let popoverEl = null;
  let toastEl = null;
  let styleEl = null;

  function formatTier(tier) {
    if (!tier || typeof tier !== 'string') return '';
    const t = tier.trim();
    if (!t) return '';
    if (/ultra/i.test(t)) return 'ULTRA';
    if (/pro/i.test(t)) return 'PRO';
    if (/team|enterprise/i.test(t)) return 'TEAM';
    if (/free/i.test(t)) return 'FREE';
    return t.replace(/^g\d+-/i, '').replace(/-tier$/i, '').toUpperCase().slice(0, 10);
  }

  function formatQuotaPct(val) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
    const clamped = Math.max(0, Math.min(100, Math.round(val)));
    return `${clamped}%`;
  }

  function formatResetTime(val) {
    if (!val || typeof val !== 'string') return '';
    const trimmed = val.trim();
    if (!trimmed) return '';
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const targetMs = Date.parse(trimmed);
      if (Number.isFinite(targetMs)) {
        const diffSec = Math.max(0, Math.floor((targetMs - Date.now()) / 1000));
        if (diffSec < 60) return '<1m';
        const mins = Math.floor(diffSec / 60);
        if (mins < 60) return `${mins}m`;
        const hours = Math.floor(mins / 60);
        const remMins = mins % 60;
        if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
      }
    }
    return trimmed;
  }

  function appendQuotaPairNodes(container, q5h, qWeek) {
    const q5hStr = formatQuotaPct(q5h);
    const qWeekStr = formatQuotaPct(qWeek);

    const p1 = createEl('span', 'ag-as-q-pair');
    const t1 = createEl('span', 'ag-as-q-tag');
    t1.textContent = '5h';
    const v1 = createEl('span', 'ag-as-q-val');
    v1.textContent = q5hStr;
    p1.appendChild(t1);
    p1.appendChild(v1);

    const dot = createEl('span', 'ag-as-q-dot');
    dot.textContent = '·';

    const p2 = createEl('span', 'ag-as-q-pair');
    const t2 = createEl('span', 'ag-as-q-tag');
    t2.textContent = '7d';
    const v2 = createEl('span', 'ag-as-q-val');
    v2.textContent = qWeekStr;
    p2.appendChild(t2);
    p2.appendChild(v2);

    container.appendChild(p1);
    container.appendChild(dot);
    container.appendChild(p2);
  }

  function getActiveAccount() {
    if (!state.accounts.length) return null;
    return (
      state.accounts.find((a) => a.id === state.activeId) ||
      state.accounts.find((a) => a.isCurrent) ||
      state.accounts[0]
    );
  }

  function getDisplayLabel(acc) {
    if (!acc) return state.loading ? 'Hesap...' : 'Hesap';
    return (acc.label || acc.defaultLabel || 'Hesap').trim();
  }

  function getEffectiveQuota(acc) {
    if (!acc) {
      return state.liveQuota || { quota5h: null, quotaWeekly: null, reset5h: null, resetWeekly: null };
    }
    const isAct = acc.id === state.activeId || !!acc.isCurrent;
    const lq = isAct ? state.liveQuota : null;
    if (!lq) {
      return {
        quota5h: acc.quota5h ?? null,
        quotaWeekly: acc.quotaWeekly ?? null,
        reset5h: acc.reset5h ?? null,
        resetWeekly: acc.resetWeekly ?? null,
      };
    }
    return {
      quota5h: lq.quota5h !== null && lq.quota5h !== undefined ? lq.quota5h : (acc.quota5h ?? null),
      quotaWeekly: lq.quotaWeekly !== null && lq.quotaWeekly !== undefined ? lq.quotaWeekly : (acc.quotaWeekly ?? null),
      reset5h: lq.reset5h || acc.reset5h || null,
      resetWeekly: lq.resetWeekly || acc.resetWeekly || null,
    };
  }

  // =========================================================================
  // ZERO-DISK-WRITE LIVE IN-MEMORY QUOTA SYNC (GRAVITYPRISM PARITY)
  // =========================================================================
  function pickPrismQuotaGroup(groups, model) {
    if (!Array.isArray(groups) || !groups.length) return null;
    const ml = String(model || '');
    const key = /argon/i.test(ml)
      ? 'argon'
      : /claude|anthropic|sonnet|opus|haiku|gpt/i.test(ml)
        ? 'claude'
        : 'gemini';
    return (
      groups.find((g) => {
        const s = `${g?.id || ''} ${g?.name || ''}`;
        if (key === 'argon') return /argon|wtu/i.test(s);
        if (key === 'claude') return /claude|anthropic|gpt|openai|\b3p\b/i.test(s);
        return /gemini|google/i.test(s);
      }) ||
      groups.find((g) => /gemini|google/i.test(`${g?.id || ''} ${g?.name || ''}`)) ||
      groups[0] ||
      null
    );
  }

  function readPrismWindowPct(winObj) {
    if (!winObj || winObj.available === false || winObj.disabled) return null;
    if (winObj.expired) return 100;
    const v = +(winObj.remaining ?? winObj.remainingFraction);
    if (!Number.isFinite(v) || v < 0 || v > 1) return null;
    return Math.max(0, Math.min(100, Math.round(v * 100)));
  }

  function applyLiveQuota(patch) {
    if (destroyed || !patch) return;
    const prev = state.liveQuota || {};
    const next5h = patch.quota5h !== undefined && patch.quota5h !== null ? patch.quota5h : (prev.quota5h ?? null);
    const nextWk = patch.quotaWeekly !== undefined && patch.quotaWeekly !== null ? patch.quotaWeekly : (prev.quotaWeekly ?? null);
    const nextR5 = patch.reset5h || prev.reset5h || null;
    const nextRW = patch.resetWeekly || prev.resetWeekly || null;

    if (next5h === null && nextWk === null) return;
    const changed =
      prev.quota5h !== next5h ||
      prev.quotaWeekly !== nextWk ||
      prev.reset5h !== nextR5 ||
      prev.resetWeekly !== nextRW;

    state.liveQuota = {
      quota5h: next5h,
      quotaWeekly: nextWk,
      reset5h: nextR5,
      resetWeekly: nextRW,
      updatedAtMs: Date.now(),
    };

    if (changed) {
      updateFooterContent();
      if (state.popoverOpen && !state.editingAccountId) {
        renderPopover();
      }
    }
  }

  function applyMetricsSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return false;
    const groups = Array.isArray(snap.groups) ? snap.groups : [];
    if (!groups.length) return false;
    const model = snap.speed?.context?.model || snap.speed?.model || '';
    const qg = pickPrismQuotaGroup(groups, model);
    if (!qg) return false;
    const w5 = qg.windows?.['5h'] || qg.fiveHour || null;
    const wW = qg.windows?.weekly || qg.weekly || null;
    const quota5h = readPrismWindowPct(w5);
    const quotaWeekly = readPrismWindowPct(wW);
    if (quota5h === null && quotaWeekly === null) return false;
    applyLiveQuota({
      quota5h,
      quotaWeekly,
      reset5h: typeof w5?.resetAt === 'string' ? w5.resetAt : null,
      resetWeekly: typeof wW?.resetAt === 'string' ? wW.resetAt : null,
    });
    return true;
  }

  function findPulseBarHost() {
    const selectors = [
      '#ag-prism-pulse-bar',
      '[data-ag-prism-pulse-bar="true"]',
      '#ag-pulse-status-bar',
      '[data-ag-pulse-bar="true"]',
    ];
    for (const sel of selectors) {
      const list = document.querySelectorAll(sel);
      for (const node of list) {
        if (node && node.shadowRoot && node.style?.display !== 'none') {
          return node;
        }
      }
    }
    return null;
  }

  function parsePctText(text) {
    const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*%/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  }

  function syncFromPulseShadowDom() {
    if (destroyed) return false;
    const host = findPulseBarHost();
    const sr = host?.shadowRoot || null;
    if (!sr) {
      if (pulseShadowObs) {
        pulseShadowObs.disconnect();
        pulseShadowObs = null;
        pulseObservedHost = null;
      }
      return false;
    }

    const fiveEl = sr.getElementById('five-balance');
    const weekEl = sr.getElementById('week-balance');
    const p5 = parsePctText(fiveEl?.textContent);
    const pW = parsePctText(weekEl?.textContent);
    if (p5 !== null || pW !== null) {
      applyLiveQuota({ quota5h: p5, quotaWeekly: pW });
    }

    if (typeof MutationObserver === 'function' && host !== pulseObservedHost) {
      if (pulseShadowObs) pulseShadowObs.disconnect();
      pulseShadowObs = new MutationObserver(() => {
        if (!destroyed) syncFromPulseShadowDom();
      });
      pulseObservedHost = host;
      if (fiveEl) pulseShadowObs.observe(fiveEl, { childList: true, characterData: true, subtree: true });
      if (weekEl) pulseShadowObs.observe(weekEl, { childList: true, characterData: true, subtree: true });
      if (!fiveEl && !weekEl) {
        pulseShadowObs.observe(sr, { childList: true, characterData: true, subtree: true });
      }
    }
    return true;
  }

  function installPulseBridgeTap() {
    if (ourPulseBridge && window.__agPulseExternalBridge === ourPulseBridge) return;
    prevPulseBridge = typeof window.__agPulseExternalBridge === 'function' ? window.__agPulseExternalBridge : null;
    ourPulseBridge = (ev) => {
      try {
        if (typeof prevPulseBridge === 'function') prevPulseBridge(ev);
      } catch {}
      if (destroyed || !ev || typeof ev !== 'object') return;
      if ((ev.event === 'render' || ev.event === 'mount') && ev.data) {
        lastBridgeAtMs = Date.now();
        applyMetricsSnapshot(ev.data);
      }
    };
    try {
      window.__agPulseExternalBridge = ourPulseBridge;
    } catch {}
  }

  async function pollInMemoryQuota() {
    if (destroyed || document.hidden || livePollInFlight) return;
    installPulseBridgeTap();
    const hasBar = syncFromPulseShadowDom();
    if (hasBar || Date.now() - lastBridgeAtMs < 2500) return;

    const metricsHost = window.__agPrismMetricsBridge || window.agPulseHost;
    if (!metricsHost || typeof metricsHost.getMetrics !== 'function') return;

    livePollInFlight = true;
    try {
      const cidMatch = (window.location?.pathname || '').match(/\/c\/([\da-f-]{36})/i);
      const cid = cidMatch ? cidMatch[1] : null;
      const snap = await Promise.race([
        Promise.resolve(metricsHost.getMetrics({ conversationId: cid, force: false })).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 1500)),
      ]);
      if (!destroyed && snap) {
        applyMetricsSnapshot(snap);
      }
    } finally {
      livePollInFlight = false;
    }
  }

  // =========================================================================
  // CSS INJECTION (MONOCHROME NEUTRALS, 4-THEME + STOCK COMPATIBLE)
  // =========================================================================
  const CSS_TEXT = `
    [${FOOTER_ATTR}="1"] {
      display: flex !important;
      flex-direction: row !important;
      align-items: center !important;
      gap: 4px !important;
      min-height: 31px;
      background: transparent !important;
      background-color: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
    }

    [${FOOTER_ATTR}="1"] .ag-as-micro-wrap {
      display: flex !important;
      flex-direction: row !important;
      align-items: center !important;
      gap: 4px !important;
      width: 100%;
      min-width: 0;
      height: 31px;
      background: transparent !important;
      background-color: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
    }

    [${FOOTER_ATTR}="1"] .ag-as-seg {
      appearance: none;
      border: 0 !important;
      margin: 0;
      background: transparent !important;
      background-color: transparent !important;
      box-shadow: none !important;
      outline: none;
      height: 28px;
      min-height: 28px;
      border-radius: var(--ag-cs-r-md, 6px);
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      color: var(--secondary-foreground, #C4C4CE);
      font-family: var(--font-sans, 'Google Sans Flex', 'Google Sans', 'Inter', 'Segoe UI', system-ui, sans-serif);
      transition: background-color 120ms ease, color 120ms ease;
      user-select: none;
    }

    [${FOOTER_ATTR}="1"] .ag-as-seg:hover,
    [${FOOTER_ATTR}="1"] .ag-as-seg[aria-expanded="true"] {
      background-color: var(--_sv, rgba(255, 255, 255, 0.055)) !important;
      color: var(--foreground, #F2F2F5) !important;
    }

    [${FOOTER_ATTR}="1"] .ag-as-seg:focus-visible {
      outline: 1.5px solid var(--primary, #669DF6);
      outline-offset: -1px;
    }

    [${FOOTER_ATTR}="1"] .ag-as-seg-label {
      flex: 1 1 0;
      min-width: 0;
      padding: 0 6px;
      justify-content: flex-start;
      text-align: left;
      font-size: 12.5px;
      font-weight: 500;
    }

    [${FOOTER_ATTR}="1"] .ag-as-label-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    [${FOOTER_ATTR}="1"] .ag-as-seg-quota {
      flex: 0 0 auto;
      padding: 0 5px;
      justify-content: center;
      font-family: var(--ag-cs-mono-stack, var(--font-mono, 'Google Sans Code', 'Cascadia Code', Consolas, ui-monospace, monospace));
      font-variant-numeric: tabular-nums;
      font-size: 11.5px;
      font-weight: 500;
      color: var(--muted-foreground, #8E91A1);
      white-space: nowrap;
      gap: 0;
    }

    [${FOOTER_ATTR}="1"] .ag-as-q-pair {
      display: inline-flex;
      align-items: baseline;
    }

    [${FOOTER_ATTR}="1"] .ag-as-q-tag,
    #${POPOVER_ID} .ag-as-q-tag {
      font-size: 9px;
      font-weight: 500;
      opacity: 0.68;
      margin-right: 2px;
      letter-spacing: 0.01em;
    }

    [${FOOTER_ATTR}="1"] .ag-as-q-dot,
    #${POPOVER_ID} .ag-as-q-dot {
      opacity: 0.45;
      margin: 0 3px;
    }

    [${FOOTER_ATTR}="1"] .ag-as-sep {
      width: 1px;
      height: 12px;
      background: var(--border, rgba(218, 228, 255, 0.12));
      flex-shrink: 0;
      pointer-events: none;
    }

    [${FOOTER_ATTR}="1"] [${SETTINGS_ATTR}="1"] {
      flex: 0 0 auto !important;
      flex-grow: 0 !important;
      width: auto !important;
      min-width: 0 !important;
      height: 28px !important;
      min-height: 28px !important;
      padding: 0 6px !important;
      gap: 5px !important;
      border: 0 !important;
      background: transparent !important;
      background-color: transparent !important;
      box-shadow: none !important;
      border-radius: var(--ag-cs-r-md, 6px) !important;
      font-size: 12.5px !important;
      font-weight: 450 !important;
      color: var(--secondary-foreground, #C4C4CE) !important;
      justify-content: center !important;
    }

    [${FOOTER_ATTR}="1"] [${SETTINGS_ATTR}="1"]:hover {
      background-color: var(--_sv, rgba(255, 255, 255, 0.055)) !important;
      color: var(--foreground, #F2F2F5) !important;
    }

    /* Collapsed 52px sidebar mode */
    html[data-ag-cs-sidebar="on"][data-ag-cs-sidebar-collapsed="1"] [${FOOTER_ATTR}="1"],
    [${FOOTER_ATTR}="1"][${COLLAPSED_ATTR}="1"] {
      flex-direction: column !important;
      align-items: center !important;
      gap: 4px !important;
      padding: 6px 4px 0 4px !important;
      height: auto !important;
    }

    html[data-ag-cs-sidebar="on"][data-ag-cs-sidebar-collapsed="1"] [${FOOTER_ATTR}="1"] .ag-as-micro-wrap,
    [${FOOTER_ATTR}="1"][${COLLAPSED_ATTR}="1"] .ag-as-micro-wrap {
      flex-direction: column !important;
      align-items: center !important;
      height: auto !important;
      gap: 4px !important;
    }

    html[data-ag-cs-sidebar="on"][data-ag-cs-sidebar-collapsed="1"] [${FOOTER_ATTR}="1"] .ag-as-seg-label,
    html[data-ag-cs-sidebar="on"][data-ag-cs-sidebar-collapsed="1"] [${FOOTER_ATTR}="1"] .ag-as-sep,
    [${FOOTER_ATTR}="1"][${COLLAPSED_ATTR}="1"] .ag-as-seg-label,
    [${FOOTER_ATTR}="1"][${COLLAPSED_ATTR}="1"] .ag-as-sep {
      display: none !important;
    }

    html[data-ag-cs-sidebar="on"][data-ag-cs-sidebar-collapsed="1"] [${FOOTER_ATTR}="1"] .ag-as-seg-quota,
    [${FOOTER_ATTR}="1"][${COLLAPSED_ATTR}="1"] .ag-as-seg-quota {
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      width: 40px !important;
      height: auto !important;
      min-height: 32px !important;
      padding: 3px 0 !important;
      gap: 1px !important;
      font-size: 10.5px !important;
      line-height: 1.15 !important;
    }

    html[data-ag-cs-sidebar="on"][data-ag-cs-sidebar-collapsed="1"] [${FOOTER_ATTR}="1"] .ag-as-q-dot,
    [${FOOTER_ATTR}="1"][${COLLAPSED_ATTR}="1"] .ag-as-q-dot {
      display: none !important;
    }

    html[data-ag-cs-sidebar="on"][data-ag-cs-sidebar-collapsed="1"] [${FOOTER_ATTR}="1"] [${SETTINGS_ATTR}="1"],
    [${FOOTER_ATTR}="1"][${COLLAPSED_ATTR}="1"] [${SETTINGS_ATTR}="1"] {
      width: 36px !important;
      min-width: 36px !important;
      max-width: 36px !important;
      height: 36px !important;
      min-height: 36px !important;
      padding: 0 !important;
      gap: 0 !important;
      justify-content: center !important;
    }

    html[data-ag-cs-sidebar="on"][data-ag-cs-sidebar-collapsed="1"] [${FOOTER_ATTR}="1"] [${SETTINGS_ATTR}="1"] > span:not(:first-child),
    [${FOOTER_ATTR}="1"][${COLLAPSED_ATTR}="1"] [${SETTINGS_ATTR}="1"] > span:not(:first-child) {
      display: none !important;
    }

    /* Upward Popover Portal */
    #${POPOVER_ID} {
      position: fixed;
      z-index: 99999;
      width: 324px;
      max-width: calc(100vw - 16px);
      background: var(--ag-cs-popover-bg, var(--popover, var(--card, #1B1D25)));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--ag-cs-border-2, var(--card-border, var(--border, rgba(218, 228, 255, 0.14))));
      border-radius: var(--ag-cs-r-lg, 10px);
      box-shadow: var(--_cx, var(--_gs, 0 14px 36px rgba(0, 0, 0, 0.48), 0 2px 8px rgba(0, 0, 0, 0.3)));
      padding: 6px;
      color: var(--foreground, #F2F2F5);
      font-family: var(--font-sans, 'Google Sans Flex', 'Google Sans', 'Inter', 'Segoe UI', system-ui, sans-serif);
      font-size: 12.5px;
      animation: agAsPopIn 130ms cubic-bezier(0.16, 1, 0.3, 1);
      transform-origin: bottom left;
      box-sizing: border-box;
    }

    @keyframes agAsPopIn {
      from { opacity: 0; transform: translateY(4px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    #${POPOVER_ID} * {
      box-sizing: border-box;
    }

    #${POPOVER_ID} .ag-as-pop-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 14px 6px 10px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--border, rgba(218, 228, 255, 0.1));
    }

    #${POPOVER_ID} .ag-as-pop-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--foreground, #F2F2F5);
      white-space: nowrap;
    }

    @keyframes agAsSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    #${POPOVER_ID} .ag-as-icon-btn {
      appearance: none;
      border: 0 !important;
      background: transparent !important;
      background-color: transparent !important;
      box-shadow: none !important;
      outline: none;
      color: var(--muted-foreground, #8E91A1);
      width: 22px;
      height: 22px;
      border-radius: var(--ag-cs-r-sm, 4px);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      margin: 0;
      flex-shrink: 0;
      opacity: 0.68;
      transition: opacity 110ms ease, background-color 110ms ease, color 110ms ease;
    }

    #${POPOVER_ID} .ag-as-icon-btn:hover {
      opacity: 1;
      background-color: var(--_sv, rgba(255, 255, 255, 0.06)) !important;
      color: var(--foreground, #F2F2F5) !important;
    }

    #${POPOVER_ID} .ag-as-icon-btn:focus-visible {
      outline: 1.5px solid var(--primary, #669DF6);
      outline-offset: -1px;
    }

    #${POPOVER_ID} .ag-as-icon-btn.is-spinning svg {
      animation: agAsSpin 480ms linear infinite;
    }

    #${POPOVER_ID} .ag-as-table-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 54px 54px 24px;
      align-items: center;
      gap: 6px;
      padding: 2px 14px 4px 10px;
      font-family: var(--ag-cs-mono-stack, var(--font-mono, 'Google Sans Code', 'Cascadia Code', Consolas, ui-monospace, monospace));
      font-size: 10px;
      font-weight: 500;
      color: var(--muted-foreground, #8E91A1);
      opacity: 0.78;
      user-select: none;
    }

    #${POPOVER_ID} .ag-as-table-head-num {
      text-align: right;
    }

    #${POPOVER_ID} .ag-as-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 270px;
      overflow-y: auto;
      padding-right: 10px;
      scrollbar-gutter: stable;
    }

    #${POPOVER_ID} .ag-as-list::-webkit-scrollbar {
      width: 4px;
    }

    #${POPOVER_ID} .ag-as-list::-webkit-scrollbar-track {
      background: transparent;
    }

    #${POPOVER_ID} .ag-as-list::-webkit-scrollbar-thumb {
      background: var(--border, rgba(218, 228, 255, 0.14));
      border-radius: 999px;
    }

    #${POPOVER_ID} .ag-as-row {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 54px 54px 24px;
      align-items: center;
      gap: 6px;
      border-radius: var(--ag-cs-r-md, 6px);
      padding: 6px 4px 6px 10px;
      transition: background-color 110ms ease;
    }

    #${POPOVER_ID} .ag-as-row.is-active {
      background: var(--_ss, rgba(255, 255, 255, 0.074));
    }

    #${POPOVER_ID} .ag-as-row.is-active::before {
      content: '';
      position: absolute;
      left: 0;
      top: 6px;
      bottom: 6px;
      width: 2.5px;
      border-radius: 2px;
      background: var(--primary, #669DF6);
    }

    #${POPOVER_ID} .ag-as-row:not(.is-disabled):not(.is-active):hover {
      background: var(--_sv, rgba(255, 255, 255, 0.055));
    }

    #${POPOVER_ID} .ag-as-row.is-disabled {
      opacity: 0.48;
    }

    #${POPOVER_ID} .ag-as-row-main {
      grid-column: 1 / 4;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 54px 54px;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 0;
      border-radius: var(--ag-cs-r-sm, 4px);
      cursor: pointer;
      outline: none;
      color: var(--secondary-foreground, #C4C4CE);
    }

    #${POPOVER_ID} .ag-as-row.is-active .ag-as-row-main {
      color: var(--foreground, #F2F2F5);
    }

    #${POPOVER_ID} .ag-as-row.is-disabled .ag-as-row-main {
      cursor: not-allowed;
    }

    #${POPOVER_ID} .ag-as-row-main:focus-visible {
      outline: 1.5px solid var(--primary, #669DF6);
      outline-offset: 2px;
    }

    #${POPOVER_ID} .ag-as-cell-name {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }

    #${POPOVER_ID} .ag-as-row-label {
      font-size: 12.5px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }

    #${POPOVER_ID} .ag-as-tier-badge {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.03em;
      padding: 1px 4px;
      border-radius: var(--ag-cs-r-sm, 4px);
      background: var(--_sv, rgba(255, 255, 255, 0.06));
      color: var(--muted-foreground, #8E91A1);
      flex-shrink: 0;
      line-height: 1.2;
    }

    #${POPOVER_ID} .ag-as-cell-q {
      text-align: right;
      font-family: var(--ag-cs-mono-stack, var(--font-mono, 'Google Sans Code', 'Cascadia Code', Consolas, ui-monospace, monospace));
      font-variant-numeric: tabular-nums;
      line-height: 1.25;
      min-width: 0;
    }

    #${POPOVER_ID} .ag-as-cell-pct {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--secondary-foreground, #C4C4CE);
      white-space: nowrap;
    }

    #${POPOVER_ID} .ag-as-row.is-active .ag-as-cell-pct {
      color: var(--foreground, #F2F2F5);
    }

    #${POPOVER_ID} .ag-as-cell-reset {
      font-size: 10px;
      font-weight: 400;
      color: var(--muted-foreground, #8E91A1);
      white-space: nowrap;
      margin-top: 1px;
    }

    #${POPOVER_ID} .ag-as-label-input {
      width: 100%;
      min-width: 0;
      height: 22px;
      padding: 0 6px;
      border-radius: var(--ag-cs-r-sm, 4px);
      border: 1px solid var(--primary, #669DF6);
      background: var(--sidebar, #121318);
      color: var(--foreground, #F2F2F5);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      outline: none;
    }

    #${POPOVER_ID} .ag-as-edit-btn {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--muted-foreground, #8E91A1);
      width: 22px;
      height: 22px;
      border-radius: var(--ag-cs-r-sm, 4px);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      justify-self: end;
      flex-shrink: 0;
      opacity: 0.45;
      transition: opacity 110ms ease, background-color 110ms ease, color 110ms ease;
    }

    #${POPOVER_ID} .ag-as-row:hover .ag-as-edit-btn,
    #${POPOVER_ID} .ag-as-row:focus-within .ag-as-edit-btn,
    #${POPOVER_ID} .ag-as-edit-btn:focus-visible {
      opacity: 0.9;
    }

    #${POPOVER_ID} .ag-as-edit-btn:hover {
      opacity: 1 !important;
      background: var(--_ss, rgba(255, 255, 255, 0.08));
      color: var(--foreground, #F2F2F5);
    }

    #${POPOVER_ID} .ag-as-empty {
      padding: 14px 8px;
      text-align: center;
      font-size: 12px;
      color: var(--muted-foreground, #8E91A1);
    }

    /* Compact Feedback Toast */
    #${TOAST_ID} {
      position: fixed;
      z-index: 100000;
      left: 12px;
      bottom: 48px;
      max-width: 280px;
      background: var(--ag-cs-popover-bg, var(--popover, var(--card, #1B1D25)));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--ag-cs-border-2, var(--card-border, var(--border, rgba(218, 228, 255, 0.14))));
      border-radius: var(--ag-cs-r-md, 6px);
      box-shadow: var(--_cx, var(--_gs, 0 10px 28px rgba(0, 0, 0, 0.42)));
      padding: 7px 11px;
      color: var(--foreground, #F2F2F5);
      font-family: var(--font-sans, 'Google Sans Flex', 'Google Sans', 'Inter', 'Segoe UI', system-ui, sans-serif);
      font-size: 12px;
      line-height: 1.35;
      display: flex;
      align-items: center;
      gap: 7px;
      pointer-events: none;
      animation: agAsPopIn 130ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    #${TOAST_ID}[data-tone="error"] {
      border-color: var(--error, #E5534B);
      color: var(--error, #E5534B);
    }

    #${TOAST_ID} .ag-as-toast-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--primary, var(--foreground, #669DF6));
      flex-shrink: 0;
    }

    #${TOAST_ID}[data-tone="error"] .ag-as-toast-dot {
      background: var(--error, #E5534B);
    }
  `;

  function ensureStyle() {
    if (destroyed) return;
    const existing = document.getElementById(STYLE_ID);
    if (existing) {
      styleEl = existing;
      return;
    }
    const s = createEl('style', '', { id: STYLE_ID });
    s.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(s);
    styleEl = s;
  }

  // =========================================================================
  // TOAST FEEDBACK
  // =========================================================================
  function showToast(message, tone, durationMs) {
    if (destroyed) return;
    clearTimeout(toastTimer);
    state.toast = { message, tone: tone || 'info' };
    renderToast();
    if (durationMs !== 0) {
      toastTimer = setTimeout(() => {
        state.toast = null;
        renderToast();
      }, durationMs || 3200);
    }
  }

  function renderToast() {
    if (destroyed || !state.toast) {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = null;
      return;
    }
    if (!toastEl) {
      toastEl = createEl('div', '', { id: TOAST_ID, role: 'status', 'aria-live': 'polite' });
      const dot = createEl('span', 'ag-as-toast-dot');
      const txt = createEl('span', 'ag-as-toast-text');
      toastEl.appendChild(dot);
      toastEl.appendChild(txt);
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.setAttribute('data-tone', state.toast.tone || 'info');
    const txtEl = toastEl.querySelector('.ag-as-toast-text');
    if (txtEl) txtEl.textContent = state.toast.message;
  }

  // =========================================================================
  // SIDEBAR & SETTINGS DISCOVERY + MOUNTING
  // =========================================================================
  function findSidebarRoot() {
    return (
      document.querySelector('div[role="navigation"][aria-label="Sidebar"]') ||
      document.querySelector('[data-testid="sidebar-split"] > div:first-child') ||
      null
    );
  }

  function isSettingsButtonCandidate(btn) {
    if (!btn || btn.getAttribute(OWNED_ATTR) === '1' || btn.closest(`[${OWNED_ATTR}="1"]`)) return false;
    const role = btn.getAttribute('role');
    if (role === 'menuitem' || role === 'tab') return false;
    const tid = btn.getAttribute('data-testid') || '';
    if (tid === 'settings-button' || tid === 'open-settings-button') return true;
    if (btn.querySelector('svg.lucide-settings, .ag-icon-settings-gear')) return true;
    const lbl = (btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '').trim();
    return /^(?:open\s+)?settings$|^ayarlar$|^(?:打开)?设置$|^設定$/i.test(lbl);
  }

  function findSettingsButton() {
    const sidebar = findSidebarRoot();
    if (!sidebar) return null;
    const direct =
      sidebar.querySelector('button[data-testid="settings-button"]') ||
      sidebar.querySelector('button[data-testid="open-settings-button"]');
    if (direct && isSettingsButtonCandidate(direct)) return direct;
    const allBtns = sidebar.querySelectorAll('button');
    for (let i = allBtns.length - 1; i >= 0; i--) {
      if (isSettingsButtonCandidate(allBtns[i])) return allBtns[i];
    }
    return null;
  }

  function isSidebarCollapsed() {
    const html = document.documentElement;
    if (
      html.getAttribute('data-ag-cs-sidebar') === 'on' &&
      html.getAttribute('data-ag-cs-sidebar-collapsed') === '1'
    ) {
      return true;
    }
    const sidebar = findSidebarRoot();
    if (sidebar) {
      const rect = sidebar.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.width <= 72) return true;
    }
    if (footerContainer) {
      const rect = footerContainer.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.width <= 72) return true;
    }
    return false;
  }

  function syncCollapsedState() {
    if (!footerContainer) return;
    const collapsed = isSidebarCollapsed();
    if (collapsed) {
      footerContainer.setAttribute(COLLAPSED_ATTR, '1');
    } else {
      footerContainer.removeAttribute(COLLAPSED_ATTR);
    }
    if (state.popoverOpen) positionPopover();
  }

  function unmountFooter() {
    if (fallbackWrap && settingsBtn && fallbackOrigParent) {
      try {
        if (fallbackOrigNext && fallbackOrigNext.parentNode === fallbackOrigParent) {
          fallbackOrigParent.insertBefore(settingsBtn, fallbackOrigNext);
        } else {
          fallbackOrigParent.appendChild(settingsBtn);
        }
      } catch {
        // ignore if React already removed parent
      }
      if (fallbackWrap.parentNode) fallbackWrap.parentNode.removeChild(fallbackWrap);
    }
    for (const el of [labelBtn, sep1, quotaBtn, sep2]) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    if (footerContainer) {
      footerContainer.removeAttribute(FOOTER_ATTR);
      footerContainer.removeAttribute(COLLAPSED_ATTR);
    }
    if (settingsBtn) {
      settingsBtn.removeAttribute(SETTINGS_ATTR);
    }
    footerContainer = null;
    settingsBtn = null;
    labelBtn = null;
    labelTextEl = null;
    quotaBtn = null;
    sep1 = null;
    sep2 = null;
    fallbackWrap = null;
    fallbackOrigParent = null;
    fallbackOrigNext = null;
  }

  function updateFooterContent() {
    if (!labelBtn || !quotaBtn || !labelTextEl) return;
    const active = getActiveAccount();
    const label = getDisplayLabel(active);
    const eff = getEffectiveQuota(active);
    const q5hRaw = eff.quota5h;
    const qWeekRaw = eff.quotaWeekly;
    const q5h = formatQuotaPct(q5hRaw);
    const qWeek = formatQuotaPct(qWeekRaw);

    labelTextEl.textContent = label;
    labelBtn.setAttribute('title', `${label} · 5h ${q5h} · 7d ${qWeek}`);
    labelBtn.setAttribute('aria-label', `Aktif hesap: ${label}`);
    labelBtn.setAttribute('aria-expanded', state.popoverOpen ? 'true' : 'false');

    quotaBtn.textContent = '';
    appendQuotaPairNodes(quotaBtn, q5hRaw, qWeekRaw);
    quotaBtn.setAttribute('title', `${label} · 5h ${q5h} · 7d ${qWeek}`);
    quotaBtn.setAttribute('aria-label', `Kalan kota: 5h ${q5h}, 7d ${qWeek}`);
    quotaBtn.setAttribute('aria-expanded', state.popoverOpen ? 'true' : 'false');
  }

  function mountFooter() {
    if (destroyed) return;
    ensureStyle();

    const targetSettings = findSettingsButton();
    if (!targetSettings || !targetSettings.parentElement) return;

    const alreadyValid =
      settingsBtn === targetSettings &&
      labelBtn &&
      labelBtn.isConnected &&
      quotaBtn &&
      quotaBtn.isConnected &&
      targetSettings.isConnected;

    if (alreadyValid) {
      syncCollapsedState();
      updateFooterContent();
      return;
    }

    unmountFooter();

    settingsBtn = targetSettings;
    const parent = targetSettings.parentElement;
    const nonOwnedChildren = Array.from(parent.children).filter(
      (c) => c.getAttribute(OWNED_ATTR) !== '1'
    );

    labelBtn = createEl('button', 'ag-as-seg ag-as-seg-label', {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });
    labelTextEl = createEl('span', 'ag-as-label-text');
    labelBtn.appendChild(labelTextEl);

    sep1 = createEl('span', 'ag-as-sep', { 'aria-hidden': 'true' });

    quotaBtn = createEl('button', 'ag-as-seg ag-as-seg-quota', {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });

    sep2 = createEl('span', 'ag-as-sep', { 'aria-hidden': 'true' });

    labelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePopover();
    });
    quotaBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePopover();
    });

    settingsBtn.setAttribute(SETTINGS_ATTR, '1');

    if (nonOwnedChildren.length <= 1) {
      // Safe inline sibling injection: native Settings button stays in its React parent
      footerContainer = parent;
      footerContainer.setAttribute(FOOTER_ATTR, '1');
      footerContainer.insertBefore(labelBtn, settingsBtn);
      footerContainer.insertBefore(sep1, settingsBtn);
      footerContainer.insertBefore(quotaBtn, settingsBtn);
      footerContainer.insertBefore(sep2, settingsBtn);
    } else {
      // Fallback wrapper if parent holds additional native buttons
      fallbackOrigParent = parent;
      fallbackOrigNext = settingsBtn.nextSibling;
      fallbackWrap = createEl('div', 'ag-as-micro-wrap');
      footerContainer = createEl('div', '');
      markOwned(footerContainer);
      footerContainer.setAttribute(FOOTER_ATTR, '1');
      parent.insertBefore(footerContainer, settingsBtn);
      footerContainer.appendChild(fallbackWrap);
      fallbackWrap.appendChild(labelBtn);
      fallbackWrap.appendChild(sep1);
      fallbackWrap.appendChild(quotaBtn);
      fallbackWrap.appendChild(sep2);
      fallbackWrap.appendChild(settingsBtn);
    }

    observeSidebarSize();
    syncCollapsedState();
    updateFooterContent();
  }

  function scheduleMount() {
    if (destroyed || mountRaf) return;
    mountRaf = requestAnimationFrame(() => {
      mountRaf = 0;
      if (!destroyed) {
        mountFooter();
        syncFromPulseShadowDom();
      }
    });
  }

  function observeSidebarSize() {
    if (sidebarResizeObs) {
      sidebarResizeObs.disconnect();
      sidebarResizeObs = null;
    }
    const sidebar = findSidebarRoot();
    if (!sidebar || typeof ResizeObserver !== 'function') return;
    sidebarResizeObs = new ResizeObserver(() => {
      if (!destroyed) syncCollapsedState();
    });
    sidebarResizeObs.observe(sidebar);
  }

  // =========================================================================
  // POPOVER PORTAL & ACTIONS
  // =========================================================================
  function positionPopover() {
    if (!popoverEl) return;
    const collapsed = isSidebarCollapsed();
    const anchor = (collapsed ? quotaBtn : footerContainer || labelBtn) || settingsBtn;
    if (!anchor || !anchor.getBoundingClientRect) return;
    const rect = anchor.getBoundingClientRect();
    const popWidth = 324;
    const margin = 8;

    if (collapsed) {
      const left = Math.min(window.innerWidth - popWidth - margin, Math.max(margin, rect.right + 8));
      const bottom = Math.max(margin, window.innerHeight - rect.bottom);
      popoverEl.style.left = `${Math.round(left)}px`;
      popoverEl.style.bottom = `${Math.round(bottom)}px`;
    } else {
      const left = Math.min(window.innerWidth - popWidth - margin, Math.max(margin, rect.left));
      const bottom = Math.max(margin, window.innerHeight - rect.top + 6);
      popoverEl.style.left = `${Math.round(left)}px`;
      popoverEl.style.bottom = `${Math.round(bottom)}px`;
    }
  }

  function closePopover() {
    if (!state.popoverOpen) return;
    state.popoverOpen = false;
    state.editingAccountId = null;
    state.editingDraft = '';
    if (popoverEl && popoverEl.parentNode) {
      popoverEl.parentNode.removeChild(popoverEl);
    }
    popoverEl = null;
    updateFooterContent();
  }

  function openPopover() {
    if (destroyed) return;
    state.popoverOpen = true;
    renderPopover();
    updateFooterContent();
    refreshAccounts({ silent: true });
  }

  function togglePopover() {
    if (state.popoverOpen) closePopover();
    else openPopover();
  }

  async function refreshAccounts(opts) {
    try {
      const res = await rpcCall('list-accounts', {});
      if (destroyed) return;
      if (res && res.ok) {
        const nextActiveId = res.activeId || null;
        if (state.activeId && nextActiveId && nextActiveId !== state.activeId) {
          state.liveQuota = null;
        }
        state.accounts = Array.isArray(res.accounts) ? res.accounts : [];
        state.activeId = nextActiveId;
        state.loading = false;
        syncFromPulseShadowDom();
        updateFooterContent();
        if (state.popoverOpen) renderPopover();
      } else if (!opts?.silent) {
        showToast(res?.error || 'Hesaplar yüklenemedi', 'error');
      }
    } catch (err) {
      state.loading = false;
      updateFooterContent();
      if (!opts?.silent) {
        showToast(err?.message || 'Hesaplar yüklenemedi', 'error');
      }
    }
  }

  async function handleRefreshCache() {
    try {
      const res = await rpcCall('refresh-cache', {});
      if (destroyed) return;
      if (res && res.ok && Array.isArray(res.accounts)) {
        state.accounts = res.accounts;
        state.activeId = res.activeId || state.activeId;
        updateFooterContent();
        if (state.popoverOpen) renderPopover();
        showToast('Kota önbelleği yenilendi', 'info', 2000);
      } else {
        await refreshAccounts({ silent: true });
      }
    } catch {
      await refreshAccounts({ silent: true });
    }
  }

  async function commitLabelEdit(accountId, rawValue) {
    if (state.editingAccountId !== accountId) return;
    const trimmed = String(rawValue || '').trim().slice(0, 40);
    state.editingAccountId = null;
    state.editingDraft = '';
    renderPopover();

    try {
      const res = await rpcCall('set-label', { accountId, label: trimmed });
      if (destroyed) return;
      if (res && res.ok) {
        if (Array.isArray(res.accounts)) state.accounts = res.accounts;
        if (res.activeId) state.activeId = res.activeId;
        updateFooterContent();
        if (state.popoverOpen) renderPopover();
      } else {
        showToast(res?.error || 'Etiket kaydedilemedi', 'error');
      }
    } catch (err) {
      showToast(err?.message || 'Etiket kaydedilemedi', 'error');
    }
  }

  function cancelLabelEdit() {
    if (!state.editingAccountId) return;
    state.editingAccountId = null;
    state.editingDraft = '';
    if (state.popoverOpen) renderPopover();
  }

  async function handleSwitchAccount(acc) {
    if (!acc || acc.disabled || state.isSwitching) return;
    if (acc.id === state.activeId || acc.isCurrent) {
      closePopover();
      return;
    }

    state.isSwitching = true;
    state.switchingTargetId = acc.id;
    closePopover();
    showToast('Kimlik bilgileri yazılıyor...', 'info', 0);

    try {
      const res = await rpcCall('switch-account', {
        accountId: acc.id,
        launchOnSwitch: true,
      });
      if (destroyed) return;

      if (res && res.ok) {
        if (res.switchedId && res.switchedId !== state.activeId) {
          state.liveQuota = null;
          state.activeId = res.switchedId;
        }
        await refreshAccounts({ silent: true });
        showToast(
          res.message || 'Antigravity yeniden başlatılıyor...',
          'info',
          4200
        );
      } else {
        showToast(res?.error || 'Hesap değiştirilemedi', 'error', 4500);
      }
    } catch (err) {
      if (!destroyed) {
        showToast(err?.message || 'Hesap değiştirme hatası', 'error', 4500);
      }
    } finally {
      state.isSwitching = false;
      state.switchingTargetId = null;
      if (!destroyed) {
        updateFooterContent();
        if (state.popoverOpen) renderPopover();
      }
    }
  }

  function renderPopover() {
    if (destroyed || !state.popoverOpen) return;

    if (!popoverEl) {
      popoverEl = createEl('div', '', {
        id: POPOVER_ID,
        role: 'menu',
        'aria-label': 'Hesap Değiştirici',
      });
      popoverEl.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      (document.body || document.documentElement).appendChild(popoverEl);
    }

    popoverEl.textContent = '';

    // Header
    const head = createEl('div', 'ag-as-pop-head');
    const title = createEl('span', 'ag-as-pop-title');
    title.textContent = 'Hesaplar';

    const refreshBtn = createEl('button', 'ag-as-icon-btn', {
      type: 'button',
      title: 'Yenile',
      'aria-label': 'Yenile',
    });
    refreshBtn.appendChild(refreshIconSvg(12.5));
    refreshBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      refreshBtn.classList.add('is-spinning');
      Promise.resolve(handleRefreshCache()).finally(() => {
        setTimeout(() => refreshBtn.classList.remove('is-spinning'), 320);
      });
    });

    head.appendChild(title);
    head.appendChild(refreshBtn);
    popoverEl.appendChild(head);

    // Table Column Header (Option #6: Hesap | 5h | 7d)
    if (state.accounts.length) {
      const tableHead = createEl('div', 'ag-as-table-head');
      const colName = createEl('span');
      colName.textContent = 'Hesap';
      const col5h = createEl('span', 'ag-as-table-head-num');
      col5h.textContent = '5h';
      const col7d = createEl('span', 'ag-as-table-head-num');
      col7d.textContent = '7d';
      const colEdit = createEl('span');
      tableHead.appendChild(colName);
      tableHead.appendChild(col5h);
      tableHead.appendChild(col7d);
      tableHead.appendChild(colEdit);
      popoverEl.appendChild(tableHead);
    }

    // Accounts List
    const listEl = createEl('div', 'ag-as-list');
    if (!state.accounts.length) {
      const empty = createEl('div', 'ag-as-empty');
      empty.textContent = state.loading ? 'Hesaplar yükleniyor...' : 'Kayıtlı hesap bulunamadı';
      listEl.appendChild(empty);
    } else {
      let inputToFocus = null;
      for (const acc of state.accounts) {
        const isAct = acc.id === state.activeId || !!acc.isCurrent;
        const isEditing = state.editingAccountId === acc.id;
        const row = createEl(
          'div',
          `ag-as-row${isAct ? ' is-active' : ''}${acc.disabled ? ' is-disabled' : ''}`,
          { 'data-account-id': acc.id }
        );

        const main = createEl('div', 'ag-as-row-main', {
          role: 'menuitem',
          tabindex: acc.disabled ? '-1' : '0',
          'aria-disabled': acc.disabled ? 'true' : 'false',
        });

        // Col 1: Account label + tier badge
        const nameCell = createEl('div', 'ag-as-cell-name');
        if (isEditing) {
          let cancelledByEscape = false;
          const input = createEl('input', 'ag-as-label-input', {
            type: 'text',
            maxlength: '40',
            placeholder: acc.defaultLabel || 'Hesap',
            'aria-label': 'Hesap etiketi',
          });
          input.value = state.editingDraft;
          input.addEventListener('click', (e) => e.stopPropagation());
          input.addEventListener('input', () => {
            state.editingDraft = input.value;
          });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              commitLabelEdit(acc.id, input.value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancelledByEscape = true;
              cancelLabelEdit();
            }
          });
          input.addEventListener('blur', () => {
            if (cancelledByEscape) return;
            setTimeout(() => {
              if (!destroyed && !cancelledByEscape && state.editingAccountId === acc.id) {
                commitLabelEdit(acc.id, input.value);
              }
            }, 120);
          });
          nameCell.appendChild(input);
          inputToFocus = input;
        } else {
          const lbl = createEl('span', 'ag-as-row-label');
          lbl.textContent = getDisplayLabel(acc);
          nameCell.appendChild(lbl);

          const tierText = formatTier(acc.tier);
          if (tierText) {
            const tierBadge = createEl('span', 'ag-as-tier-badge');
            tierBadge.textContent = tierText;
            nameCell.appendChild(tierBadge);
          }

          if (acc.disabled) {
            const disBadge = createEl('span', 'ag-as-tier-badge');
            disBadge.textContent = 'Pasif';
            nameCell.appendChild(disBadge);
          }
        }
        main.appendChild(nameCell);

        // Col 2: 5h % + reset
        const eff = getEffectiveQuota(acc);
        const q5Cell = createEl('div', 'ag-as-cell-q');
        const q5Pct = createEl('div', 'ag-as-cell-pct');
        q5Pct.textContent = formatQuotaPct(eff.quota5h);
        const q5Reset = createEl('div', 'ag-as-cell-reset');
        q5Reset.textContent = formatResetTime(eff.reset5h) || '—';
        q5Cell.appendChild(q5Pct);
        q5Cell.appendChild(q5Reset);
        main.appendChild(q5Cell);

        // Col 3: 7d % + reset
        const q7Cell = createEl('div', 'ag-as-cell-q');
        const q7Pct = createEl('div', 'ag-as-cell-pct');
        q7Pct.textContent = formatQuotaPct(eff.quotaWeekly);
        const q7Reset = createEl('div', 'ag-as-cell-reset');
        q7Reset.textContent = formatResetTime(eff.resetWeekly) || '—';
        q7Cell.appendChild(q7Pct);
        q7Cell.appendChild(q7Reset);
        main.appendChild(q7Cell);

        main.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (state.editingAccountId === acc.id) return;
          handleSwitchAccount(acc);
        });
        main.addEventListener('keydown', (e) => {
          if (state.editingAccountId === acc.id) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            handleSwitchAccount(acc);
          }
        });

        row.appendChild(main);

        if (!isEditing) {
          const editBtn = createEl('button', 'ag-as-edit-btn', {
            type: 'button',
            title: 'Etiketi düzenle',
            'aria-label': 'Etiketi düzenle',
          });
          editBtn.appendChild(editIconSvg(12));
          editBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.editingAccountId = acc.id;
            state.editingDraft = acc.hasCustomLabel ? (acc.label || '') : '';
            renderPopover();
          });
          row.appendChild(editBtn);
        }

        listEl.appendChild(row);
      }

      if (inputToFocus) {
        requestAnimationFrame(() => {
          try {
            inputToFocus.focus();
            inputToFocus.select();
          } catch {
            // ignore focus error
          }
        });
      }
    }
    popoverEl.appendChild(listEl);

    positionPopover();
  }

  // =========================================================================
  // GLOBAL LISTENERS & OBSERVERS
  // =========================================================================
  function onDocumentClick(e) {
    if (!state.popoverOpen) return;
    const t = e.target;
    if (popoverEl && popoverEl.contains(t)) return;
    if (labelBtn && labelBtn.contains(t)) return;
    if (quotaBtn && quotaBtn.contains(t)) return;
    closePopover();
  }

  function onDocumentKeydown(e) {
    if (e.key === 'Escape') {
      if (state.editingAccountId) {
        e.preventDefault();
        e.stopPropagation();
        cancelLabelEdit();
        return;
      }
      if (state.popoverOpen) {
        e.preventDefault();
        closePopover();
      }
    }
  }

  function onWindowResize() {
    if (!destroyed) {
      syncCollapsedState();
      if (state.popoverOpen) positionPopover();
    }
  }

  function onVisibilityChange() {
    if (!destroyed && !document.hidden) {
      void pollInMemoryQuota();
    }
  }

  function startObservers() {
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('keydown', onDocumentKeydown, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('resize', onWindowResize);

    if (typeof MutationObserver === 'function') {
      domObserver = new MutationObserver((mutations) => {
        if (destroyed) return;
        for (const m of mutations) {
          const tgt = m.target;
          if (tgt && tgt.nodeType === 1 && tgt.closest && tgt.closest(`[${OWNED_ATTR}="1"]`)) {
            continue;
          }
          scheduleMount();
          break;
        }
      });
      domObserver.observe(document.documentElement, { childList: true, subtree: true });

      htmlAttrObserver = new MutationObserver(() => {
        if (!destroyed) syncCollapsedState();
      });
      htmlAttrObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-ag-cs-sidebar-collapsed', 'data-ag-cs-sidebar'],
      });
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(toastTimer);
    clearTimeout(startupRetryTimer);
    if (liveQuotaTimer) {
      clearInterval(liveQuotaTimer);
      liveQuotaTimer = null;
    }
    if (mountRaf) {
      cancelAnimationFrame(mountRaf);
      mountRaf = 0;
    }

    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onDocumentKeydown, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('resize', onWindowResize);

    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    if (htmlAttrObserver) {
      htmlAttrObserver.disconnect();
      htmlAttrObserver = null;
    }
    if (pulseShadowObs) {
      pulseShadowObs.disconnect();
      pulseShadowObs = null;
      pulseObservedHost = null;
    }
    if (sidebarResizeObs) {
      sidebarResizeObs.disconnect();
      sidebarResizeObs = null;
    }

    if (ourPulseBridge && window.__agPulseExternalBridge === ourPulseBridge) {
      try {
        if (prevPulseBridge) {
          window.__agPulseExternalBridge = prevPulseBridge;
        } else {
          delete window.__agPulseExternalBridge;
        }
      } catch {
        window.__agPulseExternalBridge = prevPulseBridge || undefined;
      }
    }
    ourPulseBridge = null;
    prevPulseBridge = null;

    for (const entry of pendingRpc.values()) {
      clearTimeout(entry.timer);
    }
    pendingRpc.clear();

    closePopover();
    state.toast = null;
    renderToast();
    unmountFooter();

    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }
    styleEl = null;

    document.querySelectorAll(`[${ROOT_ATTR}="1"]`).forEach((el) => {
      if (el.parentNode) el.parentNode.removeChild(el);
    });

    if (window.__agAccountSwitcherOnUpdate === handlePushUpdate) {
      try {
        delete window.__agAccountSwitcherOnUpdate;
      } catch {
        window.__agAccountSwitcherOnUpdate = undefined;
      }
    }

    if (window[GLOBAL_KEY] === api) {
      try {
        delete window[GLOBAL_KEY];
      } catch {
        window[GLOBAL_KEY] = undefined;
      }
    }
  }

  const api = {
    destroy,
    refresh: () => refreshAccounts({ silent: true }),
    openPopover,
    closePopover,
    getState: () => ({
      activeId: state.activeId,
      accountCount: state.accounts.length,
      popoverOpen: state.popoverOpen,
      isSwitching: state.isSwitching,
      mounted: !!(labelBtn && labelBtn.isConnected),
    }),
  };

  window[GLOBAL_KEY] = api;

  function boot() {
    if (destroyed) return;
    installPulseBridgeTap();
    startObservers();
    mountFooter();
    void pollInMemoryQuota();
    liveQuotaTimer = setInterval(() => {
      if (!destroyed) void pollInMemoryQuota();
    }, 2000);
    refreshAccounts({ silent: true });
    startupRetryTimer = setTimeout(() => {
      if (!destroyed && !state.accounts.length) {
        refreshAccounts({ silent: true });
      }
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
