#!/usr/bin/env node
// Launch smoke for the generic desktop app (smrt#4835).
//
// Runs an already built, UNSIGNED wrapper binary against a bundle made by
// `smrt desktop bundle` (see build-desktop-app.mjs) and checks, from an EMPTY
// data directory, that:
//   1. the wrapper starts the sidecar and logs the ready origin;
//   2. the sidecar's health route answers 200 (the app created its schema on
//      first start) and the data directory was created and is not empty;
//   3. the owner link route answers 403 with an empty body to a loopback
//      request that lacks the per-launch secret (the secret is known only to
//      the wrapper window and the sidecar, so this script cannot redirect),
//      answers 403 to a wrong secret and to a foreign Host, and the /setup and
//      home pages load without an owner form or a terminal command (the
//      window itself is signed in by the owner link, which this script cannot
//      follow without the secret);
//   4. the wrapper log shows the window origin and route and contains no
//      secret-looking 64-hex string, no `launch=` query and no token;
//   5. the wrapper quits on request and no process of the sidecar is left.
//
//   node launch-smoke.mjs --wrapper <exe> --bundle <bundle dir> \
//     --triple <rust triple> [--timeout-ms 120000] [--keep] [--identifier <id>]
//
// Linux needs a display: run it under `xvfb-run -a`. The wrapper is the
// debug/no-bundle binary; the bundle's resources and sidecar are placed next
// to a copy of it in a `target/debug` layout, which is where a non-installed
// Tauri build looks for them (see STAGE_RUN_DIR).

import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const wrapperDir = resolve(here, '..');

// ---------------------------------------------------------------------------
// Pure parts (unit tested in launch-smoke.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Tauri's `app_local_data_dir` for an identifier: the machine-local root the
 * wrapper keeps the sidecar data directory and its log under.
 */
export function appLocalDataDir({ platform, env, home, identifier }) {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', identifier);
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA;
    if (!base) throw new Error('LOCALAPPDATA is not set');
    return join(base, identifier);
  }
  const base = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(base, identifier);
}

/** Standard OS log location, matching Tauri's app_log_dir. */
export function appLogDir({ platform, env, home, identifier }) {
  if (platform === 'darwin') return join(home, 'Library', 'Logs', identifier);
  return join(appLocalDataDir({ platform, env, home, identifier }), 'logs');
}

/**
 * The identifier the wrapper under test was built with: `tauri.conf.json`'s
 * unless `--identifier` says otherwise. A debug wrapper built with another
 * identifier (the `identifier` key of the `TAURI_CONFIG` environment variable
 * at build time) gets its own data directory and its own single-instance socket
 * (`/tmp/<identifier>_si.sock`), so it can run next to another debug wrapper;
 * a second launch with the same identifier forwards to the first and exits.
 */
export function wrapperIdentifier(configIdentifier, override) {
  if (override === undefined) return configIdentifier;
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(override)) {
    throw new Error('--identifier must be a reverse-domain identifier');
  }
  return override;
}

/** The origin from the wrapper log's `sidecar ready origin=...` line. */
export function parseReadyOrigin(logText) {
  const match = /sidecar ready origin=(http:\/\/127\.0\.0\.1:\d{1,5})(?:\s|$)/.exec(
    logText,
  );
  return match ? match[1] : null;
}

/** The `window origin=... route=...` line the wrapper logs when it opens. */
export function parseWindowLine(logText) {
  const match =
    /window origin=(http:\/\/127\.0\.0\.1:\d{1,5}) route=(\/[A-Za-z0-9._~\/-]*)/.exec(
      logText,
    );
  return match ? { origin: match[1], route: match[2] } : null;
}

/**
 * True when `text` holds a 64-character hex run: the shape of the per-launch
 * owner-link secret (32 random bytes, lowercase hex).
 */
export function containsLaunchSecretShape(text) {
  return /(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/.test(String(text));
}

/**
 * The one-time token in a `/setup?token=...` Location, or null when the value
 * is not exactly that shape (a different path, extra parameters, an absolute
 * URL to another host).
 */
export function tokenFromSetupLocation(location) {
  if (typeof location !== 'string') return null;
  const match = /^\/setup\?token=([A-Za-z0-9_%.~-]{16,})$/.exec(location);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Replace every occurrence of each secret, so a message is safe to print. */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Processes whose executable path or command line mentions `dir`, from
 * `ps -axo pid=,args=` output (POSIX) or a JSON list of
 * `{ ProcessId, ExecutablePath, CommandLine }` (Windows).
 */
export function processesUnder(listing, dir, format) {
  if (format === 'json') {
    const parsed = JSON.parse(listing || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row) =>
        `${row.ExecutablePath ?? ''} ${row.CommandLine ?? ''}`.includes(dir),
      )
      .map((row) => Number(row.ProcessId));
  }
  const found = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && match[2].includes(dir)) found.push(Number(match[1]));
  }
  return found;
}

/**
 * Tauri resolves the resource directory of a non-installed build to the
 * executable's directory only when that directory is `target/<profile>` and
 * holds a `.cargo-lock` (tauri-utils `resource_dir`; Windows always does). The
 * stage reproduces exactly that layout.
 */
export const STAGE_RUN_DIR = ['target', 'debug'];
export const CARGO_LOCK = '.cargo-lock';

/** Where each bundle part goes next to the copied wrapper. */
export function stagePlan({ productId, triple, windows }) {
  const suffix = windows ? '.exe' : '';
  return {
    sidecarFrom: `binaries/${productId}-node-${triple}${suffix}`,
    sidecarTo: `${productId}-node${suffix}`,
    resourcesFrom: 'resources',
  };
}

// ---------------------------------------------------------------------------
// Impure parts
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { timeoutMs: 120_000, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--wrapper') options.wrapper = value();
    else if (flag === '--bundle') options.bundle = value();
    else if (flag === '--triple') options.triple = value();
    else if (flag === '--timeout-ms') options.timeoutMs = Number(value());
    else if (flag === '--keep') options.keep = true;
    else if (flag === '--identifier') options.identifier = value();
    else if (flag === '--sidecar-only') options.sidecarOnly = true;
    else if (flag === '--list-route') options.listRoute = value();
    else if (flag === '--record-route') options.recordRoute = value();
    else if (flag === '--record-json') options.recordJson = value();
    else if (flag === '--report') options.report = value();
    else if (flag === '--data-parent') options.dataParent = value();
    else if (flag === '--database-file') options.databaseFile = value();
    else if (flag === '--sign-out-route') options.signOutRoute = value();
    else throw new Error(`unknown argument ${flag}`);
  }
  for (const required of options.sidecarOnly ? ['bundle', 'triple', 'listRoute', 'dataParent'] : ['wrapper', 'bundle', 'triple']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  if (options.databaseFile && !/^[A-Za-z0-9_-]+\.(?:sqlite|db)$/.test(options.databaseFile)) throw new Error('--database-file must be a database basename');
  if (Boolean(options.recordRoute) !== Boolean(options.recordJson)) throw new Error('--record-route and --record-json must be used together');
  return options;
}

function get(origin, path, headers = {}) {
  return new Promise((resolveGet, rejectGet) => {
    const url = new URL(path, origin);
    const request = http.request(
      {
        host: '127.0.0.1',
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, ...headers },
        timeout: 10_000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolveGet({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('request timed out')));
    request.on('error', rejectGet);
    request.end();
  });
}

function listProcesses() {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8' },
    );
    return { text: result.stdout ?? '', format: 'json' };
  }
  const result = spawnSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' });
  return { text: result.stdout ?? '', format: 'ps' };
}

async function waitFor(check, timeoutMs, what, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(pollMs);
  }
}

function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function directoryHasFiles(dir) {
  try {
    return readdirSync(dir, { recursive: true }).length > 0;
  } catch {
    return false;
  }
}

/** Exercise the actual manifest/executable without a display or vendor calls. */
export async function smokeSidecar(options) {
  const { buildSidecarEnv } = await import('../../dist/index.js');
  const { createNodeMeasureSeams, stopMeasuredProcess } = await import('../../dist/bundler.js');
  const seams = createNodeMeasureSeams();
  const bundle = resolve(options.bundle);
  const report = JSON.parse(readFileSync(join(bundle, 'bundle-report.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(bundle, 'resources/sidecar-manifest.json'), 'utf8'));
  const resources = join(bundle, 'resources');
  const plan = stagePlan({ productId: report.product.productId, triple: options.triple, windows: process.platform === 'win32' });
  mkdirSync(options.dataParent, { recursive: true, mode: 0o700 });
  const scratch = realpathSync(mkdtempSync(join(options.dataParent, 'sidecar-smoke-')));
  const data = join(scratch, 'data');
  const results = [];
  let recordId;
  let child;
  let failure;
  try {
    for (let run = 0; run < 2; run += 1) {
      const port = await seams.freePort();
      if (port <= 4900) throw new Error('the free port must be above 4900');
      const secret = randomBytes(32).toString('hex');
      const origin = `http://127.0.0.1:${port}`;
      const env = buildSidecarEnv(manifest, { port, dataDirectory: data, ownerLinkSecret: secret }, {});
      // HOME is needed for CLI detection, never for the location of app data.
      env.HOME = scratch;
      env.PATH = process.env.PATH;
      const started = seams.now();
      child = seams.spawn({ command: join(bundle, plan.sidecarFrom), args: manifest.args, cwd: manifest.workingDirectory === 'app' ? join(resources, 'app') : resources, env });
      let exited = false;
      child.exit.then(() => { exited = true; });
      await waitFor(async () => {
        if (exited) throw new Error('packaged sidecar exited before health');
        return (await seams.health(`${origin}${manifest.healthRoute}`, 500)) === 200;
      }, options.timeoutMs ?? 120000, 'packaged sidecar health', 20);
      const firstHttpMs = seams.now() - started;
      let tableCount;
      if (options.databaseFile) {
        const { DatabaseSync } = await import('node:sqlite');
        const database = new DatabaseSync(join(data, options.databaseFile), { readOnly: true });
        try {
          tableCount = Number(database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().count);
        } finally { database.close(); }
      }
      const request = async (path, init = {}) => {
        try {
          return await fetch(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(30000), ...init });
        } catch {
          throw new Error('packaged sidecar request failed');
        }
      };
      const signedOut = await request('/setup');
      const signedOutHtml = await signedOut.text();
      if (signedOut.status !== 200 || !/reopen (?:the )?(?:desktop )?app/i.test(signedOutHtml) || /pnpm\s|name="(?:email|token)"/.test(signedOutHtml)) throw new Error('desktop signed-out page must offer reopen guidance without terminal commands or a setup form');
      if ((await request(manifest.ownerClaimRoute)).status !== 403) throw new Error('owner link accepted a missing secret');
      const owner = await request(`${manifest.ownerClaimRoute}?launch=${secret}`);
      if (owner.status !== 302) throw new Error('owner link did not sign in');
      const cookie = owner.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
      if (!cookie) throw new Error('owner session cookie missing');
      const headers = { cookie };
      if ((await request('/setup', { headers })).status !== 303) throw new Error('owner remained on setup after launch sign-in');
      let landing = await request('/', { headers });
      for (let redirects = 0; redirects < 5 && [302, 303, 307, 308].includes(landing.status); redirects += 1) {
        const location = landing.headers.get('location');
        if (!location || new URL(location, origin).origin !== origin || new URL(location, origin).pathname === '/setup') throw new Error('owner launch redirected back to setup or outside the app');
        landing = await request(new URL(location, origin).pathname + new URL(location, origin).search, { headers });
      }
      if (landing.status !== 200 || /data-owner-setup="desktop"/.test(await landing.text())) throw new Error('owner did not reach the app after launch');
      const list = await request(options.listRoute, { headers });
      if (list.status !== 200) throw new Error('authenticated REST list failed');
      await list.arrayBuffer();
      if (options.recordRoute) {
        if (run === 0) {
          const created = await request(options.recordRoute, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', origin }, body: options.recordJson });
          if (![200, 201].includes(created.status)) throw new Error(`persistence probe create failed (${created.status})`);
          const body = await created.json();
          recordId = body.data?.id ?? body.id;
          if (typeof recordId !== 'string') throw new Error('persistence probe id missing');
        } else {
          const persisted = await request(`${options.recordRoute}/${encodeURIComponent(recordId)}`, { headers });
          if (persisted.status !== 200) throw new Error('record was lost after relaunch');
          const body = await persisted.json();
          if ((body.data?.id ?? body.id) !== recordId) throw new Error('relaunch returned a different record');
        }
      }
      const interactionChecks = await options.verify?.({
        run: run + 1,
        dataDirectory: data,
        request: (path, init = {}) => request(path, { ...init, headers: { ...headers, origin, ...init.headers } }),
      });
      await sleep(5000);
      const rss = spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' });
      if (run === 0 && options.signOutRoute) {
        const signedOut = await request(options.signOutRoute, { method: 'POST', headers: { ...headers, origin } });
        if (![204, 303].includes(signedOut.status)) throw new Error('owner sign-out failed');
        const setup = await request('/setup', { headers });
        if (setup.status !== 200 || !/reopen (?:the )?(?:desktop )?app/i.test(await setup.text())) throw new Error('signed-out owner did not receive reopen guidance');
        if (![401, 403, 404].includes((await request(options.listRoute, { headers })).status)) throw new Error('signed-out session retained REST access');
      }
      results.push({ run: run + 1, firstHttpMs: Math.round(firstHttpMs), idleRssKiB: Number(rss.stdout.trim()), tableCount, health: 200, ownerSession: true, restList: 200, signedOutReopen: true, launchReachedApp: true, ...(run === 0 && options.signOutRoute ? { signedOutSessionRevoked: true } : {}), ...(interactionChecks ? { interactionChecks } : {}) });
      await stopMeasuredProcess(child, seams, 10000);
      const exitInfo = await child.exit;
      if (exitInfo?.signal === 'SIGKILL' || !(exitInfo?.code === 0 || exitInfo?.signal === 'SIGTERM')) throw new Error('sidecar did not shut down gracefully');
      child = undefined;
      if ((await seams.health(`${origin}${manifest.healthRoute}`, 500)) !== undefined) throw new Error('sidecar still responds after shutdown');
    }
  } catch (error) {
    failure = error;
  } finally {
    if (child) await stopMeasuredProcess(child, seams, 10000);
    if (!options.keep) rmSync(scratch, { recursive: true, force: true });
  }
  if (failure) throw failure;
  const result = { target: options.triple, runs: results, cleanShutdown: true, persistedRecord: Boolean(recordId), firstWindowMs: null };
  if (options.report) writeFileSync(options.report, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.sidecarOnly) return smokeSidecar(options);
  const windows = process.platform === 'win32';
  const bundle = resolve(options.bundle);
  const report = JSON.parse(readFileSync(join(bundle, 'bundle-report.json'), 'utf8'));
  const productId = report.product.productId;
  const manifest = JSON.parse(
    readFileSync(join(bundle, 'resources', 'sidecar-manifest.json'), 'utf8'),
  );
  const tauriConfig = JSON.parse(readFileSync(join(wrapperDir, 'tauri.conf.json'), 'utf8'));
  const identifier = wrapperIdentifier(tauriConfig.identifier, options.identifier);

  const dataRoot = appLocalDataDir({
    platform: process.platform,
    env: process.env,
    home: homedir(),
    identifier,
  });
  if (existsSync(dataRoot)) {
    throw new Error(
      `the wrapper data directory already exists (${dataRoot}); the smoke needs a first run from an empty one`,
    );
  }

  // The wrapper looks for the sidecar and the resources next to itself.
  const stage = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-launch-smoke-')));
  const plan = stagePlan({ productId, triple: options.triple, windows });
  const runDir = join(stage, ...STAGE_RUN_DIR);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, CARGO_LOCK), '');
  const wrapperExe = join(runDir, `smrt-desktop-wrapper${windows ? '.exe' : ''}`);
  copyFileSync(resolve(options.wrapper), wrapperExe);
  cpSync(join(bundle, plan.resourcesFrom), runDir, { recursive: true });
  copyFileSync(join(bundle, plan.sidecarFrom), join(runDir, plan.sidecarTo));
  if (!windows) {
    // Artifact transfer drops permission bits.
    chmodSync(wrapperExe, 0o755);
    chmodSync(join(runDir, plan.sidecarTo), 0o755);
  }

  const logRoot = appLogDir({ platform: process.platform, env: process.env, home: homedir(), identifier });
  const logPath = join(logRoot, 'supervisor.log');
  const secrets = [];
  let stderrTail = '';
  let child;
  let failure;
  try {
    child = spawn(wrapperExe, [], {
      cwd: runDir,
      env: { ...process.env, RUST_BACKTRACE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    // The wrapper prints one line to stderr when it cannot start at all.
    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });
    let exited = null;
    child.on('exit', (code, signal) => {
      exited = { code, signal };
    });

    const origin = await waitFor(() => {
      if (exited) throw new Error('the wrapper exited before the sidecar was ready');
      return parseReadyOrigin(readIfExists(logPath));
    }, options.timeoutMs, 'the sidecar to report ready in the wrapper log');
    console.log('sidecar ready on the loopback origin');

    const window = await waitFor(
      () => parseWindowLine(readIfExists(logPath)),
      30_000,
      'the window line in the wrapper log',
    );
    const expectedRoute = manifest.ownerClaimRoute;
    if (window.origin !== origin || window.route !== expectedRoute) {
      throw new Error('the window did not open on origin + ownerClaimRoute');
    }
    console.log(`window opened on origin + ${expectedRoute}`);

    const health = await get(origin, manifest.healthRoute);
    if (health.status !== 200) throw new Error(`health answered ${health.status}`);
    console.log('health: 200 from a first run on an empty data directory');

    const dataDir = join(dataRoot, manifest.dataDirectory);
    if (!directoryHasFiles(dataDir)) {
      throw new Error('the data directory is empty: the app created nothing');
    }
    console.log('data directory created and not empty');

    // This script is not the wrapper window, so it has no launch secret: the
    // owner link must refuse it, whatever else about the request is valid.
    const link = await get(origin, expectedRoute);
    if (link.status !== 403 || link.headers.location || link.body !== '') {
      throw new Error(
        `the owner link without the launch secret answered ${link.status}, expected an empty 403`,
      );
    }
    console.log('owner link: 403 without the launch secret');

    const wrong = await get(origin, `${expectedRoute}?launch=${'0'.repeat(64)}`);
    if (wrong.status !== 403 || wrong.headers.location || wrong.body !== '') {
      throw new Error(`a wrong launch secret got ${wrong.status} from the owner link`);
    }
    console.log('owner link: 403 for a wrong launch secret');

    const foreign = await get(origin, expectedRoute, { host: 'evil.example' });
    if (foreign.status !== 403) {
      throw new Error(`a foreign Host got ${foreign.status} from the owner link`);
    }
    console.log('owner link: 403 for a foreign Host');

    // The window signs the owner in on its own (the owner link creates the
    // owner and a session; a person never fills in a form), so a visitor
    // without a session sees no owner form and no terminal command, only the
    // "quit and reopen" wording. This script has no session, so it can only
    // observe those two pages, not the signed-in shell.
    const setup = await get(origin, '/setup');
    if (setup.status !== 200) throw new Error(`/setup answered ${setup.status}`);
    if (/pnpm /.test(setup.body) || /name="email"/.test(setup.body)) {
      throw new Error('/setup shows an owner form or a terminal command under the desktop wrapper');
    }
    console.log('setup page: 200, no owner form and no terminal command');

    const home = await get(origin, '/');
    if (home.status !== 200 || /pnpm /.test(home.body)) {
      throw new Error(`/ answered ${home.status} or shows a terminal command under the desktop wrapper`);
    }
    console.log('home page: 200, no terminal command');

    const log = readIfExists(logPath);
    if (
      containsLaunchSecretShape(log) ||
      /launch=|token=/.test(log) ||
      !/window origin=http:\/\/127\.0\.0\.1:\d{1,5} route=\//.test(log)
    ) {
      throw new Error('the wrapper log holds a secret or lacks the origin+route line');
    }
    console.log('wrapper log shows origin + route and holds no secret');

    // Quit. POSIX: the signal the wrapper turns into an orderly quit. Windows
    // has no portable graceful signal for a GUI process, so the tree is ended
    // and only "nothing left running" is checked there.
    if (windows) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    } else {
      child.kill('SIGTERM');
    }
    await waitFor(() => exited, 30_000, 'the wrapper to exit');
    if (!windows && exited.code !== 0) {
      throw new Error(`the wrapper exited with ${exited.code ?? exited.signal} after SIGTERM`);
    }
    console.log(windows ? 'wrapper ended (forced on Windows)' : 'wrapper quit cleanly');

    await sleep(1000);
    const listing = listProcesses();
    const left = processesUnder(listing.text, stage, listing.format);
    if (left.length > 0) {
      for (const pid of left) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      throw new Error(`${left.length} process(es) of the bundle are still running`);
    }
    console.log('no sidecar process left');
  } catch (error) {
    failure = error;
    const log = readIfExists(logPath);
    if (log) console.error(`--- wrapper log ---\n${redact(log, secrets)}`);
    if (stderrTail) {
      console.error(`--- wrapper stderr ---\n${redact(stderrTail, secrets)}`);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    if (!options.keep) {
      rmSync(stage, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(logRoot, { recursive: true, force: true });
    }
  }
  if (failure) {
    console.error(`launch-smoke: ${redact(failure.message, secrets)}`);
    process.exit(1);
  }
  console.log(`launch-smoke: ok (${basename(stage)})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`launch-smoke: ${error.message}`);
    process.exit(1);
  });
}
