#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyPublishArtifacts } from './publish-artifacts-lib.mjs';

const registry = 'https://registry.npmjs.org/';
const defaultVerificationAttempts = 6;
const defaultInitialVerificationDelayMs = 5_000;
const defaultMaxVerificationDelayMs = 30_000;

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

function existsOnRegistry(name, version, runNpm) {
  return (
    runNpm(
      [
        'view',
        `${name}@${version}`,
        'version',
        '--registry',
        registry,
        '--prefer-online',
      ],
      {
        allowNotFound: true,
      },
    ) !== null
  );
}

// A transient registry read failure here (EAI_AGAIN, a timeout, any non-404
// npm() throw) happens strictly before this run's own `npm publish` calls —
// the dedup loop below always finishes before the publish loop starts — so
// treating it as "not yet confirmed published" cannot mask a version this
// run already published. It can only cause an unnecessary publish attempt
// for a version that is, in fact, already there; npm's own publish-time
// conflict response is the authoritative fallback for that (see
// isAlreadyPublishedConflict below), and it still runs the content-identity
// check before accepting the conflict as "already published" — so a real
// different-content collision keeps aborting instead of silently skipping.
function existsOnRegistryTolerant(name, version, runNpm, log) {
  try {
    return existsOnRegistry(name, version, runNpm);
  } catch (error) {
    log(
      `⚠️ Pre-publish existence check for ${name}@${version} errored (${error instanceof Error ? error.message : error}); treating as not yet published. If it is already published, the publish attempt's own conflict response will be verified and recorded as complete instead of failing the run.`,
    );
    return false;
  }
}

// npm's own message for "this exact version is already on the registry".
// Trusting this (after a content-identity check) recovers a run whose
// pre-publish existence check missed the version because of a transient
// read failure, without trusting any other publish failure (auth, network,
// a genuinely different-content collision) as harmless.
function isAlreadyPublishedConflict(message) {
  return /cannot publish over the previously published version/i.test(
    message,
  );
}

// A version already on the registry could, in principle, have been
// published from *different* content than what this run built — e.g. two
// independent runs computing the same next version from a stale base (the
// exact "silently skip packages it thinks it already handled" failure
// #2871 warned about). Compare the registry tarball's shasum against the
// already-verified local artifact before trusting "already exists" as
// "already exists with our content" and skipping it.
function defaultVerifyExistingContentMatches(artifact, runNpm) {
  const registryShasum = runNpm(
    [
      'view',
      `${artifact.name}@${artifact.version}`,
      'dist.shasum',
      '--registry',
      registry,
      '--prefer-online',
    ],
    { allowNotFound: true },
  );
  if (registryShasum === null) {
    // Existed a moment ago, gone now (race/propagation). Do not treat as a
    // verified match; let the caller fall through to a normal publish
    // attempt instead of silently skipping unverified content.
    return false;
  }
  const localShasum = createHash('sha1')
    .update(readFileSync(artifact.path))
    .digest('hex');
  if (registryShasum !== localShasum) {
    throw new Error(
      `Refusing to treat ${artifact.name}@${artifact.version} as already published: registry tarball sha1 ${registryShasum} does not match this run's verified local artifact sha1 ${localShasum}. That version already exists with different content — bump a new version instead of reusing this one.`,
    );
  }
  return true;
}

function waitSynchronously(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

export function publishRelease(
  release,
  {
    initialVerificationDelayMs = defaultInitialVerificationDelayMs,
    log = console.log,
    maxVerificationDelayMs = defaultMaxVerificationDelayMs,
    runNpm = npm,
    verificationAttempts = defaultVerificationAttempts,
    verifyExistingContentMatches = defaultVerifyExistingContentMatches,
    wait = waitSynchronously,
  } = {},
) {
  // Verify every already-existing package's content BEFORE publishing
  // anything new. A mismatch must abort while every `npm publish` call is
  // still avoidable — checking and publishing interleaved, one artifact at
  // a time, would let earlier artifacts in the list get newly (and
  // irreversibly) published before a later artifact's mismatch is ever
  // discovered, widening the blast radius of an abort for no benefit.
  const alreadyPublished = new Set();
  for (const artifact of release.packages) {
    if (
      existsOnRegistryTolerant(artifact.name, artifact.version, runNpm, log) &&
      verifyExistingContentMatches(artifact, runNpm)
    ) {
      alreadyPublished.add(artifact.name);
    }
  }

  for (const artifact of release.packages) {
    if (alreadyPublished.has(artifact.name)) {
      log(`↪ ${artifact.name}@${artifact.version} already exists (content verified)`);
      continue;
    }
    log(`📤 Publishing ${artifact.name}@${artifact.version}`);
    try {
      runNpm([
        'publish',
        artifact.path,
        '--registry',
        registry,
        '--access',
        'public',
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The dedup check above can miss an already-published version during
      // a transient registry read failure; npm's own publish-time conflict
      // is authoritative. Still run the same content-identity check the
      // dedup pass uses before accepting it — a genuine different-content
      // collision (the #2871 "different base" scenario) must keep failing,
      // not silently skip.
      if (
        !isAlreadyPublishedConflict(message) ||
        !verifyExistingContentMatches(artifact, runNpm)
      ) {
        throw error;
      }
      log(
        `↪ ${artifact.name}@${artifact.version} was already published (npm reported a publish conflict); content verified matching, treating as already complete.`,
      );
    }
  }

  // Once `npm publish` has run (or been skipped as an already-verified
  // match) for every package above, the release is already irreversible.
  // A transient registry error here (5xx, timeout) is exactly as harmless
  // to swallow as a clean "not found yet": either way we cannot currently
  // confirm the read path, and only a thrown error — never a read-path
  // hiccup — should be allowed to abort a step that still has to record
  // the release below.
  function stillUnconfirmed(artifact) {
    try {
      return !existsOnRegistry(artifact.name, artifact.version, runNpm);
    } catch (error) {
      log(
        `⚠️ Registry verification check for ${artifact.name}@${artifact.version} errored (${error instanceof Error ? error.message : error}); treating as not yet confirmed.`,
      );
      return true;
    }
  }

  let missing = [];
  for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
    missing = release.packages.filter(stillUnconfirmed);

    if (missing.length === 0) break;
    if (attempt === verificationAttempts) continue;

    const delayMs = Math.min(
      initialVerificationDelayMs * 2 ** (attempt - 1),
      maxVerificationDelayMs,
    );
    log(
      `⏳ Registry verification attempt ${attempt}/${verificationAttempts} missing ${missing
        .map((entry) => entry.name)
        .join(', ')}; retrying in ${delayMs}ms`,
    );
    wait(delayMs);
  }

  // Every `npm publish` call above either succeeded or threw, so by this
  // point the release is already on the registry as far as npm is
  // concerned — publication is irreversible and complete. A `npm view`
  // miss here reflects registry read-path propagation lag, not a failed
  // publish, so it must never fail the run and strand the commit/tag that
  // depend on this step succeeding. Report it and let the caller record
  // the release; a later, separate check can keep confirming propagation
  // without gating anything.
  if (missing.length > 0) {
    log(
      `⚠️ Registry verification did not observe ${missing
        .map((entry) => entry.name)
        .join(', ')} after ${verificationAttempts} attempts. Publication already happened and is irreversible; treating this as propagation lag, not a failure. Recording the release and continuing.`,
    );
  } else {
    log(
      `✅ Published and verified ${release.packages.length} artifacts for ${release.releaseVersion}`,
    );
  }

  return {
    releaseVersion: release.releaseVersion,
    published: release.packages.map((artifact) => artifact.name),
    unverified: missing.map((artifact) => artifact.name),
  };
}

export function publishValidatedArtifacts(
  artifactDir,
  { verify = verifyPublishArtifacts, ...options } = {},
) {
  return publishRelease(verify(artifactDir), options);
}

// The publish already succeeded and is irreversible by the time this runs
// (see publishRelease above). Writing the advisory job-summary note is pure
// reporting on top of that success — if GITHUB_STEP_SUMMARY is missing,
// unwritable, or over the runner's size cap, that must never turn a
// successful publish into a failed step, so the write is best-effort and
// its own errors are swallowed (logged, not thrown).
export function reportUnverifiedPackages(
  result,
  { appendSummary = appendFileSync, log = console.log, warn = console.warn } = {},
) {
  if (result.unverified.length === 0) return;

  // Advisory only: the packages are already published and that cannot
  // be undone. Surface it as a workflow annotation so it stays visible
  // without failing a run whose commit/tag recording must still happen.
  log(
    `::warning::Registry read-path did not confirm ${result.unverified.join(', ')} for v${result.releaseVersion} within the retry budget; publication is already complete on npm. If this persists after the run finishes, re-check manually — do not re-run the batch.`,
  );

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  try {
    appendSummary(
      summaryPath,
      `\n### ⚠️ Registry verification lag for v${result.releaseVersion}\n\nNot yet visible via \`npm view\` after retries (publish already succeeded):\n\n${result.unverified.map((name) => `- ${name}`).join('\n')}\n`,
    );
  } catch (error) {
    warn(
      `⚠️ Could not write the advisory job-summary note for v${result.releaseVersion} (${error instanceof Error ? error.message : error}); publication already succeeded and is unaffected.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const artifactDir = process.argv[2];
    if (!artifactDir) {
      throw new Error(
        'Usage: publish-validated-artifacts.mjs <artifact-directory>',
      );
    }
    const result = publishValidatedArtifacts(artifactDir);
    reportUnverifiedPackages(result);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
