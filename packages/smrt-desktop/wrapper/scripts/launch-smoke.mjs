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
//      answers 403 to a wrong secret and to a foreign Host, and the /setup
//      page loads;
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
    else throw new Error(`unknown argument ${flag}`);
  }
  for (const required of ['wrapper', 'bundle', 'triple']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
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

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
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

  const logPath = join(dataRoot, '.desktop-wrapper', 'supervisor.log');
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

    const setup = await get(origin, '/setup');
    if (setup.status !== 200) throw new Error(`/setup answered ${setup.status}`);
    console.log('setup page: 200');

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
