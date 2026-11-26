import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  decryptAccountEnvelope,
  encryptAccountEnvelope,
  getConfig,
  listAccounts,
  loadStorageKey,
  readAccountRecord,
  readWindowsCredential,
  redactSecrets,
  setConfig,
  setLabel,
  sha256Hex,
  writeAccountRecord,
} from '../sidecars/daemon/cockpit-store.mjs';
import {
  buildRelaunchJScript,
  buildRelaunchPsScript,
  deleteWindowsCredential,
  escapeForJScriptString,
  formatUtcRfc3339Micros,
  launchOutOfJobPowerShell,
  launchOutOfJobWScript,
  switchAccountNative,
  writeWindowsCredential,
} from '../sidecars/daemon/native-switcher.mjs';
import { CdpSession, discoverActivePort, isEligibleTarget } from '../sidecars/daemon/main.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_DIR = path.resolve(__dirname, '..');
const DAEMON_DIR = path.join(PLUGIN_DIR, 'sidecars', 'daemon');

const results = [];

async function runCheck(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail || '' });
    console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const msg = redactSecrets(err?.stack || err?.message || String(err));
    results.push({ name, ok: false, ms: Date.now() - started, error: msg });
    console.error(`[FAIL] ${name} — ${msg}`);
  }
}

function createTempCockpitFixture(tmpRoot) {
  const cockpitDir = path.join(tmpRoot, 'cockpit_tools');
  const geminiDir = path.join(tmpRoot, 'gemini');
  const accountsDir = path.join(cockpitDir, 'accounts');
  const cacheDir = path.join(cockpitDir, 'cache', 'quota_api_v1_desktop', 'authorized');
  const usageMonitorDataDir = path.join(geminiDir, 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data');
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(usageMonitorDataDir, { recursive: true });

  const keyBuf = crypto.randomBytes(32);
  const keyPath = path.join(cockpitDir, 'secure-account-storage.key');
  fs.writeFileSync(keyPath, keyBuf.toString('base64'), 'utf8');

  const sqlitePath = path.join(cockpitDir, 'antigravity_accounts.sqlite');
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE summaries (
      source TEXT NOT NULL,
      position INTEGER NOT NULL,
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL,
      plan_type TEXT
    );
    CREATE TABLE account_index_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state TEXT NOT NULL
    );
  `);

  const nowSec = Math.floor(Date.now() / 1000);
  const acc1 = {
    id: 'acc-alpha-001',
    email: 'alice.dev@example.com',
    disabled: false,
    last_used: nowSec - 100,
    token: {
      access_token: 'ya29.test-access-alpha',
      refresh_token: '1//test-refresh-alpha',
      expires_in: 3600,
      expiry_timestamp: nowSec + 3600, // > 900s skew -> should NOT refresh
      token_type: 'Bearer',
      email: 'alice.dev@example.com',
    },
    quota: {
      subscription_tier: 'g1-pro-tier',
    },
  };
  const acc2 = {
    id: 'acc-beta-002',
    email: 'beta.user@example.com',
    disabled: false,
    last_used: nowSec - 500,
    token: {
      access_token: 'ya29.test-access-beta-stale',
      refresh_token: '1//test-refresh-beta',
      expires_in: 3600,
      expiry_timestamp: nowSec + 300, // <= 900s skew -> MUST refresh
      token_type: 'Bearer',
      email: 'beta.user@example.com',
    },
    quota: {
      subscription_tier: 'g1-ultra-tier',
    },
  };

  const storeOpts = {
    cockpitDir,
    geminiDir,
    sqlitePath,
    keyPath,
    accountsDir,
    cacheDir,
    usageMonitorDataDir,
    currentAccountPath: path.join(cockpitDir, 'current_account.json'),
    labelsFile: path.join(geminiDir, 'config', 'antigravity-account-switcher-labels.json'),
    configFile: path.join(geminiDir, 'config', 'antigravity-account-switcher-config.json'),
  };

  writeAccountRecord(acc1.id, acc1, storeOpts);
  writeAccountRecord(acc2.id, acc2, storeOpts);

  const insertSum = db.prepare(
    'INSERT INTO summaries (source, position, account_id, email, created_at, last_used, plan_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insertSum.run('antigravity', 0, acc1.id, acc1.email, nowSec - 1000, acc1.last_used, 'g1-pro-tier');
  insertSum.run('antigravity', 1, acc2.id, acc2.email, nowSec - 900, acc2.last_used, 'g1-ultra-tier');

  db.prepare('INSERT INTO account_index_state (singleton, state) VALUES (1, ?)').run(
    JSON.stringify({ source: 0, version: 1, current_id: acc1.id })
  );
  db.close();

  const writeQuotaCache = (email, frac5h, fracWeek, updatedAtSec) => {
    const hash = sha256Hex(email.trim().toLowerCase());
    const reset5h = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const resetWeek = new Date(Date.now() + 5 * 86400 * 1000).toISOString();
    fs.writeFileSync(
      path.join(cacheDir, `${hash}.json`),
      JSON.stringify({
        updatedAt: updatedAtSec,
        payload: {
          quota_summary: {
            groups: [
              {
                displayName: 'Gemini Pro',
                buckets: [
                  { window: '5h', remainingFraction: frac5h, resetTime: reset5h },
                  { window: 'weekly', remainingFraction: fracWeek, resetTime: resetWeek },
                ],
              },
            ],
          },
        },
      }),
      'utf8'
    );
  };
  writeQuotaCache(acc1.email, 0.859, 0.609, nowSec - 120);
  writeQuotaCache(acc2.email, 0.429, 0.919, nowSec - 30);

  return { storeOpts, keyBuf, acc1, acc2, nowSec };
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-switcher-qa-'));
  try {
    // 1. Syntax check + agy-node.cmd import compatibility
    await runCheck('1. Syntax check & agy-node.cmd compatibility', async () => {
      const files = ['main.mjs', 'cockpit-store.mjs', 'native-switcher.mjs', 'ui-client.js'];
      for (const f of files) {
        const full = path.join(DAEMON_DIR, f);
        assert.ok(fs.existsSync(full), `Missing file: ${f}`);
        execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
      }
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const agyNodeCmd = path.join(appData, 'Antigravity', 'bin', 'agy-node.cmd');
      assert.ok(fs.existsSync(agyNodeCmd), `Missing agy-node.cmd at ${agyNodeCmd}`);

      const storeUrl = pathToFileURL(path.join(DAEMON_DIR, 'cockpit-store.mjs')).href;
      const probeExpr = `import('node:sqlite').then(()=>import(${JSON.stringify(storeUrl)})).then(()=>console.log('AGY_NODE_OK'))`;
      const out = execFileSync('cmd.exe', ['/c', agyNodeCmd, '-e', probeExpr], {
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.ok(out.includes('AGY_NODE_OK'), `agy-node.cmd failed import probe: ${out}`);
      return '4/4 files passed node --check; agy-node.cmd imported node:sqlite & cockpit-store.mjs';
    });

    // 2. Default email-prefix label + AES-256-GCM + label CRUD + zero leaks
    await runCheck('2. Email-prefix defaultLabel, AES-256-GCM, label CRUD & zero leaks', async () => {
      // Isolated fixture checks
      const { storeOpts, keyBuf, acc1, acc2 } = createTempCockpitFixture(path.join(tmpRoot, 'prefix-fixture'));
      let listed = await listAccounts({ ...storeOpts, skipCredRead: true });
      assert.equal(listed.accounts[0].defaultLabel, 'alice.dev');
      assert.equal(listed.accounts[0].label, 'alice.dev');
      assert.equal(listed.accounts[0].hasCustomLabel, false);
      assert.equal(listed.accounts[1].defaultLabel, 'beta.user');

      // Label override + rename + clear -> reverts to email prefix
      setLabel(acc1.id, '  Ana Hesap \n', storeOpts);
      listed = await listAccounts({ ...storeOpts, skipCredRead: true });
      assert.equal(listed.accounts[0].label, 'Ana Hesap');
      assert.equal(listed.accounts[0].hasCustomLabel, true);

      setLabel(acc1.id, '   ', storeOpts);
      listed = await listAccounts({ ...storeOpts, skipCredRead: true });
      assert.equal(listed.accounts[0].label, 'alice.dev');
      assert.equal(listed.accounts[0].hasCustomLabel, false);

      // AES-256-GCM envelope compatibility
      const env = encryptAccountEnvelope(acc2, keyBuf, 1700000000);
      assert.equal(env.algorithm, 'AES-256-GCM');
      assert.equal(Buffer.from(env.nonce, 'base64').length, 12);
      assert.deepEqual(decryptAccountEnvelope(env, keyBuf), acc2);
      const rec = readAccountRecord(acc2.id, storeOpts);
      assert.equal(rec.wasEncrypted, true);

      // Read-only against real .cockpit_tools
      const realRes = await listAccounts({
        labelsFile: path.join(tmpRoot, 'ro-labels.json'),
        configFile: path.join(tmpRoot, 'ro-config.json'),
      });
      assert.ok(realRes.accounts.length > 0, 'Expected >=1 real account');
      assert.ok(realRes.activeId, 'Expected real activeId');
      assert.ok(
        realRes.accounts.every((a) => typeof a.defaultLabel === 'string' && a.defaultLabel.length > 0 && !a.defaultLabel.includes('@')),
        'Every real account must have non-empty @-free defaultLabel'
      );
      const serialized = JSON.stringify(realRes);
      assert.equal(serialized.includes('@'), false, 'Leaked @ in listAccounts() output');
      for (const needle of ['access_token', 'refresh_token', 'id_token', 'ya29.', '1//', 'GOCSPX-']) {
        assert.equal(serialized.includes(needle), false, `Leaked secret marker ${needle}`);
      }
      const activeAcc = realRes.accounts.find((a) => a.isCurrent);
      return `alice.dev->alice.dev verified; ${realRes.accounts.length} real accounts (active="${activeAcc?.defaultLabel}"), 0 '@' & 0 tokens`;
    });

    // 3. Live 5h & 7d quota parity + history merge + cache fallback + native switch dry-run
    await runCheck('3. Live 5h/7d parity, history merge, truncation & switch dry-run', async () => {
      // A) Real live cli-status-snapshot.json parity
      const appDataGemini = path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data');
      const liveSnapPath = path.join(appDataGemini, 'cli-status-snapshot.json');
      assert.ok(fs.existsSync(liveSnapPath), 'Missing live cli-status-snapshot.json');
      const liveSnap = JSON.parse(fs.readFileSync(liveSnapPath, 'utf8'));
      const expected5h =
        typeof liveSnap.quotas.activePool.remainingPct === 'number'
          ? Math.round(liveSnap.quotas.activePool.remainingPct)
          : liveSnap.quotas.activePool.remainingIntPct;
      const expected7d =
        typeof liveSnap.quotas.activePool.weeklyRemainingPct === 'number'
          ? Math.round(liveSnap.quotas.activePool.weeklyRemainingPct)
          : liveSnap.quotas.activePool.weeklyRemainingIntPct ?? liveSnap.quotas.weekly?.remainingIntPct;
      assert.equal(typeof expected5h, 'number', 'Missing live activePool 5h pct');
      assert.equal(typeof expected7d, 'number', 'Missing live activePool 7d pct');

      const realRes = await listAccounts({
        labelsFile: path.join(tmpRoot, 'parity-labels.json'),
        configFile: path.join(tmpRoot, 'parity-config.json'),
      });
      const realActive = realRes.accounts.find((a) => a.isCurrent);
      assert.ok(realActive, 'No active account detected in real listAccounts()');
      assert.equal(realActive.quota5h, expected5h, `5h mismatch: got ${realActive.quota5h}, expected ${expected5h}`);
      assert.equal(realActive.quotaWeekly, expected7d, `7d mismatch: got ${realActive.quotaWeekly}, expected ${expected7d}`);

      // B) Isolated fixture: integer truncation + history vs cache timestamp merge + snapshot override
      const { storeOpts, acc1, acc2, nowSec } = createTempCockpitFixture(path.join(tmpRoot, 'quota-fixture'));
      // Cache for acc1 has 0.859 -> Math.floor(85.9) = 85 (not 86), 0.609 -> 60
      // History for acc1 is NEWER (nowSec - 10 vs cache nowSec - 120) -> 71 / 88
      // History for acc2 is OLDER (nowSec - 300 vs cache nowSec - 30) -> should keep cache 42 / 91
      fs.writeFileSync(
        path.join(storeOpts.usageMonitorDataDir, 'account_quota_history.json'),
        JSON.stringify({
          accounts: {
            [acc1.email]: {
              updatedAtMs: (nowSec - 10) * 1000,
              pools: {
                Gemini: {
                  reset5hMs: (nowSec + 3600) * 1000,
                  resetWeeklyMs: (nowSec + 86400) * 1000,
                  points: [[(nowSec - 10) * 1000, 71.9, 88.9]],
                },
              },
            },
            [acc2.email]: {
              updatedAtMs: (nowSec - 300) * 1000,
              pools: {
                Gemini: {
                  points: [[(nowSec - 300) * 1000, 11, 22]],
                },
              },
            },
          },
        }),
        'utf8'
      );

      let merged = await listAccounts({ ...storeOpts, nowMs: nowSec * 1000, skipCredRead: true });
      assert.equal(merged.accounts[0].quota5h, 71, 'Expected newer history 71% with floor truncation');
      assert.equal(merged.accounts[0].quotaWeekly, 88, 'Expected newer history 88% with floor truncation');
      assert.equal(merged.accounts[1].quota5h, 42, 'Expected newer cache 42% with floor truncation');
      assert.equal(merged.accounts[1].quotaWeekly, 91, 'Expected newer cache 91% with floor truncation');

      // Snapshot overrides active account (acc1) when fresh and >= last_switched_at
      fs.writeFileSync(
        path.join(storeOpts.usageMonitorDataDir, 'cli-status-snapshot.json'),
        JSON.stringify({
          updatedAtMs: nowSec * 1000,
          quotas: {
            meta: { hasOfficialData: true },
            activePool: {
              remainingIntPct: 79,
              weeklyRemainingIntPct: 93,
              resetTime: new Date((nowSec + 5400) * 1000).toISOString(),
              weeklyResetTime: new Date((nowSec + 172800) * 1000).toISOString(),
            },
          },
        }),
        'utf8'
      );
      merged = await listAccounts({ ...storeOpts, nowMs: nowSec * 1000, skipCredRead: true });
      assert.equal(merged.accounts[0].quota5h, 79, 'Snapshot override 5h failed');
      assert.equal(merged.accounts[0].quotaWeekly, 93, 'Snapshot override 7d failed');

      // C) Native switch dry-run: default launchOnSwitch=true, conditional OAuth refresh, atomic writes, 0 .bak
      const fetchCalls = [];
      const credWrites = [];
      const relaunches = [];
      const resSwitch = await switchAccountNative(acc2.id, {
        ...storeOpts,
        nowFn: () => nowSec * 1000,
        fetchFn: async (_u, init) => {
          fetchCalls.push(init?.headers || {});
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ access_token: 'ya29.new-beta', expires_in: 3600, token_type: 'Bearer' }),
          };
        },
        credWriteFn: async (json, obj) => credWrites.push({ json, obj }),
        relaunchFn: async (info) => relaunches.push(info),
      });
      assert.equal(resSwitch.ok, true);
      assert.equal(resSwitch.relaunched, true, 'Expected launchOnSwitch default true');
      assert.equal(relaunches.length, 1);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0]['User-Agent'], 'vscode/1.X.X (Antigravity/4.3.0)');
      assert.equal(credWrites[0].obj.auth_method, 'consumer');
      assert.equal(credWrites[0].obj.token.token_type, 'Bearer');
      assert.match(credWrites[0].obj.token.expiry, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      assert.ok(Buffer.byteLength(credWrites[0].json, 'utf8') <= 2560);

      const standalonePath = path.join(storeOpts.geminiDir, 'jetski-standalone-oauth-token');
      assert.deepEqual(JSON.parse(fs.readFileSync(standalonePath, 'utf8')), credWrites[0].obj);
      const bakFiles = fs.readdirSync(storeOpts.accountsDir).filter((n) => n.endsWith('.bak'));
      assert.equal(bakFiles.length, 0);

      return `Live parity matched cli-status-snapshot.json (${expected5h}% / ${expected7d}%); history merge, floor truncation, & switch dry-run passed`;
    });

    // 4. REAL Windows CredWriteW + CredReadW + CredDeleteW round-trip on disposable target
    await runCheck('4. Real Windows CredWriteW / CredReadW / CredDeleteW round-trip', async () => {
      const testTarget = 'gemini:antigravity-switcher-selftest';
      const testPayload = {
        token: {
          access_token: 'ya29.selftest-dummy-access',
          token_type: 'Bearer',
          refresh_token: '1//selftest-dummy-refresh',
          expiry: formatUtcRfc3339Micros(Math.floor(Date.now() / 1000) + 3600),
        },
        auth_method: 'consumer',
      };
      try {
        await writeWindowsCredential(JSON.stringify(testPayload), testTarget);
        const readBack = await readWindowsCredential({ targetName: testTarget, noCache: true });
        assert.deepEqual(readBack, testPayload, 'Read-back credential did not match written payload');

        // Confirm safety guard refuses deleting live gemini:antigravity
        await assert.rejects(
          () => deleteWindowsCredential('gemini:antigravity'),
          /Refusing to delete live gemini:antigravity/
        );
      } finally {
        await deleteWindowsCredential(testTarget).catch(() => {});
      }
      const afterDelete = await readWindowsCredential({ targetName: testTarget, noCache: true });
      assert.equal(afterDelete, null, 'Test credential still readable after CredDeleteW');
      return `CredWriteW -> CredReadW -> CredDeleteW passed on "${testTarget}" (live target untouched)`;
    });

    // 5. Daemon keep-alive check (>2.5s) with isolated temp portFile & PID file
    await runCheck('5. Daemon keep-alive check (>2.5s resident)', async () => {
      const keepAliveDir = path.join(tmpRoot, 'keepalive');
      fs.mkdirSync(keepAliveDir, { recursive: true });
      const tempPidFile = path.join(keepAliveDir, 'daemon.pid');
      const missingPortFile = path.join(keepAliveDir, 'NoSuchPortFile');
      const harnessScript = `
        import { AccountSwitcherDaemon, acquireSingleInstanceLock } from ${JSON.stringify(pathToFileURL(path.join(DAEMON_DIR, 'main.mjs')).href)};
        const release = acquireSingleInstanceLock(${JSON.stringify(tempPidFile)});
        if (!release) process.exit(2);
        const d = new AccountSwitcherDaemon({ portFile: ${JSON.stringify(missingPortFile)}, pollMs: 500 });
        process.on('SIGTERM', () => { d.stop(); release(); process.exit(0); });
        await d.start();
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', harnessScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      try {
        await new Promise((r) => setTimeout(r, 2700));
        assert.equal(child.exitCode, null, `Daemon exited prematurely with code ${child.exitCode}`);
        assert.equal(child.signalCode, null, `Daemon terminated prematurely by signal ${child.signalCode}`);
        assert.ok(fs.existsSync(tempPidFile), 'Temp PID file missing while daemon alive');
      } finally {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const t = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
            resolve();
          }, 1500);
          child.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      return 'Daemon remained resident >2.7s with active interval (no premature exit)';
    });

    // 6. UI static audit (ui-client.js + assets/logo.svg)
    await runCheck('6. UI static audit (boxless, 5h/7d tags, scrollbar clearance, no toggle, 0 green)', async () => {
      const uiSrc = fs.readFileSync(path.join(DAEMON_DIR, 'ui-client.js'), 'utf8');
      const svgSrc = fs.readFileSync(path.join(PLUGIN_DIR, 'assets', 'logo.svg'), 'utf8');

      const forbiddenGreens = [
        '#34D399',
        '#10B981',
        '#22c55e',
        '#4ade80',
        '#16a34a',
        '#059669',
        '#00ff',
        'rgb(52, 211, 153)',
        'rgba(52, 211, 153',
        'rgb(16, 185, 129)',
        'rgb(34, 197, 94)',
        'status-ok',
        'ag-as-status-dot',
      ];
      for (const target of [
        { name: 'ui-client.js', text: uiSrc },
        { name: 'logo.svg', text: svgSrc },
      ]) {
        const low = target.text.toLowerCase();
        for (const g of forbiddenGreens) {
          assert.equal(low.includes(g.toLowerCase()), false, `${target.name} contains forbidden green: ${g}`);
        }
      }

      // Removed launchOnSwitch toggle completely
      assert.equal(uiSrc.includes('Geçişte yeniden başlat'), false, 'Found removed restart toggle text');
      assert.equal(uiSrc.includes('ag-as-pop-foot'), false, 'Found removed .ag-as-pop-foot');
      assert.equal(uiSrc.includes('set-config'), false, 'Found removed set-config call');

      // Scrollbar clearance & boxless CSS rules
      assert.ok(/scrollbar-gutter:\s*stable/.test(uiSrc), 'Missing scrollbar-gutter: stable on .ag-as-list');
      assert.ok(/padding-right:\s*10px/.test(uiSrc), 'Missing padding-right: 10px on .ag-as-list');
      assert.ok(/\.ag-as-seg\s*\{[^}]*background:\s*transparent\s*!important/s.test(uiSrc), 'Missing background: transparent !important on .ag-as-seg');
      assert.ok(uiSrc.includes('ag-as-q-tag') && uiSrc.includes("'5h'") && uiSrc.includes("'7d'"), 'Missing tiny 5h/7d tags');
      assert.ok(uiSrc.includes('state.isSwitching = false'), 'Missing state.isSwitching = false reset');
      assert.ok(uiSrc.includes('__agAccountSwitcherOnUpdate'), 'Missing live push handler');
      assert.ok(uiSrc.includes('__agPulseExternalBridge'), 'Missing GravityPrism __agPulseExternalBridge tap');
      assert.ok(uiSrc.includes('five-balance') && uiSrc.includes('week-balance'), 'Missing Shadow DOM #five-balance/#week-balance mirror');
      assert.ok(uiSrc.includes('getEffectiveQuota'), 'Missing in-memory getEffectiveQuota overlay');

      const mainSrc = fs.readFileSync(path.join(DAEMON_DIR, 'main.mjs'), 'utf8');
      const watchBlockMatch = mainSrc.match(/_computeWatchFilesSignature\(\)\s*\{[\s\S]*?\n  \}/);
      assert.ok(watchBlockMatch, 'Missing _computeWatchFilesSignature in main.mjs');
      assert.equal(watchBlockMatch[0].includes('cli-status-snapshot.json'), false, 'main.mjs still polls cli-status-snapshot.json on disk');
      assert.equal(watchBlockMatch[0].includes('account_quota_history.json'), false, 'main.mjs still polls account_quota_history.json on disk');

      // Zero email rendering + owned/no-translate + destroy()
      assert.equal(/\bacc\.email\b|\.email\b/.test(uiSrc), false, 'ui-client.js references .email');
      const nonCssAt = (uiSrc.match(/@[A-Za-z0-9_-]+/g) || []).filter((m) => m !== '@keyframes');
      assert.equal(nonCssAt.length, 0, `Unexpected @ occurrences: ${nonCssAt.join(', ')}`);
      assert.ok(uiSrc.includes('data-ag-owned'), 'Missing data-ag-owned');
      for (const attr of [
        'translate',
        'data-no-translate',
        'data-ag-localization-skip',
        'data-agy-no-translate',
        'data-antigravity-zh-skip',
      ]) {
        assert.ok(uiSrc.includes(attr), `Missing ${attr}`);
      }
      assert.ok(uiSrc.includes('function destroy()') && uiSrc.includes('destroy,'), 'Missing destroy()');

      return '0 green, 0 restart toggle, scrollbar-gutter + padding-right, transparent !important, 5h/7d tags, isSwitching reset verified';
    });

    // 7. Live daemon & CDP DOM verification + manifest validation
    await runCheck('7. Live daemon status, manifest & CDP DOM verification', async () => {
      const pluginJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
      const allowedPluginKeys = new Set([
        'name',
        'description',
        'logo',
        'suggestedPrompts',
        'displayName',
        'version',
        'author',
        'homepage',
        'repository',
        'disabled',
      ]);
      for (const key of Object.keys(pluginJson)) {
        assert.ok(allowedPluginKeys.has(key), `Invalid top-level key in plugin.json: ${key}`);
      }
      assert.ok(fs.existsSync(path.join(PLUGIN_DIR, pluginJson.logo)), 'Missing plugin.json logo');
      const sidecarJson = JSON.parse(fs.readFileSync(path.join(DAEMON_DIR, 'sidecar.json'), 'utf8'));
      assert.equal(sidecarJson.command, 'node');
      assert.deepEqual(sidecarJson.args, ['main.mjs']);
      assert.equal(sidecarJson.restart_policy, 'always');
      assert.equal(sidecarJson.has_web_ui, false);

      // Check whether persistent sidecar daemon is currently running via daemon.pid + Win32_Process
      const pidFilePath = path.join(
        os.homedir(),
        '.gemini',
        'antigravity',
        'sidecar_data',
        'antigravity-account-switcher',
        'daemon.pid'
      );
      let sidecarPidInfo = { running: false, pid: null, startedAt: null, isPrePhase3: false };
      if (fs.existsSync(pidFilePath)) {
        try {
          const pidObj = JSON.parse(fs.readFileSync(pidFilePath, 'utf8'));
          const pidNum = Number(pidObj?.pid);
          if (Number.isInteger(pidNum) && pidNum > 0) {
            const procJson = execFileSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pidNum}" -ErrorAction SilentlyContinue; if ($p) { @{ pid = $p.ProcessId; name = $p.Name; cmd = $p.CommandLine } | ConvertTo-Json -Compress }`,
              ],
              { encoding: 'utf8', windowsHide: true, timeout: 6000 }
            ).trim();
            if (procJson) {
              const pInfo = JSON.parse(procJson);
              const cmdLow = String(pInfo.cmd || '').toLowerCase();
              const isMainMjs = cmdLow.includes('main.mjs');
              const newestCodeMtimeMs = Math.max(
                fs.statSync(path.join(DAEMON_DIR, 'cockpit-store.mjs')).mtimeMs,
                fs.statSync(path.join(DAEMON_DIR, 'native-switcher.mjs')).mtimeMs,
                fs.statSync(path.join(DAEMON_DIR, 'main.mjs')).mtimeMs
              );
              sidecarPidInfo = {
                running: isMainMjs,
                pid: pidNum,
                startedAt: pidObj.startedAt || null,
                isPrePhase3: Boolean(pidObj.startedAt && pidObj.startedAt < newestCodeMtimeMs),
              };
            }
          }
        } catch {}
      }

      const appDataGemini = path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data');
      const readLiveSnap = () => {
        const s = JSON.parse(fs.readFileSync(path.join(appDataGemini, 'cli-status-snapshot.json'), 'utf8'));
        return {
          p5h:
            typeof s.quotas.activePool.remainingPct === 'number'
              ? Math.round(s.quotas.activePool.remainingPct)
              : s.quotas.activePool.remainingIntPct,
          p7d:
            typeof s.quotas.activePool.weeklyRemainingPct === 'number'
              ? Math.round(s.quotas.activePool.weeklyRemainingPct)
              : s.quotas.activePool.weeklyRemainingIntPct ?? s.quotas.weekly?.remainingIntPct,
          updatedAtMs: s.updatedAtMs,
        };
      };
      const snapBefore = readLiveSnap();

      const port = discoverActivePort();
      assert.ok(port, 'Antigravity DevToolsActivePort not found');

      // Ensure latest ui-client.js is mounted via --once
      const onceOut = execFileSync(process.execPath, [path.join(DAEMON_DIR, 'main.mjs'), '--once'], {
        encoding: 'utf8',
        timeout: 20000,
      }).trim();
      const onceParsed = JSON.parse(onceOut);
      assert.equal(onceParsed.ok, true);
      assert.ok(onceParsed.attached >= 1, `Expected >=1 attached target`);
      const snapAfter = readLiveSnap();

      const targetsRes = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      const targets = await targetsRes.json();
      const eligible = targets.filter(isEligibleTarget);
      assert.ok(eligible.length >= 1, 'No eligible Antigravity targets');

      let verifiedHostCount = 0;
      let summaryNote = '';
      for (const target of eligible) {
        const session = await CdpSession.connect(target.webSocketDebuggerUrl, 4000);
        const pageExceptions = [];
        try {
          session.on('Runtime.exceptionThrown', (params) => {
            pageExceptions.push(params?.exceptionDetails?.text || 'exception');
          });
          await session.send('Runtime.enable', {}, 4000);

          const domCheck = await session.evaluate(`(() => {
            const isHost = Boolean(document.body && (document.body.classList.contains('theme-standalone') || document.body.classList.contains('monaco-workbench') || document.querySelector('[data-testid="sidebar-split"], div[role="navigation"][aria-label="Sidebar"], .monaco-workbench')));
            if (!isHost) return { isHost: false };
            const api = window.__agAccountSwitcherUi;
            const footer = document.querySelector('[data-ag-as-footer="1"]');
            const labelBtn = footer ? footer.querySelector('.ag-as-seg-label') : null;
            const quotaBtn = footer ? footer.querySelector('.ag-as-seg-quota') : null;
            const settings = document.querySelector('[data-ag-as-settings="1"]');
            if (!footer || !labelBtn || !quotaBtn || !settings) {
              return { isHost: true, mounted: false };
            }
            const footerBg = getComputedStyle(footer).backgroundColor;
            const labelBg = getComputedStyle(labelBtn).backgroundColor;
            const quotaBg = getComputedStyle(quotaBtn).backgroundColor;
            const settingsBg = getComputedStyle(settings).backgroundColor;
            const tags = Array.from(quotaBtn.querySelectorAll('.ag-as-q-tag')).map((n) => n.textContent.trim());
            const vals = Array.from(quotaBtn.querySelectorAll('.ag-as-q-val')).map((n) => n.textContent.trim());

            // Open popover via click
            labelBtn.click();
            const pop = document.getElementById('ag-as-popover');
            const list = pop ? pop.querySelector('.ag-as-list') : null;
            const listRect = list ? list.getBoundingClientRect() : null;
            const editBtns = pop ? Array.from(pop.querySelectorAll('.ag-as-edit-btn')) : [];
            const clearances = editBtns.map((b) => {
              const r = b.getBoundingClientRect();
              const innerRight = listRect ? (listRect.left + list.clientWidth) : 0;
              return {
                outerClearance: listRect ? Math.round((listRect.right - r.right) * 10) / 10 : -1,
                innerClearance: listRect ? Math.round((innerRight - r.right) * 10) / 10 : -1,
              };
            });
            const popText = pop ? pop.textContent : '';
            const hasRestartToggle = popText.includes('Geçişte yeniden başlat') || Boolean(pop && pop.querySelector('.ag-as-pop-foot'));
            const hasPopSummary = Boolean(pop && pop.querySelector('.ag-as-pop-summary'));
            const refreshBtn = pop ? pop.querySelector('.ag-as-icon-btn') : null;
            const refreshAlignedDelta =
              refreshBtn && editBtns[0]
                ? Math.round(Math.abs(refreshBtn.getBoundingClientRect().right - editBtns[0].getBoundingClientRect().right) * 10) / 10
                : -1;
            const hasTableHead = Boolean(pop && pop.querySelector('.ag-as-table-head'));
            const checkSlotCount = pop ? pop.querySelectorAll('.ag-as-check-slot').length : -1;
            const truncatedResets = pop
              ? Array.from(pop.querySelectorAll('.ag-as-cell-reset')).filter((el) => el.scrollWidth > el.clientWidth + 1).length
              : -1;
            const greenDots = Array.from(document.querySelectorAll('[data-ag-as-node="1"], [data-ag-as-footer="1"] *')).filter((el) => {
              const bg = getComputedStyle(el).backgroundColor || '';
              return /52,\s*211,\s*153|16,\s*185,\s*129|34,\s*197,\s*94|74,\s*222,\s*128/.test(bg);
            }).length;

            const pulseHost =
              document.querySelector('#ag-prism-pulse-bar, [data-ag-prism-pulse-bar="true"], #ag-pulse-status-bar, [data-ag-pulse-bar="true"]');
            const pulseSr = pulseHost ? pulseHost.shadowRoot : null;
            const pulse5hText = pulseSr?.getElementById('five-balance')?.textContent?.trim() || null;
            const pulse7dText = pulseSr?.getElementById('week-balance')?.textContent?.trim() || null;

            // Close popover cleanly
            api.closePopover();

            return {
              isHost: true,
              mounted: true,
              apiState: api.getState(),
              labelText: labelBtn.textContent.trim(),
              quotaText: quotaBtn.textContent.trim(),
              tags,
              vals,
              pulse5hText,
              pulse7dText,
              footerBg,
              labelBg,
              quotaBg,
              settingsBg,
              hasPopover: Boolean(pop),
              hasRestartToggle,
              hasPopSummary,
              refreshAlignedDelta,
              hasTableHead,
              checkSlotCount,
              truncatedResets,
              clearances,
              greenDots,
              popoverClosed: !document.getElementById('ag-as-popover'),
            };
          })()`);

          if (!domCheck.isHost) continue;
          verifiedHostCount += 1;
          assert.equal(domCheck.mounted, true, 'Footer not mounted in host');
          assert.ok(domCheck.apiState.accountCount > 0, 'accountCount is 0');
          assert.equal(domCheck.labelText.includes('@'), false, 'Label contains @');
          assert.deepEqual(domCheck.tags, ['5h', '7d'], `Expected ['5h','7d'] tags, got ${JSON.stringify(domCheck.tags)}`);
          assert.equal(domCheck.vals.length, 2, `Expected 2 quota values, got ${JSON.stringify(domCheck.vals)}`);
          const dom5h = parseInt(domCheck.vals[0], 10);
          const dom7d = parseInt(domCheck.vals[1], 10);
          assert.ok(Number.isInteger(dom5h) && dom5h >= 0 && dom5h <= 100, `Invalid DOM 5h: ${domCheck.vals[0]}`);
          assert.ok(Number.isInteger(dom7d) && dom7d >= 0 && dom7d <= 100, `Invalid DOM 7d: ${domCheck.vals[1]}`);
          const hasLivePulse5h = Boolean(domCheck.pulse5hText && /\d+%/.test(domCheck.pulse5hText));
          const hasLivePulse7d = Boolean(domCheck.pulse7dText && /\d+%/.test(domCheck.pulse7dText));
          if (hasLivePulse5h) {
            assert.equal(domCheck.vals[0], domCheck.pulse5hText, `Sidebar 5h (${domCheck.vals[0]}) != chat bar (${domCheck.pulse5hText})`);
          }
          if (hasLivePulse7d) {
            assert.equal(domCheck.vals[1], domCheck.pulse7dText, `Sidebar 7d (${domCheck.vals[1]}) != chat bar (${domCheck.pulse7dText})`);
          }
          if (!hasLivePulse5h || !hasLivePulse7d) {
            const exactMatch =
              (dom5h === snapBefore.p5h && dom7d === snapBefore.p7d) ||
              (dom5h === snapAfter.p5h && dom7d === snapAfter.p7d);
            const nearLive =
              Math.abs(dom5h - snapAfter.p5h) <= 10 && Math.abs(dom7d - snapAfter.p7d) <= 4;
            assert.ok(
              exactMatch || nearLive,
              `Footer quota [${dom5h}%, ${dom7d}%] diverged from live cli-status-snapshot (before=[${snapBefore.p5h}%, ${snapBefore.p7d}%], after=[${snapAfter.p5h}%, ${snapAfter.p7d}%])`
            );
          }
          for (const [k, v] of [
            ['footerBg', domCheck.footerBg],
            ['labelBg', domCheck.labelBg],
            ['quotaBg', domCheck.quotaBg],
            ['settingsBg', domCheck.settingsBg],
          ]) {
            assert.equal(v, 'rgba(0, 0, 0, 0)', `${k} is not transparent: ${v}`);
          }
          assert.equal(domCheck.hasPopover, true, 'Popover did not open on click');
          assert.equal(domCheck.hasRestartToggle, false, 'Restart toggle still present in popover');
          assert.equal(domCheck.hasPopSummary, false, 'Removed .ag-as-pop-summary still present in header');
          assert.ok(domCheck.refreshAlignedDelta >= 0 && domCheck.refreshAlignedDelta <= 2, `Refresh button misaligned with edit column (delta=${domCheck.refreshAlignedDelta}px)`);
          assert.equal(domCheck.hasTableHead, true, 'Missing Option #6 .ag-as-table-head');
          assert.equal(domCheck.checkSlotCount, 0, 'Left check-slot gutter still present');
          assert.equal(domCheck.truncatedResets, 0, 'One or more reset countdowns truncated');
          assert.ok(domCheck.clearances.length > 0, 'No edit buttons found in popover');
          for (const c of domCheck.clearances) {
            assert.ok(
              c.innerClearance >= 8,
              `Edit button inner clearance < 8px (${c.innerClearance}px, outer=${c.outerClearance}px)`
            );
          }
          assert.equal(domCheck.popoverClosed, true, 'Popover did not close cleanly');
          assert.equal(domCheck.greenDots, 0, 'Green dot detected in live DOM');
          assert.equal(pageExceptions.length, 0, `Page exceptions: ${pageExceptions.join('; ')}`);

          const minClearance = Math.min(...domCheck.clearances.map((c) => c.innerClearance));
          const sidecarStatus = sidecarPidInfo.running
            ? `pid=${sidecarPidInfo.pid}${sidecarPidInfo.isPrePhase3 ? ' (pre-Phase3 in-memory; plugin reload needed)' : ' (current)'}`
            : 'not running';
          summaryNote = `Option #6 table mounted "${domCheck.labelText}" | 5h ${dom5h}% · 7d ${dom7d}% (snap=${snapAfter.p5h}%/${snapAfter.p7d}%), checkSlots=0, truncatedResets=0, minEditClearance=${minClearance}px, sidecar=${sidecarStatus}`;
        } finally {
          session.close();
        }
      }

      assert.ok(verifiedHostCount >= 1, 'No host target verified');
      return summaryNote;
    });

    // 8. Out-of-Job Relaunch Probe via Task Scheduler COM (WScript GUI zero-flash + PowerShell fallback)
    await runCheck('8. Out-of-Job Task Scheduler launch probe (wscript.exe zero-flash + svchost parent)', async () => {
      const jsRelaunchScript = buildRelaunchJScript('C:\\App\\Antigravity.exe');
      assert.ok(jsRelaunchScript.includes('--remote-debugging-port'), 'JScript relaunch missing --remote-debugging-port');
      assert.ok(jsRelaunchScript.includes('language_server'), 'JScript relaunch missing language_server cleanup');
      assert.ok(jsRelaunchScript.includes(', 1, false)'), 'JScript relaunch missing SW_SHOWNORMAL run flags');
      assert.equal(/\b(?:const|let)\s+|=>/.test(jsRelaunchScript), false, 'JScript must be pure ES3 (no const/let/=>)');

      const psRelaunchScript = buildRelaunchPsScript('C:\\App\\Antigravity.exe');
      assert.ok(psRelaunchScript.includes('--remote-debugging-port'), 'PS relaunch script missing --remote-debugging-port');
      assert.ok(psRelaunchScript.includes('-WindowStyle Normal'), 'PS relaunch script missing -WindowStyle Normal');
      assert.ok(psRelaunchScript.includes('language_server'), 'PS relaunch script missing language_server cleanup');

      const wsTaskName = 'AntigravityAccountSwitcherWScriptSelfTest';
      const wsProbeFile = path.join(tmpRoot, 'out_of_job_wscript_probe.json');
      const wsProbe = [
        'var fso = new ActiveXObject("Scripting.FileSystemObject");',
        'var sh = new ActiveXObject("WScript.Shell");',
        'try {',
        '  try {',
        '    var ts = new ActiveXObject("Schedule.Service");',
        '    ts.Connect();',
        `    ts.GetFolder("\\\\").DeleteTask("${escapeForJScriptString(wsTaskName)}", 0);`,
        '  } catch (e) {}',
        `  var wmi = GetObject("${escapeForJScriptString('winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2')}");`,
        '  var selfFull = String(WScript.FullName || "");',
        '  var exeName = fso.GetFileName(selfFull);',
        '  var scriptFull = String(WScript.ScriptFullName || "");',
        '  var en = new Enumerator(wmi.ExecQuery("SELECT ProcessId, ParentProcessId, SessionId, Name FROM Win32_Process WHERE Name = \'wscript.exe\'"));',
        '  var myPid = 0; var parentPid = 0; var sessionId = 0;',
        '  for (; !en.atEnd(); en.moveNext()) {',
        '    var p = en.item();',
        '    myPid = Number(p.ProcessId) || 0;',
        '    parentPid = Number(p.ParentProcessId) || 0;',
        '    sessionId = Number(p.SessionId) || 0;',
        '  }',
        '  var parentName = "";',
        '  if (parentPid > 0) {',
        '    var pe = new Enumerator(wmi.ExecQuery("SELECT Name FROM Win32_Process WHERE ProcessId = " + parentPid));',
        '    if (!pe.atEnd()) parentName = String(pe.item().Name || "");',
        '  }',
        '  var esc = function(s) { return String(s).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\\""); };',
        '  var json = \'{"parentPid":\' + parentPid + \',"parentName":"\' + esc(parentName) + \'","exeName":"\' + esc(exeName) + \'","sessionId":\' + sessionId + \',"pid":\' + myPid + \',"scriptPath":"\' + esc(scriptFull) + \'"}\';',
        `  var tf = fso.CreateTextFile("${escapeForJScriptString(wsProbeFile)}", true, false);`,
        '  tf.Write(json);',
        '  tf.Close();',
        '} finally {',
        '  try { fso.DeleteFile(WScript.ScriptFullName, true); } catch (e) {}',
        '}',
        '',
      ].join('\r\n');

      const wsStarted = Date.now();
      await launchOutOfJobWScript(wsProbe, { taskName: wsTaskName, timeoutMs: 10000 });
      const wsDeadline = Date.now() + 8000;
      while (!fs.existsSync(wsProbeFile) && Date.now() < wsDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const wsElapsedMs = Date.now() - wsStarted;
      assert.ok(fs.existsSync(wsProbeFile), 'Out-of-Job WScript helper did not write probe output within 8s');
      const wsResult = JSON.parse(fs.readFileSync(wsProbeFile, 'utf8'));
      assert.equal(
        String(wsResult.exeName || '').toLowerCase(),
        'wscript.exe',
        `Expected GUI-subsystem wscript.exe, got ${wsResult.exeName}`
      );
      assert.equal(
        String(wsResult.parentName || '').toLowerCase(),
        'svchost.exe',
        `Expected Task Scheduler svchost.exe parent, got ${wsResult.parentName}`
      );
      assert.ok(Number(wsResult.sessionId) >= 1, `Expected interactive sessionId >= 1, got ${wsResult.sessionId}`);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(fs.existsSync(wsResult.scriptPath), false, `Temp helper script was not self-deleted: ${wsResult.scriptPath}`);

      const probeTaskName = 'AntigravityAccountSwitcherSelfTest';
      const probeFile = path.join(tmpRoot, 'out_of_job_probe.json');
      const escapedProbeFile = probeFile.replace(/'/g, "''");
      const padComment = `# ${'relaunch-stdin-padding '.repeat(24)}\n`.repeat(5);
      const probeScript = `
$ErrorActionPreference = 'Stop'
${padComment}
try {
  $tsClean = New-Object -ComObject Schedule.Service
  $tsClean.Connect()
  $tsClean.GetFolder('\\').DeleteTask('${probeTaskName}', 0)
} catch {}
$proc = Get-Process -Id $PID
$wmi = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$parent = if ($wmi) { Get-CimInstance Win32_Process -Filter "ProcessId=$($wmi.ParentProcessId)" } else { $null }
$obj = @{
  parentPid = if ($wmi) { $wmi.ParentProcessId } else { 0 }
  parentName = if ($parent) { $parent.Name } else { '' }
  sessionId = $proc.SessionId
  pid = $PID
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText('${escapedProbeFile}', $obj, [System.Text.Encoding]::UTF8)
`;
      assert.ok(probeScript.length >= 2200, `Expected >=2200 char probeScript, got ${probeScript.length}`);
      await launchOutOfJobPowerShell(probeScript, { taskName: probeTaskName, timeoutMs: 10000 });
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(probeFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.ok(fs.existsSync(probeFile), 'Out-of-Job scheduled helper did not write probe output within 8s');
      const probe = JSON.parse(fs.readFileSync(probeFile, 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(
        String(probe.parentName || '').toLowerCase(),
        'svchost.exe',
        `Expected Task Scheduler svchost.exe parent (outside Antigravity Job Object), got ${probe.parentName}`
      );
      assert.ok(Number(probe.sessionId) >= 1, `Expected interactive sessionId >= 1, got ${probe.sessionId}`);

      const checkTaskExists = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ts = New-Object -ComObject Schedule.Service; $ts.Connect(); $r = @(); foreach ($n in @('${wsTaskName}','${probeTaskName}')) { try { $null = $ts.GetFolder('\\').GetTask($n); $r += $n } catch {} }; if ($r.Count -eq 0) { 'CLEAN' } else { $r -join ',' }`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 6000 }
      ).trim();
      assert.equal(checkTaskExists, 'CLEAN', `Tasks not cleaned up: ${checkTaskExists}`);
      return `exe=${wsResult.exeName} (${wsElapsedMs}ms), parent=${wsResult.parentName} (pid=${wsResult.parentPid}), sessionId=${wsResult.sessionId}, psFallback=ok, task=${checkTaskExists}`;
    });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(redactSecrets(err?.stack || err));
  process.exit(1);
});
