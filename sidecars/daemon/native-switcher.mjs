import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  atomicWriteFile,
  invalidateCredentialCache,
  readAccountRecord,
  redactSecrets,
  resolvePaths,
  writeAccountRecord,
} from './cockpit-store.mjs';

const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const OAUTH_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');
const OAUTH_USER_AGENT = 'vscode/1.X.X (Antigravity/4.3.0)';
const TOKEN_REFRESH_SKEW_SEC = 900;
const MAX_CREDENTIAL_BYTES = 2560;

let switchInFlight = false;

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

function assertSafeId(accountId) {
  const id = String(accountId ?? '').trim();
  if (!id || id.length > 128 || /[/\\]|\.\./.test(id)) {
    throw new Error('Invalid accountId');
  }
  return id;
}

/**
 * Format unix timestamp (seconds) as UTC RFC3339 with microseconds and trailing Z.
 */
export function formatUtcRfc3339Micros(unixSec) {
  const ms = Math.floor(Number(unixSec)) * 1000;
  const iso = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
  return iso.replace(/\.(\d{3})Z$/, '.$1000Z');
}

/**
 * Acquire a lock file respecting Cockpit Tools 0-byte advisory locks and non-empty lock files,
 * with bounded timeout so it never hangs forever.
 */
async function acquireFileLock(lockPath, opts = {}) {
  const timeoutMs = Number.isFinite(opts.lockTimeoutMs) ? opts.lockTimeoutMs : 4000;
  const staleMs = Number.isFinite(opts.staleLockMs) ? opts.staleLockMs : 15000;
  const sleepFn = opts.sleepFn || defaultSleep;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    let createdByUs = false;
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      createdByUs = true;
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        if (createdByUs) {
          try {
            fs.unlinkSync(lockPath);
          } catch {}
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }

    // Existing lock file: distinguish 0-byte Cockpit Tools OS lock vs non-empty lock
    try {
      const st = fs.statSync(lockPath);
      if (st.size === 0) {
        let osLocked = false;
        let probeFd = null;
        try {
          probeFd = fs.openSync(lockPath, 'r+');
          const probeBuf = Buffer.alloc(1);
          fs.readSync(probeFd, probeBuf, 0, 1, 0);
        } catch (probeErr) {
          if (['EBUSY', 'EACCES', 'EAGAIN', 'UNKNOWN'].includes(probeErr?.code)) {
            osLocked = true;
          }
        } finally {
          if (probeFd !== null) {
            try {
              fs.closeSync(probeFd);
            } catch {}
          }
        }
        if (!osLocked) {
          // Idle 0-byte Cockpit Tools lock file; do not unlink it
          return () => {};
        }
      } else if (Date.now() - st.mtimeMs > staleMs) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {}
      }
    } catch (statErr) {
      if (statErr?.code === 'ENOENT') continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`LOCK_TIMEOUT: ${path.basename(lockPath)} is busy`);
    }
    await sleepFn(80);
  }
}

async function refreshOAuthToken(refreshToken, opts = {}) {
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const sleepFn = opts.sleepFn || defaultSleep;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is unavailable for OAuth refresh');
  }

  const doRequest = async () => {
    const body = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetchFn(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': OAUTH_USER_AGENT,
      },
      body: body.toString(),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { ok: res.ok, status: res.status, parsed, text };
  };

  let attempt = await doRequest();
  const isInvalidGrant =
    !attempt.ok &&
    (attempt.parsed?.error === 'invalid_grant' || /invalid_grant/i.test(attempt.text || ''));
  if (isInvalidGrant) {
    await sleepFn(500);
    attempt = await doRequest();
  }

  if (!attempt.ok || !attempt.parsed?.access_token) {
    const errCode = attempt.parsed?.error || `HTTP_${attempt.status}`;
    throw new Error(`OAuth token refresh failed (${redactSecrets(errCode)})`);
  }
  return attempt.parsed;
}

/**
 * Write payload JSON into Windows Credential Manager via PowerShell -EncodedCommand + stdin base64 payload.
 * Secrets are passed exclusively on stdin so nothing appears in process command lines or temp files.
 */
export function writeWindowsCredential(payloadJson, targetName = 'gemini:antigravity') {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Windows Credential Manager is only supported on win32'));
  }
  const safeTarget = String(targetName || 'gemini:antigravity').trim();
  if (!safeTarget) {
    return Promise.reject(new Error('Credential targetName is required'));
  }
  const escapedTarget = safeTarget.replace(/'/g, "''");
  const b64Payload = Buffer.from(payloadJson, 'utf8').toString('base64');
  const psScript = `
$ErrorActionPreference = 'Stop'
$b64 = [Console]::In.ReadLine()
if ([string]::IsNullOrWhiteSpace($b64)) { throw 'Empty credential payload' }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AgCredWriter {
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
    public static extern bool CredWriteW(ref CREDENTIAL userCredential, uint flags);

    public static void WriteTarget(string target, string user, byte[] blob) {
        IntPtr ptr = Marshal.AllocHGlobal(blob.Length);
        try {
            Marshal.Copy(blob, 0, ptr, blob.Length);
            var cred = new CREDENTIAL {
                Flags = 0,
                Type = 1,
                TargetName = target,
                Comment = null,
                CredentialBlobSize = (uint)blob.Length,
                CredentialBlob = ptr,
                Persist = 2,
                AttributeCount = 0,
                Attributes = IntPtr.Zero,
                TargetAlias = null,
                UserName = user
            };
            if (!CredWriteW(ref cred, 0)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        } finally {
            Marshal.FreeHGlobal(ptr);
        }
    }
}
"@
$bytes = [Convert]::FromBase64String($b64.Trim())
[AgCredWriter]::WriteTarget('${escapedTarget}', 'antigravity', $bytes)
`;
  const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');

  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCmd],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`CredWriteW failed: ${redactSecrets(stderr || err.message)}`));
          return;
        }
        resolve();
      }
    );
    try {
      child.stdin.end(b64Payload + '\n', 'utf8');
    } catch (writeErr) {
      reject(writeErr);
    }
  });
}

/**
 * Delete a test credential from Windows Credential Manager.
 * Strictly refuses deleting the live 'gemini:antigravity' target.
 */
export function deleteWindowsCredential(targetName) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Windows Credential Manager is only supported on win32'));
  }
  const safeTarget = String(targetName ?? '').trim();
  if (!safeTarget || safeTarget.toLowerCase() === 'gemini:antigravity') {
    return Promise.reject(new Error('Refusing to delete live gemini:antigravity credential'));
  }
  const escapedTarget = safeTarget.replace(/'/g, "''");
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AgCredDeleter {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredDeleteW(string target, uint type, uint flags);
}
"@
$null = [AgCredDeleter]::CredDeleteW('${escapedTarget}', 1, 0)
`;
  const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCmd],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`CredDeleteW failed: ${redactSecrets(stderr || err.message)}`));
          return;
        }
        resolve(true);
      }
    );
  });
}

function resolveDefaultAntigravityExe() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const upper = path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe');
  if (fs.existsSync(upper)) return upper;
  return path.join(localAppData, 'Programs', 'antigravity', 'Antigravity.exe');
}

function assertSafeTaskName(taskName) {
  const safe = String(taskName || '').trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(safe)) {
    throw new Error('Invalid scheduled task name');
  }
  return safe;
}

/**
 * Launch a PowerShell script completely outside Antigravity's Windows Job Object
 * (which sets KILL_ON_JOB_CLOSE without BREAKAWAY_OK) via Task Scheduler COM.
 * Runs in the user's interactive desktop session with zero UAC prompt.
 */
export function launchOutOfJobPowerShell(psScript, opts = {}) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Task Scheduler COM is only supported on win32'));
  }
  const taskName = assertSafeTaskName(opts.taskName || 'AntigravityAccountSwitcherHelper');
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10000;
  const innerEncoded = Buffer.from(String(psScript), 'utf16le').toString('base64');
  const escapedTask = taskName.replace(/'/g, "''");
  const psExe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const escapedPsExe = psExe.replace(/'/g, "''");

  const registerScript = `
$ErrorActionPreference = 'Stop'
$ts = New-Object -ComObject Schedule.Service
$ts.Connect()
$root = $ts.GetFolder('\\')
$td = $ts.NewTask(0)
$td.RegistrationInfo.Description = 'Antigravity Account Switcher Out-Of-Job Helper'
$td.Principal.LogonType = 3
$td.Principal.RunLevel = 0
$td.Settings.Enabled = $true
$td.Settings.Hidden = $true
$td.Settings.AllowDemandStart = $true
$td.Settings.MultipleInstances = 2
$td.Settings.ExecutionTimeLimit = 'PT2M'
$td.Settings.DisallowStartIfOnBatteries = $false
$td.Settings.StopIfGoingOnBatteries = $false
$action = $td.Actions.Create(0)
$action.Path = '${escapedPsExe}'
$action.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${innerEncoded}'
$reg = $root.RegisterTaskDefinition('${escapedTask}', $td, 6, $null, $null, 3, $null)
$null = $reg.Run($null)
`;
  const registerEncoded = Buffer.from(registerScript, 'utf16le').toString('base64');

  return new Promise((resolve, reject) => {
    execFile(
      psExe,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', registerEncoded],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 65536 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`Task Scheduler launch failed: ${redactSecrets(stderr || err.message)}`));
          return;
        }
        resolve(true);
      }
    );
  });
}

async function spawnDetachedRelaunch(antigravityExe) {
  if (process.platform !== 'win32') return false;
  const fallbackExe = path.resolve(antigravityExe || resolveDefaultAntigravityExe());
  const escapedFallback = fallbackExe.replace(/'/g, "''");
  const taskName = 'AntigravityAccountSwitcherRelaunch';
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
try {
  $tsClean = New-Object -ComObject Schedule.Service
  $tsClean.Connect()
  $tsClean.GetFolder('\\').DeleteTask('${taskName}', 0)
} catch {}
Start-Sleep -Milliseconds 600
$exePath = '${escapedFallback}'
$procs = @(Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue)
foreach ($p in $procs) {
  try {
    if ($p.Path -and (Test-Path -LiteralPath $p.Path)) {
      $exePath = $p.Path
      break
    }
  } catch {}
}
foreach ($p in $procs) {
  try { $null = $p.CloseMainWindow() } catch {}
}
$deadline = (Get-Date).AddMilliseconds(2500)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 150
}
Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$langProcs = Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%'" -ErrorAction SilentlyContinue
foreach ($lp in $langProcs) {
  $cmd = [string]$lp.CommandLine
  $ep = [string]$lp.ExecutablePath
  if ($cmd -match 'antigravity' -or $ep -match 'antigravity') {
    Stop-Process -Id $lp.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
$waitExit = (Get-Date).AddMilliseconds(8000)
while ((Get-Date) -lt $waitExit) {
  if (-not (Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 150
}
Start-Sleep -Milliseconds 400
if (Test-Path -LiteralPath $exePath) {
  Start-Process -FilePath $exePath | Out-Null
}
`;
  await launchOutOfJobPowerShell(psScript, { taskName });
  return true;
}

function updateSqliteCurrentAccount(sqlitePath, accountId, nowSec) {
  if (!fs.existsSync(sqlitePath)) return;
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const stRow = db.prepare('SELECT state FROM account_index_state WHERE singleton = 1').get();
    let stateObj = { source: 0, version: 1, current_id: accountId };
    if (stRow?.state) {
      try {
        stateObj = { ...JSON.parse(stRow.state), current_id: accountId };
      } catch {}
    }
    db.prepare(
      `INSERT INTO account_index_state (singleton, state) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET state = excluded.state`
    ).run(JSON.stringify(stateObj));
    db.prepare('UPDATE summaries SET last_used = ? WHERE account_id = ?').run(nowSec, accountId);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    db.close();
  }
}

/**
 * Switch the active Antigravity account natively via Cockpit Tools storage & Windows Credential Manager.
 */
export async function switchAccountNative(accountId, opts = {}) {
  if (switchInFlight) {
    throw new Error('ANTIGRAVITY_SWITCH_BUSY');
  }
  switchInFlight = true;

  let releaseIndexLock = null;
  let releaseAccountLock = null;
  try {
    const safeId = assertSafeId(accountId);
    const paths = resolvePaths(opts);
    const nowMs = typeof opts.nowFn === 'function' ? opts.nowFn() : Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    const indexLockPath = path.join(paths.cockpitDir, 'antigravity_account_index.lock');
    const accountLockPath = path.join(paths.accountsDir, `${safeId}.json.lock`);
    releaseIndexLock = await acquireFileLock(indexLockPath, opts);
    releaseAccountLock = await acquireFileLock(accountLockPath, opts);

    const { account } = readAccountRecord(safeId, opts);
    if (!account || typeof account !== 'object' || !account.token) {
      throw new Error('Target account record is missing OAuth token');
    }
    if (account.disabled) {
      throw new Error('Target account is disabled');
    }

    const token = { ...account.token };
    let expiryTs = Number(token.expiry_timestamp) || 0;
    if (expiryTs <= nowSec + TOKEN_REFRESH_SKEW_SEC) {
      if (!token.refresh_token) {
        throw new Error('Target account has no refresh_token');
      }
      const refreshed = await refreshOAuthToken(token.refresh_token, opts);
      const expiresIn = Number(refreshed.expires_in) || 3600;
      expiryTs = nowSec + expiresIn;
      token.access_token = refreshed.access_token;
      token.expires_in = expiresIn;
      token.expiry_timestamp = expiryTs;
      token.token_type = refreshed.token_type || token.token_type || 'Bearer';
      if (refreshed.refresh_token) token.refresh_token = refreshed.refresh_token;
      if (refreshed.id_token) token.id_token = refreshed.id_token;
      account.token = token;
      writeAccountRecord(safeId, account, { ...opts, nowSec });
    }

    if (!token.access_token || !token.refresh_token) {
      throw new Error('Incomplete OAuth token after refresh');
    }

    const credPayload = {
      token: {
        access_token: token.access_token,
        token_type: 'Bearer',
        refresh_token: token.refresh_token,
        expiry: formatUtcRfc3339Micros(expiryTs || nowSec + 3600),
      },
      auth_method: 'consumer',
      ...(token.id_token ? { id_token: token.id_token } : {}),
    };
    const payloadJson = JSON.stringify(credPayload);
    const payloadBytes = Buffer.byteLength(payloadJson, 'utf8');
    if (payloadBytes > MAX_CREDENTIAL_BYTES) {
      throw new Error(`AntigravityCredentialPayload exceeds ${MAX_CREDENTIAL_BYTES} bytes (${payloadBytes})`);
    }

    if (typeof opts.credWriteFn === 'function') {
      await opts.credWriteFn(payloadJson, credPayload);
    } else {
      await writeWindowsCredential(payloadJson);
    }
    invalidateCredentialCache();

    const standaloneTokenPath = path.join(paths.geminiDir, 'jetski-standalone-oauth-token');
    atomicWriteFile(standaloneTokenPath, payloadJson, { mode: 0o600 });

    const cliDir = path.join(paths.geminiDir, 'antigravity-cli');
    if (fs.existsSync(cliDir) && fs.statSync(cliDir).isDirectory()) {
      atomicWriteFile(path.join(cliDir, 'antigravity-oauth-token'), payloadJson, { mode: 0o600 });
    }

    account.last_used = nowSec;
    account.last_switched_at = nowSec;
    writeAccountRecord(safeId, account, { ...opts, nowSec });

    const email = String(account.email || token.email || '').trim();
    if (email) {
      atomicWriteFile(
        paths.currentAccountPath,
        JSON.stringify({ email, updated_at: nowSec }, null, 2),
        { mode: 0o600 }
      );
    }

    updateSqliteCurrentAccount(paths.sqlitePath, safeId, nowSec);

    const shouldLaunch = opts.launchOnSwitch !== false;

    let relaunched = false;
    if (shouldLaunch) {
      if (typeof opts.relaunchFn === 'function') {
        await opts.relaunchFn({ antigravityExe: opts.antigravityExe || resolveDefaultAntigravityExe() });
        relaunched = true;
      } else {
        relaunched = await spawnDetachedRelaunch(opts.antigravityExe);
      }
    }

    return {
      ok: true,
      activeId: safeId,
      relaunched,
      switchedAt: nowSec,
    };
  } finally {
    if (releaseAccountLock) {
      try {
        releaseAccountLock();
      } catch {}
    }
    if (releaseIndexLock) {
      try {
        releaseIndexLock();
      } catch {}
    }
    switchInFlight = false;
  }
}
