import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_CONFIG = Object.freeze({
  launchOnSwitch: true,
  showQuota: true,
  compactRows: false,
});

const TIER_MAP = new Map([
  ['g1-pro-tier', 'PRO'],
  ['pro-tier', 'PRO'],
  ['g1-ultra-tier', 'ULTRA'],
  ['ultra-tier', 'ULTRA'],
  ['g1-free-tier', 'FREE'],
  ['free-tier', 'FREE'],
  ['standard-tier', 'STANDARD'],
]);

/**
 * Redact emails, JWTs, OAuth tokens, and long secret-like strings before logging or returning errors.
 */
export function redactSecrets(input) {
  let text = String(input ?? '');
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, '[redacted-jwt]');
  text = text.replace(/\b(?:ya29\.[A-Za-z0-9._-]{10,}|1\/\/[A-Za-z0-9._-]{10,}|GOCSPX-[A-Za-z0-9_-]{8,})\b/g, '[redacted-token]');
  return text;
}

/**
 * Resolve all Cockpit Tools and Gemini storage paths with test-friendly overrides.
 */
export function resolvePaths(opts = {}) {
  const home = os.homedir();
  const cockpitDir = path.resolve(opts.cockpitDir || path.join(home, '.cockpit_tools'));
  const geminiDir = path.resolve(opts.geminiDir || path.join(home, '.gemini'));
  const configDir = path.join(geminiDir, 'config');
  return {
    cockpitDir,
    geminiDir,
    sqlitePath: opts.sqlitePath ? path.resolve(opts.sqlitePath) : path.join(cockpitDir, 'antigravity_accounts.sqlite'),
    keyPath: opts.keyPath ? path.resolve(opts.keyPath) : path.join(cockpitDir, 'secure-account-storage.key'),
    accountsDir: opts.accountsDir ? path.resolve(opts.accountsDir) : path.join(cockpitDir, 'accounts'),
    cacheDir: opts.cacheDir
      ? path.resolve(opts.cacheDir)
      : path.join(cockpitDir, 'cache', 'quota_api_v1_desktop', 'authorized'),
    currentAccountPath: opts.currentAccountPath
      ? path.resolve(opts.currentAccountPath)
      : path.join(cockpitDir, 'current_account.json'),
    labelsFile: opts.labelsFile
      ? path.resolve(opts.labelsFile)
      : path.join(configDir, 'antigravity-account-switcher-labels.json'),
    configFile: opts.configFile
      ? path.resolve(opts.configFile)
      : path.join(configDir, 'antigravity-account-switcher-config.json'),
    usageMonitorDataDir: opts.usageMonitorDataDir
      ? path.resolve(opts.usageMonitorDataDir)
      : path.join(geminiDir, 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data'),
  };
}

function isSymlinkSync(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Write a file atomically using temp file + fsync + rename (never creates .bak files).
 */
export function atomicWriteFile(filePath, content, opts = {}) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  const mode = typeof opts.mode === 'number' ? opts.mode : 0o600;
  if (isSymlinkSync(resolved)) {
    throw new Error(`Refusing symbolic link target: ${path.basename(resolved)}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmpName = `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'wx', mode);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.chmodSync(tmpPath, mode);
    } catch {}

    let renamed = false;
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        fs.renameSync(tmpPath, resolved);
        renamed = true;
        break;
      } catch (err) {
        lastErr = err;
        if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES', 'EEXIST'].includes(err?.code)) {
          throw err;
        }
      }
    }
    if (!renamed) {
      if (process.platform === 'win32' && ['EBUSY', 'EPERM', 'EACCES', 'EEXIST'].includes(lastErr?.code)) {
        fs.copyFileSync(tmpPath, resolved);
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      } else {
        throw lastErr;
      }
    }
    try {
      fs.chmodSync(resolved, mode);
    } catch {}
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function normalizeEmailForHash(email) {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * Load the 32-byte AES-256-GCM key from secure-account-storage.key.
 */
export function loadStorageKey(opts = {}) {
  const { keyPath } = resolvePaths(opts);
  if (!fs.existsSync(keyPath)) return null;
  const raw = fs.readFileSync(keyPath, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`Invalid secure-account-storage.key length: expected 32 bytes, got ${key.length}`);
  }
  return key;
}

/**
 * Decrypt a SecureAccountEnvelope (AES-256-GCM with 16-byte trailing tag) or legacy plaintext JSON.
 */
export function decryptAccountEnvelope(rawOrObj, keyBuf) {
  const obj = typeof rawOrObj === 'string' ? JSON.parse(rawOrObj) : rawOrObj;
  if (!obj || typeof obj !== 'object') {
    throw new Error('Invalid account record format');
  }
  if (obj.ciphertext && obj.nonce && obj.algorithm === 'AES-256-GCM') {
    if (!keyBuf || keyBuf.length !== 32) {
      throw new Error('Missing 32-byte decryption key for SecureAccountEnvelope');
    }
    const nonce = Buffer.from(obj.nonce, 'base64');
    const combined = Buffer.from(obj.ciphertext, 'base64');
    if (nonce.length !== 12 || combined.length < 16) {
      throw new Error('Corrupt SecureAccountEnvelope nonce or ciphertext');
    }
    const enc = combined.subarray(0, combined.length - 16);
    const tag = combined.subarray(combined.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  }
  // Legacy plaintext fallback
  if (obj.token || obj.email || obj.id) {
    return obj;
  }
  throw new Error('Unsupported account record envelope');
}

/**
 * Encrypt an account JSON object into Cockpit Tools SecureAccountEnvelope format.
 */
export function encryptAccountEnvelope(accountObj, keyBuf, nowSec = Math.floor(Date.now() / 1000)) {
  if (!keyBuf || keyBuf.length !== 32) {
    throw new Error('Missing 32-byte encryption key for SecureAccountEnvelope');
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, nonce);
  const plaintext = Buffer.from(JSON.stringify(accountObj), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([enc, tag]);
  return {
    version: 1,
    kind: 'antigravity',
    algorithm: 'AES-256-GCM',
    key_id: 'local-secure-account-storage-v1',
    nonce: nonce.toString('base64'),
    ciphertext: combined.toString('base64'),
    encrypted_at: Math.floor(Number(nowSec) || Date.now() / 1000),
  };
}

function assertSafeAccountId(accountId) {
  const id = String(accountId ?? '').trim();
  if (!id || id.length > 128 || /[/\\]|\.\./.test(id)) {
    throw new Error('Invalid accountId');
  }
  return id;
}

export function readAccountRecord(accountId, opts = {}) {
  const safeId = assertSafeAccountId(accountId);
  const paths = resolvePaths(opts);
  const filePath = path.join(paths.accountsDir, `${safeId}.json`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const isEncrypted = Boolean(parsed?.ciphertext && parsed?.algorithm === 'AES-256-GCM');
  const keyBuf = isEncrypted ? loadStorageKey(opts) : null;
  return {
    account: decryptAccountEnvelope(parsed, keyBuf),
    wasEncrypted: isEncrypted,
    filePath,
  };
}

export function writeAccountRecord(accountId, accountObj, opts = {}) {
  const safeId = assertSafeAccountId(accountId);
  const paths = resolvePaths(opts);
  const filePath = path.join(paths.accountsDir, `${safeId}.json`);
  const keyBuf = loadStorageKey(opts);
  let serialized;
  if (keyBuf) {
    const envelope = encryptAccountEnvelope(accountObj, keyBuf, opts.nowSec);
    serialized = JSON.stringify(envelope, null, 2);
  } else if (opts.allowPlaintext) {
    serialized = JSON.stringify(accountObj, null, 2);
  } else {
    throw new Error('Cannot write encrypted account file without secure-account-storage.key');
  }
  atomicWriteFile(filePath, serialized, { mode: 0o600 });
}

function readJsonObjectSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getConfig(opts = {}) {
  const { configFile } = resolvePaths(opts);
  const raw = readJsonObjectSafe(configFile);
  return {
    launchOnSwitch: typeof raw.launchOnSwitch === 'boolean' ? raw.launchOnSwitch : DEFAULT_CONFIG.launchOnSwitch,
    showQuota: typeof raw.showQuota === 'boolean' ? raw.showQuota : DEFAULT_CONFIG.showQuota,
    compactRows: typeof raw.compactRows === 'boolean' ? raw.compactRows : DEFAULT_CONFIG.compactRows,
  };
}

export function setConfig(patch = {}, opts = {}) {
  const { configFile } = resolvePaths(opts);
  const current = getConfig(opts);
  const src = patch && typeof patch === 'object' ? patch : {};
  const next = {
    launchOnSwitch: typeof src.launchOnSwitch === 'boolean' ? src.launchOnSwitch : current.launchOnSwitch,
    showQuota: typeof src.showQuota === 'boolean' ? src.showQuota : current.showQuota,
    compactRows: typeof src.compactRows === 'boolean' ? src.compactRows : current.compactRows,
  };
  atomicWriteFile(configFile, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

export function getLabels(opts = {}) {
  const { labelsFile } = resolvePaths(opts);
  const raw = readJsonObjectSafe(labelsFile);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === 'string' && typeof v === 'string') {
      const clean = v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
      if (clean) out[k] = clean;
    }
  }
  return out;
}

export function setLabel(accountId, label, opts = {}) {
  const safeId = assertSafeAccountId(accountId);
  const { labelsFile } = resolvePaths(opts);
  const labels = getLabels(opts);
  const cleaned = String(label ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  if (!cleaned) {
    delete labels[safeId];
  } else {
    labels[safeId] = cleaned;
  }
  atomicWriteFile(labelsFile, JSON.stringify(labels, null, 2) + '\n', { mode: 0o600 });
  return { accountId: safeId, label: cleaned || null, labels };
}

/**
 * Format an ISO resetTime timestamp or epoch ms into a clean compact countdown string (e.g. "4h 32m", "6d 23h").
 */
export function formatResetTime(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const targetMs =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  if (!Number.isFinite(targetMs)) return null;
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return '0m';
  const totalMins = Math.floor(diffMs / 60000);
  if (totalMins < 1) return '<1m';
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

function toQuotaPercentFromFraction(rawFraction) {
  if (typeof rawFraction !== 'number' || !Number.isFinite(rawFraction)) return null;
  const scaled = rawFraction <= 1 ? rawFraction * 100 : rawFraction;
  return Math.max(0, Math.min(100, Math.floor(scaled + 1e-6)));
}

function toQuotaPercentFromPct(rawPct) {
  if (typeof rawPct !== 'number' || !Number.isFinite(rawPct)) return null;
  return Math.max(0, Math.min(100, Math.floor(rawPct + 1e-6)));
}

function findBucket(buckets, windowKey) {
  if (!Array.isArray(buckets)) return null;
  return (
    buckets.find((b) => b && (b.window === windowKey || String(b.bucketId || '').endsWith(`-${windowKey}`))) ||
    null
  );
}

/**
 * Read cached quota percentages & reset timers from quota_api_v1_desktop/authorized/<sha256(email)>.json.
 */
export function parseQuotaFromCache(email, opts = {}) {
  const empty = { quota5h: null, quotaWeekly: null, reset5h: null, resetWeekly: null, updatedAtMs: 0 };
  const normalized = normalizeEmailForHash(email);
  if (!normalized) return empty;
  const { cacheDir } = resolvePaths(opts);
  const cachePath = path.join(cacheDir, `${sha256Hex(normalized)}.json`);
  if (!fs.existsSync(cachePath)) return empty;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return empty;
  }

  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const rawUpdated = Number(data?.updatedAt) || 0;
  const updatedAtMs = rawUpdated > 0 ? (rawUpdated < 1e12 ? rawUpdated * 1000 : rawUpdated) : 0;
  const qs = data?.payload?.quota_summary || data?.quota_summary || null;
  if (!qs) return empty;

  const groups = qs.groups;
  let bucket5h = null;
  let bucketWeekly = null;

  if (Array.isArray(groups)) {
    const preferredGroup =
      groups.find((g) => /gemini/i.test(String(g?.displayName || ''))) ||
      groups.find((g) => Array.isArray(g?.buckets) && g.buckets.length > 0) ||
      null;
    if (preferredGroup) {
      bucket5h = findBucket(preferredGroup.buckets, '5h');
      bucketWeekly = findBucket(preferredGroup.buckets, 'weekly');
    }
    if (!bucket5h || !bucketWeekly) {
      for (const g of groups) {
        if (!bucket5h) bucket5h = findBucket(g?.buckets, '5h');
        if (!bucketWeekly) bucketWeekly = findBucket(g?.buckets, 'weekly');
      }
    }
  } else if (groups && typeof groups === 'object') {
    bucket5h = groups['5h'] || groups.fiveHour || null;
    bucketWeekly = groups.weekly || null;
  }

  return {
    quota5h: toQuotaPercentFromFraction(bucket5h?.remainingFraction),
    quotaWeekly: toQuotaPercentFromFraction(bucketWeekly?.remainingFraction),
    reset5h: formatResetTime(bucket5h?.resetTime, nowMs),
    resetWeekly: formatResetTime(bucketWeekly?.resetTime, nowMs),
    updatedAtMs,
  };
}

function readUsageMonitorHistory(usageMonitorDataDir) {
  const map = new Map();
  try {
    const histPath = path.join(usageMonitorDataDir, 'account_quota_history.json');
    if (!fs.existsSync(histPath)) return map;
    const raw = JSON.parse(fs.readFileSync(histPath, 'utf8'));
    const accounts = raw?.accounts;
    if (!accounts || typeof accounts !== 'object') return map;
    for (const [emailKey, entry] of Object.entries(accounts)) {
      const norm = normalizeEmailForHash(emailKey);
      if (norm && entry && typeof entry === 'object') {
        map.set(norm, entry);
      }
    }
  } catch {}
  return map;
}

function parseQuotaFromUsageHistory(historyEntry, nowMs = Date.now()) {
  if (!historyEntry || typeof historyEntry !== 'object') return null;
  const pools = historyEntry.pools;
  if (!pools || typeof pools !== 'object') return null;
  const geminiPool =
    pools.Gemini ||
    Object.values(pools).find((p) => p && Array.isArray(p.points) && p.points.length > 0) ||
    null;
  if (!geminiPool || !Array.isArray(geminiPool.points) || geminiPool.points.length === 0) {
    return null;
  }
  const latest = geminiPool.points[geminiPool.points.length - 1];
  if (!Array.isArray(latest) || latest.length < 2) return null;
  const tsMs = Number(latest[0]) || Number(historyEntry.updatedAtMs) || 0;
  return {
    quota5h: toQuotaPercentFromPct(latest[1]),
    quotaWeekly: latest.length >= 3 ? toQuotaPercentFromPct(latest[2]) : null,
    reset5h: formatResetTime(geminiPool.reset5hMs, nowMs),
    resetWeekly: formatResetTime(geminiPool.resetWeeklyMs, nowMs),
    updatedAtMs: tsMs,
  };
}

function readCliStatusSnapshot(usageMonitorDataDir) {
  try {
    const snapPath = path.join(usageMonitorDataDir, 'cli-status-snapshot.json');
    if (!fs.existsSync(snapPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function formatTier(rawTier) {
  if (!rawTier || typeof rawTier !== 'string') return null;
  const low = rawTier.trim().toLowerCase();
  if (!low) return null;
  if (TIER_MAP.has(low)) return TIER_MAP.get(low);
  return low.replace(/^g1-/, '').replace(/-tier$/, '').toUpperCase() || null;
}

function extractEmailFromJwt(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(payloadJson);
    return typeof parsed?.email === 'string' ? parsed.email : null;
  } catch {
    return null;
  }
}

const CRED_CACHE_TTL_MS = 5000;
const _credCache = new Map();

export function invalidateCredentialCache(targetName = null) {
  if (targetName) {
    _credCache.delete(String(targetName));
  } else {
    _credCache.clear();
  }
}

/**
 * Read Windows Credential Manager entry (default "gemini:antigravity") safely via PowerShell -EncodedCommand.
 * Never returns secrets outside memory comparison.
 */
export function readWindowsCredential(opts = {}) {
  if (typeof opts.readCredFn === 'function') {
    return Promise.resolve().then(() => opts.readCredFn());
  }
  if (opts.skipCredRead || process.platform !== 'win32') {
    return Promise.resolve(null);
  }
  const targetName = String(opts.targetName || 'gemini:antigravity');
  const nowMs = Date.now();
  if (!opts.noCache) {
    const cached = _credCache.get(targetName);
    if (cached && cached.expiresAt > nowMs) {
      return Promise.resolve(cached.value);
    }
  }

  const escapedTarget = targetName.replace(/'/g, "''");
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AgCredReader {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);

    public static string ReadTarget(string target) {
        IntPtr ptr;
        if (!CredReadW(target, 1, 0, out ptr)) return "";
        try {
            var cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);
            if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return "";
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, (int)cred.CredentialBlobSize);
            return Encoding.UTF8.GetString(bytes);
        } finally {
            CredFree(ptr);
        }
    }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[AgCredReader]::ReadTarget('${escapedTarget}')
`;
  const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCmd],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        const trimmed = String(stdout).trim();
        if (!trimmed) {
          if (!opts.noCache) {
            _credCache.set(targetName, { value: null, expiresAt: Date.now() + CRED_CACHE_TTL_MS });
          }
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(trimmed);
          if (!opts.noCache) {
            _credCache.set(targetName, { value: parsed, expiresAt: Date.now() + CRED_CACHE_TTL_MS });
          }
          resolve(parsed);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function readSqliteSummaries(sqlitePath) {
  if (!fs.existsSync(sqlitePath)) {
    return { rows: [], indexCurrentId: null };
  }
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT source, position, account_id, email, created_at, last_used, plan_type
         FROM summaries
         ORDER BY source ASC, position ASC`
      )
      .all();
    let indexCurrentId = null;
    try {
      const stRow = db
        .prepare('SELECT state FROM account_index_state WHERE singleton = 1')
        .get();
      if (stRow?.state) {
        const parsedState = JSON.parse(stRow.state);
        if (typeof parsedState?.current_id === 'string' && parsedState.current_id) {
          indexCurrentId = parsedState.current_id;
        }
      }
    } catch {}
    return { rows, indexCurrentId };
  } finally {
    db.close();
  }
}

/**
 * List sanitized account objects for UI rendering.
 * Never returns email addresses, tokens, or decryption keys.
 */
export async function listAccounts(opts = {}) {
  const paths = resolvePaths(opts);
  const labels = getLabels(opts);
  const config = getConfig(opts);
  const { rows, indexCurrentId } = readSqliteSummaries(paths.sqlitePath);

  let keyBuf = null;
  try {
    keyBuf = loadStorageKey(opts);
  } catch {
    keyBuf = null;
  }

  let credRefreshHash = null;
  let credEmailHash = null;
  try {
    const cred = await readWindowsCredential(opts);
    if (cred && typeof cred === 'object') {
      const rt = cred?.token?.refresh_token;
      if (typeof rt === 'string' && rt.length > 0) {
        credRefreshHash = sha256Hex(rt);
      }
      const rawCredEmail =
        cred.id_token_email ||
        extractEmailFromJwt(cred.id_token) ||
        extractEmailFromJwt(cred?.token?.id_token) ||
        '';
      const normCredEmail = normalizeEmailForHash(rawCredEmail);
      if (normCredEmail) {
        credEmailHash = sha256Hex(normCredEmail);
      }
    }
  } catch {}

  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const usageHistoryMap = readUsageMonitorHistory(paths.usageMonitorDataDir);
  const cliSnapshot = readCliStatusSnapshot(paths.usageMonitorDataDir);

  let matchedActiveId = null;
  const lastSwitchedById = new Map();
  const intermediate = rows.map((row, idx) => {
    const id = String(row.account_id);
    const normEmail = normalizeEmailForHash(row.email);
    const emailPrefix = String(row.email || '').trim().split('@')[0].trim();
    const defaultLabel = emailPrefix || `Hesap ${idx + 1}`;
    const customLabel = labels[id] || '';
    const emailHash = sha256Hex(normEmail);
    const cacheQuota = parseQuotaFromCache(row.email, opts);
    const histQuota = parseQuotaFromUsageHistory(usageHistoryMap.get(normEmail), nowMs);

    const useHist =
      histQuota &&
      histQuota.quota5h !== null &&
      (histQuota.updatedAtMs >= cacheQuota.updatedAtMs || cacheQuota.quota5h === null);

    const quota5h = useHist ? histQuota.quota5h : cacheQuota.quota5h;
    const quotaWeekly = useHist
      ? histQuota.quotaWeekly ?? cacheQuota.quotaWeekly
      : cacheQuota.quotaWeekly ?? histQuota?.quotaWeekly ?? null;
    const reset5h = useHist
      ? histQuota.reset5h ?? cacheQuota.reset5h
      : cacheQuota.reset5h ?? histQuota?.reset5h ?? null;
    const resetWeekly = useHist
      ? histQuota.resetWeekly ?? cacheQuota.resetWeekly
      : cacheQuota.resetWeekly ?? histQuota?.resetWeekly ?? null;

    let disabled = false;
    let tier = formatTier(row.plan_type);
    let lastUsed = Number.isFinite(Number(row.last_used)) ? Number(row.last_used) : null;

    const accPath = path.join(paths.accountsDir, `${id}.json`);
    if (fs.existsSync(accPath)) {
      try {
        const rawEnv = JSON.parse(fs.readFileSync(accPath, 'utf8'));
        const dec = decryptAccountEnvelope(rawEnv, keyBuf);
        if (typeof dec.disabled === 'boolean') disabled = dec.disabled;
        const decTier = formatTier(dec?.quota?.subscription_tier || dec?.quota?.tier_id);
        if (decTier) tier = decTier;
        if (Number.isFinite(Number(dec.last_used)) && Number(dec.last_used) > 0) {
          lastUsed = Number(dec.last_used);
        }
        if (Number.isFinite(Number(dec.last_switched_at)) && Number(dec.last_switched_at) > 0) {
          lastSwitchedById.set(id, Number(dec.last_switched_at));
        }
        const accRt = dec?.token?.refresh_token;
        if (!matchedActiveId && credRefreshHash && typeof accRt === 'string' && accRt.length > 0) {
          if (sha256Hex(accRt) === credRefreshHash) {
            matchedActiveId = id;
          }
        }
      } catch {
        // Ignore decrypt error for individual item so UI stays resilient
      }
    }

    if (!matchedActiveId && credEmailHash && emailHash === credEmailHash) {
      matchedActiveId = id;
    }

    return {
      id,
      label: customLabel || defaultLabel,
      defaultLabel,
      hasCustomLabel: Boolean(customLabel),
      isCurrent: false,
      disabled,
      tier,
      quota5h,
      quotaWeekly,
      reset5h,
      resetWeekly,
      lastUsed,
    };
  });

  const activeId = matchedActiveId || indexCurrentId || (intermediate[0]?.id ?? null);
  const activeLastSwitchedAt = activeId ? lastSwitchedById.get(activeId) || 0 : 0;
  const snapUpdatedMs = Number(cliSnapshot?.updatedAtMs) || 0;
  const snapActivePool = cliSnapshot?.quotas?.activePool || null;
  const snapOfficialOk = cliSnapshot?.quotas?.meta?.hasOfficialData !== false;
  const snapIsFresh =
    Boolean(snapActivePool) &&
    snapOfficialOk &&
    snapUpdatedMs > 0 &&
    nowMs - snapUpdatedMs <= 30 * 60 * 1000 &&
    snapUpdatedMs >= activeLastSwitchedAt * 1000;

  const accounts = intermediate.map((item) => {
    const isCurrent = Boolean(activeId && item.id === activeId);
    if (!isCurrent || !snapIsFresh) {
      return { ...item, isCurrent };
    }
    const live5h =
      typeof snapActivePool.remainingPct === 'number' && Number.isFinite(snapActivePool.remainingPct)
        ? Math.max(0, Math.min(100, Math.round(snapActivePool.remainingPct)))
        : typeof snapActivePool.remainingIntPct === 'number'
          ? Math.max(0, Math.min(100, Math.floor(snapActivePool.remainingIntPct)))
          : toQuotaPercentFromPct(snapActivePool.remainingPct);
    const liveWeeklyRaw =
      typeof snapActivePool.weeklyRemainingPct === 'number' && Number.isFinite(snapActivePool.weeklyRemainingPct)
        ? snapActivePool.weeklyRemainingPct
        : typeof cliSnapshot?.quotas?.weekly?.remainingPct === 'number' &&
            Number.isFinite(cliSnapshot.quotas.weekly.remainingPct)
          ? cliSnapshot.quotas.weekly.remainingPct
          : null;
    const liveWeekly =
      liveWeeklyRaw !== null
        ? Math.max(0, Math.min(100, Math.round(liveWeeklyRaw)))
        : typeof snapActivePool.weeklyRemainingIntPct === 'number'
          ? Math.max(0, Math.min(100, Math.floor(snapActivePool.weeklyRemainingIntPct)))
          : typeof cliSnapshot?.quotas?.weekly?.remainingIntPct === 'number'
            ? Math.max(0, Math.min(100, Math.floor(cliSnapshot.quotas.weekly.remainingIntPct)))
            : toQuotaPercentFromPct(snapActivePool.weeklyRemainingPct);
    const liveReset5h = formatResetTime(snapActivePool.resetTime, nowMs);
    const liveResetWeekly = formatResetTime(
      snapActivePool.weeklyResetTime || cliSnapshot?.quotas?.weekly?.resetTime,
      nowMs
    );
    return {
      ...item,
      isCurrent,
      quota5h: live5h ?? item.quota5h,
      quotaWeekly: liveWeekly ?? item.quotaWeekly,
      reset5h: liveReset5h ?? item.reset5h,
      resetWeekly: liveResetWeekly ?? item.resetWeekly,
    };
  });

  return {
    accounts,
    activeId,
    config,
  };
}
