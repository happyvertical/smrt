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

import { spawnSync } from 'node:child_process';
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

function npm(args, { allowNotFound = false } = {}) {
  const result = spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowNotFound && /E404|404 Not Found/.test(result.stderr)) return null;
    throw new Error(result.stderr.trim() || `npm ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
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
function listVersions(name, registry, runNpm) {
  const raw = runNpm(
    ['view', name, 'versions', '--json', ...registryArgs(registry), '--prefer-online'],
    { allowNotFound: true },
  );
  if (raw === null || raw === '') return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function downloadTarball({ name, version, primary, runNpm, fetchImpl }) {
  const meta = JSON.parse(
    runNpm([
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
  const response = await fetchImpl(meta.tarball, {
    signal: AbortSignal.timeout(120_000),
  });
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

export async function mirrorRelease({
  packages,
  primary = primaryRegistry(),
  mirror = NPMJS_REGISTRY,
  backfill = process.env.MIRROR_BACKFILL === 'true',
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

  for (const { name } of packages) {
    let onPrimary;
    let onMirror;
    try {
      onPrimary = listVersions(name, source, runNpm);
      onMirror = listVersions(name, target, runNpm);
    } catch (error) {
      // Never guess at a registry's contents: an unreadable mirror is not an
      // empty one, and treating it as empty would try to republish everything.
      result.failed.push(`${name}: could not read versions (${error.message})`);
      continue;
    }

    const have = new Set(onMirror);
    const missing = onPrimary.filter((version) => !have.has(version));
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
        runNpm([
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
        result.failed.push(`${spec}: ${error.message.split('\n')[0]}`);
        // Later versions of this package would publish out of order and move
        // `latest` past a version that is still missing; stop this package.
        break;
      }
    }
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
      `::warning::npmjs mirror incomplete for ${result.failed.length} item(s). The release is complete on the primary registry; the next mirror run retries these without a version bump.`,
    );
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
