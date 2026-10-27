#!/usr/bin/env node
/** Trusted recovery only: consume the original candidate and packs, never rebuild. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createController, createForge, REPOSITORY } from './release-admission.mjs';
import { createReleaseAdmissionStore } from './release-admission-store.mjs';
import { validateReleaseAdmissionState, validateReleaseRecoveryArtifacts } from './release-admission-state.mjs';
import { verifyPublishArtifacts } from './publish-artifacts-lib.mjs';
import { publishRelease } from './publish-validated-artifacts.mjs';
import { pushReleaseRefs } from './push-release-refs.mjs';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const RELEASE_WORKFLOW = '.github/workflows/on-merge-main.yml';
const check = (condition, message) => { if (!condition) throw new Error(message); };
const sameOwner = (left, right) => left?.runId === right?.runId && left?.runAttempt === right?.runAttempt;
const gitEnv = () => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' });
const gitArgs = (args) => ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...args];
function git(cwd, ...args) {
  return execFileSync('git', gitArgs(args), { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Bound the downloaded bytes before parsing the ZIP; never forward credentials. */
export async function downloadRecoveryArtifact(artifact, { token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`, {
    redirect: 'manual', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  check(response.status === 302, 'GitHub did not supply an artifact download redirect');
  const location = new URL(response.headers.get('location'));
  check(location.protocol === 'https:' && !location.username && !location.password, 'Invalid artifact download origin');
  const archive = await fetchImpl(location.href, { redirect: 'error' });
  check(archive.ok && archive.body, 'Unable to download original recovery artifact');
  const chunks = [];
  let size = 0;
  for await (const chunk of archive.body) {
    size += chunk.length;
    check(size <= MAX_ARCHIVE_BYTES, 'Recovery artifact archive exceeds size bound');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Python stdlib only; reject links, traversal, duplicates and oversized expansion. */
export function extractRecoveryArchive(zipPath, destination) {
  execFileSync('python3', ['-I', '-c', `
import os, pathlib, stat, sys, zipfile
root = pathlib.Path(sys.argv[2])
root.mkdir(mode=0o700, parents=True, exist_ok=False)
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 20000 or sum(e.file_size for e in entries) > 2 * 1024**3:
        raise ValueError('Recovery ZIP expansion exceeds bounds')
    seen = set()
    for entry in entries:
        name = entry.filename
        parts = name.rstrip('/').split('/')
        mode = entry.external_attr >> 16
        if not name or len(name) > 4096 or '\\\\' in name or ':' in name or any(p in ('', '.', '..') for p in parts):
            raise ValueError('Unsafe recovery ZIP path')
        if name.rstrip('/') in seen or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
            raise ValueError('Duplicate or non-regular recovery ZIP entry')
        seen.add(name.rstrip('/'))
        target = root.joinpath(*parts)
        if entry.is_dir():
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
        else:
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.open(entry) as source, open(target, 'xb') as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk: break
                    output.write(chunk)
`, zipPath, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Restore objects without checking out or executing any candidate-owned tooling. */
export function restoreRecoveryCandidate({ repoRoot, bundlePath, candidateRoot, release }) {
  const heads = git(repoRoot, 'bundle', 'list-heads', bundlePath);
  check(heads === `${release.releaseCommitSha} HEAD`, 'Recovery bundle HEAD differs from original release commit');
  git(repoRoot, 'bundle', 'verify', bundlePath);
  git(repoRoot, 'fetch', '--no-tags', '--no-write-fetch-head', bundlePath, 'HEAD');
  check(git(repoRoot, 'rev-list', '--parents', '-n', '1', release.releaseCommitSha) === `${release.releaseCommitSha} ${release.snapshotSha}`, 'Recovery commit must have exactly the frozen source parent');
  // The trusted state binds the commit SHA and the authenticated archive binds
  // its Git objects. Git verifies those object hashes locally, even when this
  // candidate has never been pushed and the GitHub commit API returns 404.
  check(git(repoRoot, 'cat-file', '-t', release.releaseCommitSha) === 'commit' && /^[a-f0-9]{40}$/.test(git(repoRoot, 'rev-parse', `${release.releaseCommitSha}^{tree}`)), 'Recovery bundle does not contain the bound release commit/tree');
  const filters = spawnSync('git', ['config', '--local', '--get-regexp', '^filter\\.'], { cwd: repoRoot, env: gitEnv(), encoding: 'utf8' });
  check(filters.status === 1, 'Recovery refuses configured checkout filters; candidate code must never execute');
  git(repoRoot, 'worktree', 'add', '--detach', '--no-checkout', candidateRoot, release.releaseCommitSha);
  try {
    // No install, pack, lifecycle, package script or code from the candidate runs.
    git(candidateRoot, 'reset', '--hard', release.releaseCommitSha);
    check(git(candidateRoot, 'rev-parse', 'HEAD') === release.releaseCommitSha, 'Recovered candidate HEAD mismatch');
    const manifest = join(candidateRoot, 'package.json');
    check(lstatSync(manifest).isFile() && JSON.parse(readFileSync(manifest, 'utf8')).version === release.version, 'Recovered candidate version mismatch');
    const localTag = spawnSync('git', gitArgs(['show-ref', '--verify', '--quiet', release.ref]), { cwd: candidateRoot, env: gitEnv(), encoding: 'utf8' });
    if (localTag.status === 1) git(candidateRoot, '-c', 'tag.gpgSign=false', 'tag', `v${release.version}`, release.releaseCommitSha);
    else check(localTag.status === 0 && git(candidateRoot, 'rev-parse', release.ref) === release.releaseCommitSha, 'Local recovery tag differs from original release');
    return { candidateRoot, cleanup: () => git(repoRoot, 'worktree', 'remove', '--force', candidateRoot) };
  } catch (error) {
    git(repoRoot, 'worktree', 'remove', '--force', candidateRoot);
    throw error;
  }
}

function trustedNpm(repoRoot) {
  return (args, { allowNotFound = false } = {}) => {
    const result = spawnSync('npm', [...args, '--ignore-scripts'], {
      cwd: repoRoot, env: { ...process.env, npm_config_ignore_scripts: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (allowNotFound && /E404|404 Not Found/.test(result.stderr)) return null;
      throw new Error(result.stderr?.trim() || 'Trusted npm recovery command failed');
    }
    return result.stdout.trim();
  };
}

// Candidate Git trees may contain symlinks even though the outer ZIP rejects
// them. Never follow one while reading manifests in a privileged control job.
function checkCandidateMetadata(root) {
  for (const directory of ['.changeset', 'packages']) {
    check(lstatSync(join(root, directory), { throwIfNoEntry: false })?.isDirectory(), 'Candidate metadata directory must not be a symlink');
  }
  check(lstatSync(join(root, '.changeset', 'config.json'), { throwIfNoEntry: false })?.isFile(), 'Candidate metadata config must be a regular file');
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = lstatSync(join(root, 'packages', entry.name, 'package.json'), { throwIfNoEntry: false });
    check(!manifest || manifest.isFile(), 'Candidate package metadata must be a regular file');
  }
}

/** Immutable artifact consumption shared by isolated authorization and publication.
 * No candidate-owned code, hooks, filters, installs or npm lifecycle scripts run. */
export async function withReleaseArtifacts({ forge, owner, release, repoRoot, readToken, io = {}, consume }) {
  const bound = validateReleaseRecoveryArtifacts(release.recoveryArtifacts);
  const expectedNames = [`release-candidate-${owner.runId}-${owner.runAttempt}`, ...[1, 2].map((shard) => `publish-release-pack-${owner.runId}-${owner.runAttempt}-${shard}`)];
  check(JSON.stringify(bound.map((artifact) => artifact.name).sort()) === JSON.stringify([...expectedNames].sort()), 'Original artifact inventory mismatch');
  const metadata = await Promise.all(bound.map(async (artifact) => {
    const fetched = await forge.request(`actions/artifacts/${artifact.id}`);
    check(fetched.id === artifact.id && fetched.name === artifact.name && fetched.digest === artifact.digest && fetched.expired === false && fetched.workflow_run?.id === owner.runId && Number.isSafeInteger(fetched.size_in_bytes) && fetched.size_in_bytes > 0 && fetched.size_in_bytes <= MAX_ARCHIVE_BYTES, 'Original recovery artifact metadata/identity/expiry mismatch');
    return fetched;
  }));
  const temporary = mkdtempSync(join(tmpdir(), 'smrt-release-recovery-'));
  let restored;
  try {
    const artifactDir = join(temporary, 'packs');
    mkdirSync(artifactDir);
    for (const artifact of metadata) {
      const bytes = await (io.download ?? downloadRecoveryArtifact)(artifact, { token: readToken });
      check(Buffer.isBuffer(bytes) && bytes.length === artifact.size_in_bytes && bytes.length <= MAX_ARCHIVE_BYTES && `sha256:${createHash('sha256').update(bytes).digest('hex')}` === artifact.digest, 'Original recovery ZIP digest/size mismatch');
      const zipPath = join(temporary, `${artifact.id}.zip`);
      writeFileSync(zipPath, bytes, { mode: 0o600 });
      const destination = artifact.name === expectedNames[0] ? join(temporary, 'candidate-artifact') : join(artifactDir, String(artifact.id));
      await (io.extract ?? extractRecoveryArchive)(zipPath, destination);
    }
    const bundlePath = join(temporary, 'candidate-artifact', 'release-candidate.bundle');
    check(JSON.stringify(readdirSync(join(temporary, 'candidate-artifact'))) === JSON.stringify(['release-candidate.bundle']) && lstatSync(bundlePath).isFile(), 'Original release candidate bundle is missing');
    restored = await (io.restore ?? restoreRecoveryCandidate)({ repoRoot, bundlePath, candidateRoot: join(temporary, 'candidate'), release });
    checkCandidateMetadata(restored.candidateRoot);
    const verify = (directory) => (io.verify ?? verifyPublishArtifacts)(directory, restored.candidateRoot);
    const inventory = verify(artifactDir);
    check(inventory.releaseVersion === release.version && inventory.packages.length > 0, 'Recovered artifact release version/inventory mismatch');
    return await consume({ artifactDir, inventory, verify, restored });
  } finally {
    try { await restored?.cleanup(); } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}

/** All injected IO belongs to the trusted adapter/tests, never to artifact data. */
export async function recoverRelease({ store, forge, owner: requestedOwner, repoRoot = process.cwd(), readToken, writeToken, activeOwner, io = {} }) {
  const current = (await store.read())?.state;
  validateReleaseAdmissionState(current);
  check(current.repository === REPOSITORY && ['publishing', 'recovery'].includes(current.phase) && current.release, 'No owned publication is available for recovery');
  const { owner, release } = current;
  check(!requestedOwner || sameOwner(requestedOwner, owner), 'Recovery owner differs from original run/attempt');
  const bound = validateReleaseRecoveryArtifacts(release.recoveryArtifacts);
  const expectedNames = [`release-candidate-${owner.runId}-${owner.runAttempt}`, ...[1, 2].map((shard) => `publish-release-pack-${owner.runId}-${owner.runAttempt}-${shard}`)];
  check(JSON.stringify(bound.map((artifact) => artifact.name).sort()) === JSON.stringify([...expectedNames].sort()), 'Original recovery artifact inventory mismatch');
  const run = await forge.request(`actions/runs/${owner.runId}/attempts/${owner.runAttempt}`);
  const workflow = await forge.request(`actions/workflows/${run.workflow_id}`);
  check(run.id === owner.runId && run.run_attempt === owner.runAttempt && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY && run.path === RELEASE_WORKFLOW && workflow.path === RELEASE_WORKFLOW, 'Unverifiable original release run/attempt');
  if (activeOwner) {
    check(sameOwner(activeOwner, owner) && current.phase === 'publishing' && run.status === 'in_progress', 'Active publisher must be the exact authorized current run/attempt');
  } else check(run.status === 'completed', 'Originating release attempt must be completed before recovery');
  async function refs() {
    const [main, tag] = await Promise.all([forge.main(), forge.request(`git/ref/tags/v${release.version}`, { missing: true })]);
    check(main.protected === true && [release.snapshotSha, release.releaseCommitSha].includes(main.commit?.sha), 'Main differs from frozen source or original release');
    check(tag === null || (tag.object?.type === 'commit' && tag.object.sha === release.releaseCommitSha), 'Release tag differs from original release');
    return main.commit.sha === release.releaseCommitSha && tag !== null;
  }
  await refs();
  return withReleaseArtifacts({ forge, owner, release, repoRoot, readToken, io,
    consume: async ({ artifactDir, inventory, verify, restored }) => {
    const push = (dryRun) => (io.push ?? pushReleaseRefs)({ dryRun, baseBranch: 'main', githubToken: writeToken, releaseVersion: release.version,
      spawn: (command, args, options) => spawnSync(command, gitArgs(['-c', `remote.origin.url=https://github.com/${REPOSITORY}.git`, '-c', `remote.origin.pushurl=https://github.com/${REPOSITORY}.git`, '-c', 'push.followTags=false', '-c', 'credential.helper=', ...args]), { ...options, cwd: restored.candidateRoot, env: { ...options.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }),
    });
    await refs();
    await push(true); // Permission/ref preflight precedes every possible npm write.
    await refs();
    await (io.publish ?? publishRelease)(inventory, { runNpm: trustedNpm(repoRoot) });
    if (!(await refs())) await push(false);
    const latest = (await store.read())?.state;
    check(sameOwner(latest?.owner, owner) && ['publishing', 'recovery'].includes(latest?.phase) && JSON.stringify(latest.release) === JSON.stringify(release), 'Recovery ownership/release changed during resume');
    const controller = io.controller ?? createController({ store, forge, verifyArtifacts: verify });
    return await controller.complete(owner, { artifactDir });
    },
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  check(env.GITHUB_REPOSITORY === REPOSITORY, 'Wrong recovery repository');
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    check(['--owner-run-id', '--owner-run-attempt'].includes(argv[index]) && /^\d+$/.test(argv[index + 1] ?? '') && !Object.hasOwn(options, argv[index]), 'Expected unique --owner-run-id/--owner-run-attempt integers only');
    options[argv[index]] = Number(argv[index + 1]);
    check(Number.isSafeInteger(options[argv[index]]) && options[argv[index]] > 0, 'Invalid original recovery owner');
  }
  const supplied = Object.keys(options).length;
  check(supplied === 0 || supplied === 2, 'Both original owner run ID and attempt are required together');
  const forge = createForge({ readToken: env.GITHUB_TOKEN, writeToken: env.RELEASE_GITHUB_TOKEN });
  return await recoverRelease({
    store: createReleaseAdmissionStore({ repository: REPOSITORY, token: env.RELEASE_GITHUB_TOKEN }), forge,
    owner: supplied ? { runId: options['--owner-run-id'], runAttempt: options['--owner-run-attempt'] } : undefined,
    repoRoot: resolve(process.cwd()), readToken: env.GITHUB_TOKEN, writeToken: env.RELEASE_GITHUB_TOKEN,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Release recovery remains closed: ${error.message}`); process.exitCode = 1; });
}
