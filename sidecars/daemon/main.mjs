import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  atomicWriteFile,
  getConfig,
  invalidateCredentialCache,
  listAccounts,
  redactSecrets,
  resolvePaths,
  setConfig,
  setLabel,
} from './cockpit-store.mjs';
import { switchAccountNative } from './native-switcher.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BINDING_NAME = '__agAccountSwitcherCall';
export const RESOLVE_FN = '__agAccountSwitcherResolve';
export const UPDATE_FN = '__agAccountSwitcherOnUpdate';
const DEFAULT_POLL_MS = 2000;
const MAX_PAYLOAD_LEN = 16384;

function serializeJsonForEval(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function resolvePortFileCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'Antigravity', 'DevToolsActivePort'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    candidates.push(path.join(xdg, 'Antigravity', 'DevToolsActivePort'));
  }
  return candidates;
}

export function discoverActivePort(overridePort = null, customPortFile = null) {
  if (overridePort && Number.isInteger(Number(overridePort)) && Number(overridePort) > 0) {
    return Number(overridePort);
  }
  if (process.env.AG_CDP_PORT) {
    const p = parseInt(process.env.AG_CDP_PORT, 10);
    if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
  }
  const files = customPortFile ? [customPortFile] : resolvePortFileCandidates();
  for (const filePath of files) {
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size > 2048) continue;
      const text = fs.readFileSync(filePath, 'utf8');
      const port = parseInt(text.split(/\r?\n/)[0].trim(), 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch {}
  }
  return null;
}

export function isEligibleTarget(target) {
  if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || '').trim();
  const title = String(target.title || '').trim();
  if (!url) return false;
  const lowUrl = url.toLowerCase();
  if (
    lowUrl.startsWith('devtools://') ||
    lowUrl.startsWith('data:') ||
    lowUrl.startsWith('about:') ||
    lowUrl.startsWith('chrome:') ||
    lowUrl.startsWith('chrome-extension:') ||
    lowUrl.startsWith('edge:') ||
    lowUrl.startsWith('blob:') ||
    lowUrl.startsWith('plugin:')
  ) {
    return false;
  }
  if (/^(?:untitled|launchpad)$/i.test(title) || /\/launchpad(?:\.html)?(?:[?#]|$)/i.test(lowUrl)) {
    return false;
  }
  if (lowUrl.startsWith('vscode-file://') || lowUrl.startsWith('app://')) return true;
  if (lowUrl.startsWith('file://')) {
    return /workbench|antigravity/i.test(lowUrl) || /\bantigravity\b/i.test(title);
  }
  const m = /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/[^?#]*)?(?:[?#]|$)/i.exec(url);
  if (!m) return false;
  const pathname = (m[3] || '/').toLowerCase();
  if (/^\/(?:viewer(?:\/|$)|sandbox(?:\/|$)|stream(?:\/|$)|api(?:\/|$))/.test(pathname)) {
    return false;
  }
  if (/\bantigravity\b/i.test(title)) return true;
  if (m[1].toLowerCase() === 'https' && (!title || /^127\.0\.0\.1(?::\d+)?/.test(title))) return true;
  return false;
}

export function isTrustedMainFrameBindingCall(entry, executionContextId) {
  if (!entry || typeof executionContextId !== 'number') return false;
  if (!entry.mainFrameId || !(entry.contextFrames instanceof Map)) return false;
  const meta = entry.contextFrames.get(executionContextId);
  if (!meta) return false;
  if (meta.isDefault !== true) return false;
  if (meta.type && meta.type !== 'default') return false;
  if (!meta.frameId || meta.frameId !== entry.mainFrameId) return false;
  return true;
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.onClose = null;

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result || {});
        }
        return;
      }
      if (msg.method && this.listeners.has(msg.method)) {
        for (const cb of this.listeners.get(msg.method)) {
          try {
            cb(msg.params || {});
          } catch {}
        }
      }
    });

    const markClosed = (reason) => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason || 'CDP connection closed'));
      }
      this.pending.clear();
      if (typeof this.onClose === 'function') {
        try {
          this.onClose();
        } catch {}
      }
    };
    ws.addEventListener('close', () => markClosed('CDP connection closed'));
    ws.addEventListener('error', () => markClosed('CDP socket error'));
  }

  static connect(wsUrl, timeoutMs = 3500) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpSession(ws));
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP connect failed'));
        },
        { once: true }
      );
    });
  }

  send(method, params = {}, timeoutMs = 5000) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(callback);
  }

  async evaluate(expression, awaitPromise = false, timeoutMs = 4000, contextId = null) {
    const params = { expression, returnByValue: true, awaitPromise };
    if (typeof contextId === 'number') params.contextId = contextId;
    const res = await this.send('Runtime.evaluate', params, timeoutMs);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result?.value;
  }

  close() {
    if (!this.closed) {
      try {
        this.ws.close();
      } catch {}
    }
  }
}

export async function handleRpcRequest(parsed, opts = {}) {
  const action = String(parsed?.action || '').trim();
  const payload =
    parsed?.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)
      ? parsed.payload
      : parsed && typeof parsed === 'object'
        ? parsed
        : {};
  const storeOpts = opts.storeOpts || {};
  switch (action) {
    case 'list-accounts':
    case 'refresh-cache': {
      const data = await listAccounts(storeOpts);
      return { ok: true, ...data };
    }
    case 'set-label': {
      const accountId = payload.accountId ?? parsed?.accountId;
      const label = payload.label ?? parsed?.label;
      const res = setLabel(accountId, label, storeOpts);
      const data = await listAccounts(storeOpts);
      return { ok: true, updatedId: res.accountId, updatedLabel: res.label, ...data };
    }
    case 'get-config': {
      return { ok: true, config: getConfig(storeOpts) };
    }
    case 'set-config': {
      const patch =
        payload.patch && typeof payload.patch === 'object'
          ? payload.patch
          : payload.config && typeof payload.config === 'object'
            ? payload.config
            : payload;
      const config = setConfig(patch, storeOpts);
      return { ok: true, config };
    }
    case 'switch-account': {
      const accountId = payload.accountId ?? parsed?.accountId;
      const launchOpt =
        payload.launchOnSwitch !== undefined ? payload.launchOnSwitch : parsed?.launchOnSwitch;
      console.error('[account-switcher] switch-account started');
      try {
        const res = await switchAccountNative(accountId, {
          ...storeOpts,
          ...(launchOpt !== undefined ? { launchOnSwitch: Boolean(launchOpt) } : {}),
          ...(opts.switchOpts || {}),
        });
        invalidateCredentialCache();
        const data = await listAccounts({ ...storeOpts, skipCredRead: true });
        console.error(`[account-switcher] switch-account ok (restarted=${Boolean(res.relaunched)})`);
        return {
          ...res,
          switchedId: res.activeId,
          restarted: Boolean(res.relaunched),
          message: res.relaunched
            ? 'Hesap değiştirildi, Antigravity yeniden başlatılıyor...'
            : 'Hesap kimlik bilgileri güncellendi',
          ...data,
        };
      } catch (err) {
        console.error(`[account-switcher] switch-account error: ${redactSecrets(err?.message || err)}`);
        throw err;
      }
    }
    default:
      return { ok: false, error: `Unknown action: ${redactSecrets(action)}` };
  }
}

function defaultPidLockPath() {
  if (process.env.AG_SWITCHER_PID_FILE) return path.resolve(process.env.AG_SWITCHER_PID_FILE);
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'sidecar_data',
    'antigravity-account-switcher',
    'daemon.pid'
  );
}

function isDaemonPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  try {
    process.kill(n, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
  }
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${n}" -ErrorAction SilentlyContinue; if ($p) { "$($p.Name)|$($p.CommandLine)" }`,
        ],
        { windowsHide: true, timeout: 2500, encoding: 'utf8' }
      ).trim().toLowerCase();
      if (!out) return false;
      return (
        out.includes('antigravity-account-switcher') ||
        ((out.includes('node') || out.includes('antigravity')) && out.includes('main.mjs'))
      );
    } catch {
      return false;
    }
  }
  return true;
}

export function acquireSingleInstanceLock(pidFile = defaultPidLockPath()) {
  const resolved = path.resolve(pidFile);
  if (fs.existsSync(resolved)) {
    try {
      const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      if (isDaemonPidAlive(raw?.pid)) {
        return null;
      }
    } catch {}
  }
  atomicWriteFile(
    resolved,
    JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2) + '\n',
    { mode: 0o600 }
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      if (Number(cur?.pid) === process.pid) {
        fs.unlinkSync(resolved);
      }
    } catch {}
  };
}

export class AccountSwitcherDaemon {
  constructor(opts = {}) {
    this.opts = opts;
    this.uiClientPath = opts.uiClientPath || path.join(__dirname, 'ui-client.js');
    this.portFile = opts.portFile || null;
    this.overridePort = opts.port || null;
    this.pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : DEFAULT_POLL_MS;
    this.sessions = new Map();
    this.running = false;
    this._pollTimer = null;
    this._syncInFlight = false;
    this._uiCache = { sig: '', hash: '', code: '' };
    this._inFlightRpcs = new Set();
    this._rpcWaiters = new Set();
    this._lastWatchSig = '';
  }

  _computeWatchFilesSignature() {
    const paths = resolvePaths(this.opts.storeOpts || {});
    const files = [
      paths.sqlitePath,
      `${paths.sqlitePath}-wal`,
      paths.labelsFile,
    ];
    return files
      .map((f) => {
        try {
          const st = fs.statSync(f);
          return `${st.mtimeMs}:${st.size}`;
        } catch {
          return '0';
        }
      })
      .join('|');
  }

  async _pushUpdatesIfFilesChanged() {
    if (!this.running || this.sessions.size === 0) return;
    const nextSig = this._computeWatchFilesSignature();
    if (!this._lastWatchSig) {
      this._lastWatchSig = nextSig;
      return;
    }
    if (nextSig === this._lastWatchSig) return;
    this._lastWatchSig = nextSig;
    try {
      const data = await listAccounts(this.opts.storeOpts || {});
      await this._broadcastAccountUpdate(null, { ok: true, ...data });
    } catch {}
  }

  _notifyRpcWaiters() {
    for (const notify of this._rpcWaiters) {
      try {
        notify();
      } catch {}
    }
  }

  _readUiClientBundle() {
    try {
      const st = fs.statSync(this.uiClientPath);
      if (!st.isFile()) return null;
      const sig = `${st.mtimeMs}:${st.size}`;
      if (this._uiCache.sig === sig && this._uiCache.code) {
        return this._uiCache;
      }
      const code = fs.readFileSync(this.uiClientPath, 'utf8');
      const hash = crypto.createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 16);
      this._uiCache = { sig, hash, code };
      return this._uiCache;
    } catch {
      return null;
    }
  }

  async _ensureMainFrameId(entry) {
    if (!entry || entry.session.closed) return null;
    if (entry.mainFrameId) return entry.mainFrameId;
    const ft = await entry.session.send('Page.getFrameTree', {}, 4000).catch(() => null);
    const frameId = ft?.frameTree?.frame?.id;
    if (typeof frameId === 'string' && frameId) {
      entry.mainFrameId = frameId;
    }
    return entry.mainFrameId;
  }

  _findMainDefaultContextId(entry) {
    if (!entry?.mainFrameId || !(entry.contextFrames instanceof Map)) return null;
    for (const [ctxId, meta] of entry.contextFrames.entries()) {
      if (meta && meta.isDefault === true && (!meta.type || meta.type === 'default') && meta.frameId === entry.mainFrameId) {
        return ctxId;
      }
    }
    return null;
  }

  async _injectIntoEntry(entry) {
    if (!entry || entry.session.closed) return;
    const bundle = this._readUiClientBundle();
    if (!bundle || !bundle.code) return;

    if (entry.scriptHash !== bundle.hash) {
      if (entry.scriptId) {
        await entry.session
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId }, 2500)
          .catch(() => {});
        entry.scriptId = null;
      }
      const added = await entry.session
        .send('Page.addScriptToEvaluateOnNewDocument', { source: bundle.code }, 4000)
        .catch(() => null);
      if (added?.identifier) {
        entry.scriptId = added.identifier;
      }
      entry.scriptHash = bundle.hash;
      entry.injectedDocGen = -1;
    }

    if (entry.injectedDocGen !== entry.docGen || entry.lastEvaluatedHash !== bundle.hash) {
      const ctxId = this._findMainDefaultContextId(entry);
      const isHost = await entry.session
        .evaluate(
          `Boolean(document.body && (document.body.classList.contains('theme-standalone') || document.body.classList.contains('monaco-workbench') || document.querySelector('[data-testid="sidebar-split"], div[role="navigation"][aria-label="Sidebar"], .monaco-workbench')))`,
          false,
          3000,
          ctxId
        )
        .catch(() => false);
      if (!isHost) return;
      entry.rpcCompletedCount = 0;
      await entry.session.evaluate(bundle.code, false, 5000, ctxId).catch(() => {});
      entry.injectedDocGen = entry.docGen;
      entry.lastEvaluatedHash = bundle.hash;
    }
  }

  async _broadcastAccountUpdate(originEntry, payload) {
    const expr = `typeof window.${UPDATE_FN} === 'function' && window.${UPDATE_FN}(${serializeJsonForEval(payload)})`;
    for (const other of this.sessions.values()) {
      if (!other || other === originEntry || other.session.closed) continue;
      const ctxId = this._findMainDefaultContextId(other);
      if (ctxId === null) continue;
      void other.session.evaluate(expr, false, 2500, ctxId).catch(() => {});
    }
  }

  async _handleBindingCall(entry, params) {
    const task = (async () => {
      const { name, payload, executionContextId } = params || {};
      if (name !== BINDING_NAME) return;
      if (!isTrustedMainFrameBindingCall(entry, executionContextId)) {
        if (!entry.mainFrameId) {
          await this._ensureMainFrameId(entry);
        }
        if (!isTrustedMainFrameBindingCall(entry, executionContextId)) return;
      }
      if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD_LEN) return;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const reqId =
        typeof parsed?.id === 'string' && parsed.id.length > 0 && parsed.id.length <= 128
          ? parsed.id
          : Number.isSafeInteger(parsed?.id)
            ? parsed.id
            : null;
      let result;
      try {
        result = await handleRpcRequest(parsed, this.opts);
      } catch (err) {
        result = { ok: false, error: redactSecrets(err?.message || 'Internal error') };
      }

      if (reqId !== null && !entry.session.closed) {
        const safeIdExpr = serializeJsonForEval(reqId);
        const safeJson = serializeJsonForEval(result);
        const resolveExpr = `typeof window.${RESOLVE_FN} === 'function' && window.${RESOLVE_FN}(${safeIdExpr}, ${safeJson})`;
        await entry.session.evaluate(resolveExpr, false, 3500, executionContextId).catch(() => {});
      }
      entry.rpcCompletedCount = (entry.rpcCompletedCount || 0) + 1;

      if (result?.ok && ['set-label', 'set-config', 'switch-account'].includes(parsed?.action)) {
        await this._broadcastAccountUpdate(entry, result);
      }
    })();

    this._inFlightRpcs.add(task);
    this._notifyRpcWaiters();
    try {
      await task;
    } finally {
      this._inFlightRpcs.delete(task);
      this._notifyRpcWaiters();
    }
  }

  async waitForInitialRpcs({ arrivalTimeoutMs = 1500, settleTimeoutMs = 8000 } = {}) {
    const injectedEntries = () =>
      [...this.sessions.values()].filter(
        (e) => e && !e.session.closed && e.injectedDocGen === e.docGen
      );
    const allSettled = () => {
      const entries = injectedEntries();
      if (entries.length === 0) return this._inFlightRpcs.size === 0;
      return this._inFlightRpcs.size === 0 && entries.every((e) => (e.rpcCompletedCount || 0) > 0);
    };

    if (!allSettled()) {
      const startedAt = Date.now();
      await new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          this._rpcWaiters.delete(check);
          resolve();
        };
        const scheduleNext = () => {
          if (timer) clearTimeout(timer);
          const elapsed = Date.now() - startedAt;
          const capMs = this._inFlightRpcs.size > 0 ? settleTimeoutMs : arrivalTimeoutMs;
          const remaining = Math.max(0, capMs - elapsed);
          if (remaining === 0) {
            finish();
            return;
          }
          timer = setTimeout(() => {
            if (this._inFlightRpcs.size > 0 && Date.now() - startedAt < settleTimeoutMs) {
              scheduleNext();
            } else {
              finish();
            }
          }, remaining);
        };
        const check = () => {
          if (allSettled()) {
            finish();
            return;
          }
          scheduleNext();
        };
        this._rpcWaiters.add(check);
        scheduleNext();
      });
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 60);
    });
  }

  async attachTarget(target) {
    const wsUrl = target.webSocketDebuggerUrl;
    if (this.sessions.has(wsUrl)) {
      return this.sessions.get(wsUrl);
    }

    const session = await CdpSession.connect(wsUrl, 3500);
    const entry = {
      wsUrl,
      targetId: target.id,
      title: target.title || target.url || 'Antigravity',
      session,
      mainFrameId: null,
      contextFrames: new Map(),
      docGen: 0,
      injectedDocGen: -1,
      scriptId: null,
      scriptHash: '',
      lastEvaluatedHash: '',
      rpcCompletedCount: 0,
    };
    this.sessions.set(wsUrl, entry);

    session.onClose = () => {
      if (this.sessions.get(wsUrl) === entry) {
        this.sessions.delete(wsUrl);
      }
    };

    try {
      session.on('Runtime.executionContextCreated', (params) => {
        const ctx = params?.context;
        if (!ctx || typeof ctx.id !== 'number') return;
        const aux = ctx.auxData && typeof ctx.auxData === 'object' ? ctx.auxData : {};
        const frameId = typeof aux.frameId === 'string' ? aux.frameId : '';
        const isDefault = aux.isDefault === true;
        const type = typeof aux.type === 'string' && aux.type ? aux.type : isDefault ? 'default' : '';
        entry.contextFrames.set(ctx.id, { frameId, isDefault, type });
      });

      session.on('Runtime.executionContextDestroyed', (params) => {
        if (typeof params?.executionContextId === 'number') {
          entry.contextFrames.delete(params.executionContextId);
        }
      });

      session.on('Runtime.executionContextsCleared', () => {
        entry.contextFrames.clear();
        entry.docGen += 1;
        entry.injectedDocGen = -1;
      });

      session.on('Page.frameNavigated', (params) => {
        const frame = params?.frame;
        if (frame && !frame.parentId && typeof frame.id === 'string' && frame.id) {
          entry.mainFrameId = frame.id;
          entry.docGen += 1;
          entry.injectedDocGen = -1;
        }
      });

      session.on('Page.loadEventFired', () => {
        void this._injectIntoEntry(entry);
      });

      session.on('Runtime.bindingCalled', (params) => {
        void this._handleBindingCall(entry, params);
      });

      await session.send('Page.enable', {}, 4000);
      await this._ensureMainFrameId(entry);
      await session.send('Runtime.enable', {}, 4000);
      await session.send('Runtime.addBinding', { name: BINDING_NAME }, 4000);
      await this._injectIntoEntry(entry);
      console.error(`[account-switcher] attached target: ${redactSecrets(entry.title)}`);
      return entry;
    } catch (err) {
      session.close();
      this.sessions.delete(wsUrl);
      throw err;
    }
  }

  async syncOnce() {
    if (this._syncInFlight) return { attached: 0, port: null };
    this._syncInFlight = true;
    try {
      const port = discoverActivePort(this.overridePort, this.portFile);
      if (!port) return { attached: 0, port: null };

      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2500),
      }).catch(() => null);
      if (!res || !res.ok) return { attached: 0, port };

      const targets = await res.json().catch(() => []);
      if (!Array.isArray(targets)) return { attached: 0, port };

      const eligible = targets.filter(isEligibleTarget);
      let attached = 0;
      for (const target of eligible) {
        try {
          const entry = await this.attachTarget(target);
          if (entry) {
            await this._injectIntoEntry(entry);
            attached += 1;
          }
        } catch {}
      }
      return { attached, port };
    } finally {
      this._syncInFlight = false;
    }
  }

  async start() {
    this.running = true;
    this._lastWatchSig = this._computeWatchFilesSignature();
    console.error(`[account-switcher] daemon started (poll=${this.pollMs}ms)`);
    await this.syncOnce();
    this._pollTimer = setInterval(() => {
      if (!this.running) return;
      void (async () => {
        await this.syncOnce();
        await this._pushUpdatesIfFilesChanged();
      })();
    }, this.pollMs);
  }

  stop() {
    this.running = false;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    for (const entry of this.sessions.values()) {
      entry.session.close();
    }
    this.sessions.clear();
  }
}

async function cliMain() {
  const args = new Set(process.argv.slice(2));
  const once = args.has('--once');
  const releasePid = once ? null : acquireSingleInstanceLock();
  if (!once && !releasePid) {
    process.exit(0);
  }

  const daemon = new AccountSwitcherDaemon();
  const shutdown = () => {
    daemon.stop();
    if (releasePid) releasePid();
  };
  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
  process.on('exit', () => {
    if (releasePid) releasePid();
  });

  if (once) {
    const res = await daemon.syncOnce();
    if (res.attached > 0) {
      await daemon.waitForInitialRpcs();
    }
    daemon.stop();
    console.log(JSON.stringify({ ok: true, mode: 'once', ...res }));
    return;
  }

  await daemon.start();
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  cliMain().catch((err) => {
    console.error(redactSecrets(err?.message || err));
    process.exit(1);
  });
}
