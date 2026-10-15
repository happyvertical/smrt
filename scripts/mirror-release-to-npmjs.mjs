#!/usr/bin/env node
// Mirrors releases from our primary registry to npmjs (#3002).
//
// A release is complete once it is on the primary. This job is a separate,
// best-effort, idempotent follow-up: for every publishable package it
// publishes to npmjs the versions the primary has that are newer than
// anything on npmjs.
//
// Two properties matter:
//  - It publishes the EXACT tarball downloaded from the primary, never a
//    rebuilt one. Consumer lockfiles pin a tarball integrity hash, so a
//    version whose bytes differed between the two registries would break
//    installs resolved against the other one.
//  - It works from the difference between the registries, not from "this
//    run's version", so a mirror that failed (npmjs down, token expired, a
//    hold on the npm account — #2998) is repaired by the next run without a
//    version bump.
//
// Packages are mirrored through a small concurrent pool (MIRROR_CONCURRENCY,
// default 6): a package's versions still publish strictly oldest first, one
// at a time, but different packages no longer wait on each other. A serial
// run of 71 packages, several of them dozens of versions behind, could not
// finish inside the job's time limit (#3963).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listPublishablePackages } from './guard-release-publish.js';
import {
  NPMJS_REGISTRY,
  normalizeRegistry,
  primaryRegistry,
  registryArgs,
} from './release-registry.mjs';

export const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 16;

// One hung npm call must not hold a pool slot until the job's own timeout
// cancels the whole run and its report with it.
const VIEW_TIMEOUT_MS = 2 * 60_000;
const PUBLISH_TIMEOUT_MS = 10 * 60_000;
const KILL_GRACE_MS = 10_000;

// Runs a command asynchronously, so the pool's workers really run side by
// side. Past `timeoutMs` the child gets SIGTERM, and SIGKILL if it is still
// there `killGraceMs` later, so even a process that ignores SIGTERM releases
// its slot and is reported as TIMEOUT.
export function runProcess(
  command,
  args,
  { timeoutMs, killGraceMs = KILL_GRACE_MS, allowNotFound = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    const termTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (timedOut) {
        const error = new Error(
          `${command} ${args[0]} was stopped (${signal ?? 'timeout'}) after ${timeoutMs / 1000}s\n${stderr.trim()}`,
        );
        error.code = 'TIMEOUT';
        reject(error);
      } else if (status === 0) {
        resolve(stdout.trim());
      } else if (allowNotFound && /E404|404 Not Found/.test(stderr)) {
        resolve(null);
      } else {
        reject(new Error(stderr.trim() || `${command} ${args.join(' ')} failed`));
      }
    });
  });
}

// Callers await this, which also accepts a synchronous fake in tests.
function npm(args, { allowNotFound = false } = {}) {
  return runProcess('npm', args, {
    timeoutMs: args[0] === 'publish' ? PUBLISH_TIMEOUT_MS : VIEW_TIMEOUT_MS,
    allowNotFound,
  });
}

export function resolveConcurrency(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY;
  return Math.min(parsed, MAX_CONCURRENCY);
}

const NPM_CODE_LINE = /^npm (?:error|ERR!) code (\S+)/;

// npm writes warnings (e.g. `[WARN] Failed to replace env in config`) ahead
// of the real error, so "first line of stderr" hid every cause in #3963.
// Pull out npm's error code and its first substantive error line instead.
export function describeNpmError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const codeLine = lines.map((line) => NPM_CODE_LINE.exec(line)).find(Boolean);
  const code =
    codeLine?.[1] ??
    (typeof error?.code === 'string' ? error.code : undefined) ??
    /\bE[A-Z][A-Z0-9_]+\b/.exec(message)?.[0] ??
    null;
  const isNoise = (line) =>
    NPM_CODE_LINE.test(line) || /^(?:npm (?:warn|WARN|notice)\b|\[WARN\])/.test(line);
  const detail =
    lines.find((line) => /^npm (?:error|ERR!)/.test(line) && !isNoise(line)) ??
    lines.find((line) => !isNoise(line)) ??
    lines[0] ??
    '';
  return { code, detail: detail.replace(/^npm (?:error|ERR!)\s*/, '') };
}

function failure(subject, error) {
  const { code, detail } = describeNpmError(error);
  return `${subject}: ${code ? `${code} — ` : ''}${detail}`;
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

// `npm view <name> versions --json` prints a bare string for a package with
// exactly one version and an array otherwise. A 404 means the package does
// not exist on that registry at all, which is a real answer ("no versions"),
// unlike a thrown read failure, which the caller must not mistake for one.
async function listVersions(name, registry, runNpm) {
  const raw = await runNpm(
    ['view', name, 'versions', '--json', ...registryArgs(registry), '--prefer-online'],
    { allowNotFound: true },
  );
  if (raw === null || raw === '') return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// npm's responses for a version number that was published and later removed.
function isPermanentlyRejected(message) {
  return /cannot publish over (the )?previously published version|cannot be republished|previously published version/i.test(
    message,
  );
}

async function shasumOn(name, version, registry, runNpm) {
  return runNpm([
    'view',
    `${name}@${version}`,
    'dist.shasum',
    ...registryArgs(registry),
    '--prefer-online',
  ]);
}

async function downloadTarball({ name, version, primary, runNpm, fetchImpl }) {
  const meta = JSON.parse(
    await runNpm([
      'view',
      `${name}@${version}`,
      'dist',
      '--json',
      ...registryArgs(primary),
      '--prefer-online',
    ]),
  );
  // The primary proxies npmjs, so a hostile or misconfigured dist.tarball
  // must not be able to make this job publish bytes fetched from elsewhere.
  if (new URL(meta.tarball).origin !== new URL(primary).origin) {
    throw new Error(
      `primary reports a tarball outside itself for ${name}@${version}: ${meta.tarball}`,
    );
  }
  // The origin check above covers only the URL we asked for. fetch follows
  // redirects by default, which would let the primary (or anything in front
  // of it) hand back bytes from another host; refuse to follow any.
  const response = await fetchImpl(meta.tarball, {
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `the primary redirected the download of ${name}@${version} (HTTP ${response.status}); refusing to follow it`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `downloading ${name}@${version} from the primary failed: HTTP ${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const shasum = createHash('sha1').update(bytes).digest('hex');
  if (shasum !== meta.shasum) {
    throw new Error(
      `${name}@${version} downloaded from the primary has sha1 ${shasum}, but the primary's metadata says ${meta.shasum}`,
    );
  }
  return bytes;
}

async function mirrorPackage({ name, version: current }, ctx) {
  const { source, target, backfill, releaseVersion, runNpm, fetchImpl, log, workDir } = ctx;
  const result = { mirrored: [], skipped: [], failed: [] };
  let onPrimary;
  let onMirror;
  try {
    onPrimary = await listVersions(name, source, runNpm);
    onMirror = await listVersions(name, target, runNpm);
  } catch (error) {
    // Never guess at a registry's contents: an unreadable mirror is not an
    // empty one, and treating it as empty would try to republish everything.
    const entry = failure(`${name}: could not read versions`, error);
    result.failed.push(entry);
    log(`❌ npmjs mirror failed: ${entry}`);
    return result;
  }

  const have = new Set(onMirror);
  const missing = onPrimary.filter((version) => !have.has(version));

  // The version lists alone cannot show that one version holds DIFFERENT
  // bytes on the two registries, which the primary's union view makes
  // possible: a version published straight to npmjs (the emergency
  // changesets mode) is "already there" to a later artifacts run, whose
  // content check then fails and publishes its own build to the primary.
  // Lockfiles resolved against one registry would break on the other, so
  // say so loudly for the version this checkout is at.
  // `current` is the checkout's version. In a release run the job is still
  // on the workflow's original commit, so that is the PREVIOUS release;
  // `releaseVersion` is the one this run just published and the one most
  // likely to have been published to npmjs separately. Check both.
  const toCompare = [...new Set([current, releaseVersion])].filter(
    (version) => version && have.has(version) && onPrimary.includes(version),
  );
  for (const version of toCompare) {
    try {
      const [primarySha, mirrorSha] = await Promise.all(
        [source, target].map((registry) => shasumOn(name, version, registry, runNpm)),
      );
      if (primarySha !== mirrorSha) {
        const entry = `${name}@${version}: DIVERGED — primary sha1 ${primarySha}, npmjs sha1 ${mirrorSha}. Same version, different bytes; bump a new version, this one cannot be reconciled`;
        result.failed.push(entry);
        log(`❌ npmjs mirror failed: ${entry}`);
      }
    } catch (error) {
      const entry = failure(`${name}@${version}: could not compare checksums`, error);
      result.failed.push(entry);
      log(`❌ npmjs mirror failed: ${entry}`);
    }
  }
  const mirrorReleases = onMirror.filter(parseVersion).sort(compareVersions);
  let highestOnMirror = mirrorReleases.at(-1);

  // Forward-only by default. The primary proxies npmjs and keeps what it
  // has cached, so a version npmjs deliberately removed can still be listed
  // here; "missing on npmjs" alone must not be enough to publish it back.
  // Versions newer than anything on npmjs can only have been released here.
  const publishable = [];
  for (const version of missing) {
    if (!parseVersion(version)) {
      result.skipped.push(`${name}@${version}: not a plain x.y.z version`);
    } else if (
      backfill ||
      !highestOnMirror ||
      compareVersions(version, highestOnMirror) > 0
    ) {
      publishable.push(version);
    } else {
      result.skipped.push(
        `${name}@${version}: older than npmjs's newest (${highestOnMirror}); set MIRROR_BACKFILL=true to fill gaps deliberately`,
      );
    }
  }
  publishable.sort(compareVersions);
  for (const version of publishable) {
    const spec = `${name}@${version}`;
    try {
      const bytes = await downloadTarball({
        name,
        version,
        primary: source,
        runNpm,
        fetchImpl,
      });
      const file = join(workDir, `${name.replace(/[@/]/g, '_')}-${version}.tgz`);
      writeFileSync(file, bytes);
      // Filling a gap below the mirror's newest version must not drag its
      // `latest` tag backwards, which a plain publish would do.
      const isNewest =
        !highestOnMirror || compareVersions(version, highestOnMirror) > 0;
      await runNpm([
        'publish',
        file,
        ...registryArgs(target),
        '--access',
        'public',
        ...(isNewest ? [] : ['--tag', 'mirror-backfill']),
      ]);
      rmSync(file, { force: true });
      if (isNewest) highestOnMirror = version;
      result.mirrored.push(spec);
      log(`🪞 Mirrored ${spec} to ${target}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // npmjs reserves an unpublished version forever. The primary still
      // lists it (it keeps what it cached), so this is what a security
      // takedown of a release looks like from here. It can never succeed:
      // record it as a permanent skip and carry on, otherwise the same
      // rejection would stop every later version of this package on every
      // run.
      if (isPermanentlyRejected(message)) {
        result.skipped.push(
          `${spec}: npmjs permanently refuses this version (it was published there before and removed); not retried`,
        );
        continue;
      }
      const entry = failure(spec, error);
      result.failed.push(entry);
      log(`❌ npmjs mirror failed: ${entry}`);
      // A transient failure: later versions of this package would publish
      // out of order and move `latest` past a version that is still
      // missing, so stop this package until the next run.
      break;
    }
  }
  return result;
}

export async function mirrorRelease({
  packages,
  primary = primaryRegistry(),
  mirror = NPMJS_REGISTRY,
  backfill = process.env.MIRROR_BACKFILL === 'true',
  releaseVersion = process.env.MIRROR_RELEASE_VERSION || undefined,
  concurrency = resolveConcurrency(process.env.MIRROR_CONCURRENCY),
  runNpm = npm,
  fetchImpl = fetch,
  log = console.log,
  workDir = mkdtempSync(join(tmpdir(), 'npm-mirror-')),
} = {}) {
  const source = normalizeRegistry(primary);
  const target = normalizeRegistry(mirror);
  const result = { mirrored: [], skipped: [], failed: [] };
  if (source === target) {
    log(`Primary and mirror are both ${source}; nothing to mirror.`);
    return result;
  }

  const ctx = { source, target, backfill, releaseVersion, runNpm, fetchImpl, log, workDir };
  // Each worker takes the next package and mirrors all of its versions in
  // order before taking another, so per-package ordering (and therefore
  // `latest`) is exactly what a serial run produces.
  const perPackage = new Array(packages.length);
  let next = 0;
  const worker = async () => {
    while (next < packages.length) {
      const index = next;
      next += 1;
      try {
        perPackage[index] = await mirrorPackage(packages[index], ctx);
      } catch (error) {
        const entry = failure(packages[index].name, error);
        log(`❌ npmjs mirror failed: ${entry}`);
        perPackage[index] = { mirrored: [], skipped: [], failed: [entry] };
      }
    }
  };
  const workers = Math.max(1, Math.min(concurrency, packages.length));
  log(`Mirroring ${packages.length} package(s) to ${target} with ${workers} worker(s).`);
  await Promise.all(Array.from({ length: workers }, worker));

  // Report in package order, not completion order, so runs stay comparable.
  for (const part of perPackage) {
    result.mirrored.push(...part.mirrored);
    result.skipped.push(...part.skipped);
    result.failed.push(...part.failed);
  }

  rmSync(workDir, { recursive: true, force: true });
  return result;
}

export function reportMirror(
  result,
  { appendSummary = appendFileSync, log = console.log, env = process.env } = {},
) {
  log(
    `Mirror result: ${result.mirrored.length} mirrored, ${result.skipped.length} skipped, ${result.failed.length} failed.`,
  );
  if (result.failed.length > 0) {
    log(
      `::warning::npmjs mirror incomplete for ${result.failed.length} item(s). The release is complete on the primary registry; the next mirror run retries transient failures without a version bump. A DIVERGED item is never retried and needs a new version.`,
    );
    for (const item of result.failed) log(`  failed: ${item}`);
  }
  if (!env.GITHUB_STEP_SUMMARY) return;
  const section = (title, items) =>
    items.length === 0 ? '' : `\n**${title}**\n\n${items.map((item) => `- ${item}`).join('\n')}\n`;
  try {
    appendSummary(
      env.GITHUB_STEP_SUMMARY,
      `\n### npmjs mirror\n${section('Mirrored', result.mirrored)}${section('Skipped', result.skipped)}${section('Failed (retried next run)', result.failed)}${result.mirrored.length + result.skipped.length + result.failed.length === 0 ? '\nnpmjs already has every version the primary has.\n' : ''}`,
    );
  } catch {
    // Reporting only; never turn a finished mirror into a failed step.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await mirrorRelease({ packages: listPublishablePackages() });
    reportMirror(result);
    // Best-effort by design: a mirror failure must not fail the release that
    // already succeeded. MIRROR_STRICT=true is for a manual repair run that
    // wants a red result when anything is still missing.
    if (result.failed.length > 0 && process.env.MIRROR_STRICT === 'true') {
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : error}`);
    process.exit(process.env.MIRROR_STRICT === 'true' ? 1 : 0);
  }
}
