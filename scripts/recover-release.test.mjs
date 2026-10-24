import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REPOSITORY } from './release-admission.mjs';
import { createReleaseAdmissionState, transitionReleaseAdmission as transition } from './release-admission-state.mjs';
import { verifyPublishArtifacts } from './publish-artifacts-lib.mjs';
import { publishRelease } from './publish-validated-artifacts.mjs';
import { downloadRecoveryArtifact, extractRecoveryArchive, recoverRelease, restoreRecoveryCandidate, main } from './recover-release.mjs';

const owner = { runId: 42, runAttempt: 2 };
const version = '2.0.0';
function zip(files) {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-zip-'));
  try {
    const output = join(directory, 'fixture.zip');
    const listing = files.map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')]);
    execFileSync('python3', ['-I', '-c', 'import base64,json,sys,zipfile,warnings\nwarnings.simplefilter("ignore",UserWarning)\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name, data in json.loads(sys.argv[2]): z.writestr(name,base64.b64decode(data))', output, JSON.stringify(listing)]);
    return readFileSync(output);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function fixture({ wrongVersion = false, wrongBundle = false, wrongParent = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'smrt-recovery-test-'));
  const repoRoot = join(directory, 'repo');
  mkdirSync(repoRoot);
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Recovery Test'); git('config', 'user.email', 'recovery@example.invalid');
  const marker = join(directory, 'candidate-code-ran');
  const manifest = (name, current) => JSON.stringify({ name, version: current, publishConfig: { access: 'public' }, scripts: { prepublishOnly: `node -e 'require("fs").writeFileSync("${marker}","bad")'` } });
  mkdirSync(join(repoRoot, '.changeset'));
  writeFileSync(join(repoRoot, '.changeset/config.json'), JSON.stringify({ fixed: [['@fixture/a', '@fixture/b']] }));
  for (const name of ['a', 'b']) mkdirSync(join(repoRoot, 'packages', name), { recursive: true });
  function versions(current) {
    writeFileSync(join(repoRoot, 'package.json'), manifest('root', current));
    for (const name of ['a', 'b']) writeFileSync(join(repoRoot, 'packages', name, 'package.json'), manifest(`@fixture/${name}`, current));
  }
  versions('1.0.0'); git('add', '.'); git('commit', '-m', 'source');
  const snapshotSha = git('rev-parse', 'HEAD');
  git('checkout', '--detach');
  if (wrongParent) git('commit', '--allow-empty', '-m', 'unexpected intermediate parent');
  versions(wrongVersion ? '3.0.0' : version); git('add', '.'); git('commit', '-m', 'release');
  const releaseCommitSha = git('rev-parse', 'HEAD');
  const bundle = join(directory, 'original.bundle');
  if (wrongBundle) git('bundle', 'create', bundle, 'main');
  else git('bundle', 'create', bundle, 'HEAD', `^${snapshotSha}`);
  git('checkout', 'main');
  // A normal checkout hook would execute code. The trusted adapter disables it.
  const hooks = join(directory, 'hooks'); mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git('config', 'core.hooksPath', hooks);
  const archives = new Map();
  const names = [`release-candidate-${owner.runId}-${owner.runAttempt}`, ...[1, 2].map((shard) => `publish-release-pack-${owner.runId}-${owner.runAttempt}-${shard}`)];
  archives.set(1, zip([['release-candidate.bundle', readFileSync(bundle)]]));
  for (const [index, name] of ['a', 'b'].entries()) {
    const bytes = Buffer.from(`original immutable ${name} tarball`);
    archives.set(index + 2, zip([
      [`${name}.tgz`, bytes],
      [`manifest-${index + 1}-of-2.json`, JSON.stringify({ schemaVersion: 1, releaseVersion: version, packages: [{ name: `@fixture/${name}`, version, filename: `${name}.tgz`, sha256: createHash('sha256').update(bytes).digest('hex') }] })],
    ]));
  }
  const recoveryArtifacts = names.map((name, index) => ({ id: index + 1, name, digest: `sha256:${createHash('sha256').update(archives.get(index + 1)).digest('hex')}` }));
  const release = { snapshotSha, releaseCommitSha, version, ref: `refs/tags/v${version}`, recoveryArtifacts };
  let state = createReleaseAdmissionState({ repository: REPOSITORY });
  state = transition(state, { type: 'close', owner, nowMs: 0, timeoutMs: 1000 });
  state = transition(state, { type: 'freeze', owner, nowMs: 1, main: { authenticated: true, repository: REPOSITORY, protected: true, ref: 'refs/heads/main', sha: snapshotSha } });
  state = transition(state, { type: 'beginPublishing', owner, nowMs: 2, release, qualification: { authenticated: true, repository: REPOSITORY, success: true, snapshotSha } });
  state = transition(state, { type: 'abort', owner });
  const events = [];
  let mainSha = snapshotSha;
  let tag = null;
  let restoredRoot;
  const responses = new Map([
    [`actions/runs/${owner.runId}/attempts/${owner.runAttempt}`, { id: owner.runId, run_attempt: owner.runAttempt, status: 'completed', workflow_id: 3, path: '.github/workflows/on-merge-main.yml', repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY } }],
    ['actions/workflows/3', { path: '.github/workflows/on-merge-main.yml' }],
    ...recoveryArtifacts.map((artifact) => [`actions/artifacts/${artifact.id}`, { ...artifact, workflow_run: { id: owner.runId }, expired: false, size_in_bytes: archives.get(artifact.id).length }]),
  ]);
  const forge = {
    async request(path) {
      if (path === `git/ref/tags/v${version}`) return structuredClone(tag);
      assert.ok(responses.has(path), `Unexpected network request: ${path}`);
      return structuredClone(responses.get(path));
    },
    async main() { return { protected: true, commit: { sha: mainSha } }; },
  };
  const published = new Map();
  let failPackage;
  let failCompletion = false;
  const io = {
    async download(artifact) { events.push(`download:${artifact.id}`); return archives.get(artifact.id); },
    extract(path, destination) { events.push('extract'); extractRecoveryArchive(path, destination); },
    restore(options) { const result = restoreRecoveryCandidate(options); restoredRoot = result.candidateRoot; return result; },
    push({ dryRun }) { events.push(dryRun ? 'preflight' : 'push'); if (!dryRun) { mainSha = releaseCommitSha; tag = { object: { type: 'commit', sha: releaseCommitSha } }; } },
    publish(inventory) {
      events.push('publish');
      const byPath = new Map(inventory.packages.map((artifact) => [artifact.path, artifact]));
      return publishRelease(inventory, {
        log() {}, verificationAttempts: 1,
        runNpm(args) {
          if (args[0] === 'view') {
            const name = args[1].slice(0, args[1].lastIndexOf('@'));
            if (!published.has(name)) return null;
            return args[2] === 'version' ? version : createHash('sha1').update(published.get(name)).digest('hex');
          }
          assert.equal(args[0], 'publish', 'Recovery never installs or executes candidate tooling');
          const artifact = byPath.get(args[1]);
          events.push(`npm:${artifact.name}`);
          if (failPackage === artifact.name) { failPackage = undefined; throw new Error('simulated partial npm failure'); }
          published.set(artifact.name, readFileSync(artifact.path));
          return '';
        },
      });
    },
    controller: { async complete(actualOwner, { artifactDir }) {
      events.push('complete'); assert.deepEqual(actualOwner, owner);
      assert.equal(verifyPublishArtifacts(artifactDir, restoredRoot).releaseVersion, version);
      if (failCompletion) { failCompletion = false; throw new Error('completion unavailable'); }
      state = transition(state, { type: 'complete', owner, release, evidence: { authenticated: true, repository: REPOSITORY, ...release, refSha: releaseCommitSha, sourceParentSha: snapshotSha, registries: { primary: 'success' } } });
      return state;
    } },
  };
  const store = { async read() { return { state: structuredClone(state) }; } };
  return {
    directory, marker, repoRoot, git, release, owner, responses, archives, events, published, io,
    run: (extra = {}) => recoverRelease({ store, forge, repoRoot, owner, readToken: 'read', writeToken: 'write', io, ...extra }),
    get state() { return state; },
    set mainSha(value) { mainSha = value; }, set tag(value) { tag = value; },
    set failPackage(value) { failPackage = value; }, set failCompletion(value) { failCompletion = value; },
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test('partial publication resumes exact original artifacts without rebuilding or executing candidate code', async () => {
  const f = fixture();
  try {
    f.failPackage = '@fixture/b';
    await assert.rejects(f.run(), /partial npm failure/);
    assert.equal(f.state.phase, 'recovery');
    assert.deepEqual([...f.published.keys()], ['@fixture/a']);
    assert.equal(f.events.includes('push'), false);
    assert.ok(f.events.indexOf('preflight') < f.events.indexOf('npm:@fixture/a'));
    const result = await f.run();
    assert.equal(result.phase, 'open');
    assert.equal(f.events.filter((event) => event === 'npm:@fixture/a').length, 1);
    assert.equal(f.events.filter((event) => event === 'npm:@fixture/b').length, 2);
    assert.equal(existsSync(f.marker), false);
    assert.equal(f.git('rev-parse', 'HEAD'), f.release.snapshotSha, 'Trusted main worktree is unchanged');
  } finally { f.cleanup(); }
});

test('refs recorded before a completion outage are not pushed again on retry', async () => {
  const f = fixture();
  try {
    f.failCompletion = true;
    await assert.rejects(f.run(), /completion unavailable/);
    assert.equal(f.state.phase, 'recovery');
    await f.run();
    assert.equal(f.events.filter((event) => event === 'push').length, 1);
    assert.equal(f.events.filter((event) => event.startsWith('npm:')).length, 2);
    assert.equal(f.events.filter((event) => event === 'complete').length, 2);
  } finally { f.cleanup(); }
});

test('owner, locally bound commit, refs, version and ZIP integrity mismatches fail before publication', async () => {
  const scenarios = [
    (f) => ({ owner: { ...owner, runAttempt: 3 } }),
    (f) => { f.mainSha = 'a'.repeat(40); },
    (f) => { f.tag = { object: { type: 'commit', sha: 'a'.repeat(40) } }; },
    (f) => { const bytes = f.archives.get(1); f.archives.set(1, Buffer.concat([bytes.subarray(0, -1), Buffer.from('x')])); },
    (f) => { f.responses.get('actions/artifacts/2').digest = `sha256:${'a'.repeat(64)}`; },
    (f) => { f.responses.get('actions/artifacts/2').workflow_run.id = 99; },
    (f) => { f.responses.get(`actions/runs/${owner.runId}/attempts/${owner.runAttempt}`).run_attempt = 3; },
  ];
  for (const scenario of scenarios) {
    const f = fixture();
    try {
      await assert.rejects(f.run(scenario(f) ?? {}));
      assert.equal(f.events.includes('publish'), false);
      assert.equal(f.events.includes('push'), false);
      assert.equal(f.state.phase, 'recovery');
    } finally { f.cleanup(); }
  }
  for (const [options, message] of [[{ wrongVersion: true }, /version mismatch/], [{ wrongBundle: true }, /bundle HEAD differs/], [{ wrongParent: true }, /frozen source parent/]]) {
    const wrong = fixture(options);
    try { await assert.rejects(wrong.run(), message); assert.equal(wrong.events.includes('publish'), false); }
    finally { wrong.cleanup(); }
  }
});

test('missing and expired artifacts leave admission closed without any npm writes', async () => {
  for (const missing of [true, false]) {
    const f = fixture();
    try {
      if (missing) f.responses.delete('actions/artifacts/2');
      else f.responses.get('actions/artifacts/2').expired = true;
      await assert.rejects(f.run());
      assert.deepEqual(f.events, []);
      assert.equal(f.state.phase, 'recovery');
    } finally { f.cleanup(); }
  }
});

test('push preflight failure precedes every npm write', async () => {
  const f = fixture();
  try {
    f.io.push = () => { throw new Error('push permission denied'); };
    await assert.rejects(f.run(), /push permission denied/);
    assert.equal(f.events.includes('publish'), false);
    assert.equal(f.state.phase, 'recovery');
  } finally { f.cleanup(); }
});


test('unpublished release commit recovers without a GitHub commit API lookup', async () => {
  const f = fixture();
  try {
    // No git/commits response exists: the forge would throw as if it were 404.
    // Only the state-bound bundle contains this unpushed release candidate.
    assert.equal(f.responses.has(`git/commits/${f.release.releaseCommitSha}`), false);
    const result = await f.run();
    assert.equal(result.phase, 'open');
    assert.ok(f.events.indexOf('preflight') < f.events.indexOf('publish'));
  } finally { f.cleanup(); }
});

test('an originating attempt still publishing cannot race recovery', async () => {
  for (const status of ['queued', 'in_progress', 'waiting', undefined]) {
    const f = fixture();
    try {
      f.responses.get(`actions/runs/${owner.runId}/attempts/${owner.runAttempt}`).status = status;
      await assert.rejects(f.run(), /Originating release attempt must be completed/);
      assert.deepEqual(f.events, []);
      assert.equal(f.published.size, 0);
      assert.equal(f.state.phase, 'recovery');
    } finally { f.cleanup(); }
  }
});

test('safe extraction rejects traversal, symlinks and duplicate names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-unsafe-'));
  try {
    const source = join(directory, 'unsafe.zip');
    for (const files of [[['../escape', 'bad']], [['/absolute', 'bad']], [['windows\\escape', 'bad']], [['a', 'first'], ['a', 'second']]]) {
      writeFileSync(source, zip(files));
      assert.throws(() => extractRecoveryArchive(source, join(directory, 'extracted')));
      rmSync(join(directory, 'extracted'), { recursive: true, force: true });
    }
    execFileSync('python3', ['-I', '-c', 'import sys,zipfile,stat\ni=zipfile.ZipInfo("link");i.external_attr=(stat.S_IFLNK|0o777)<<16\nwith zipfile.ZipFile(sys.argv[1],"w") as z:z.writestr(i,"/outside")', source]);
    assert.throws(() => extractRecoveryArchive(source, join(directory, 'extracted')));
    assert.equal(existsSync(join(directory, 'escape')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('download authenticates only GitHub request, never signed storage redirect', async () => {
  const requests = [];
  const bytes = Buffer.from('original zip');
  const result = await downloadRecoveryArtifact({ id: 3 }, {
    token: 'read-token', async fetchImpl(url, options) {
      requests.push({ url, options });
      if (requests.length === 1) return { status: 302, headers: new Headers({ location: 'https://storage.example.invalid/signed' }) };
      return { ok: true, body: (async function* () { yield bytes; })() };
    },
  });
  assert.deepEqual(result, bytes);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer read-token');
  assert.equal(requests[1].options.headers, undefined);
  assert.equal(requests[1].options.redirect, 'error');
});

test('CLI accepts only original owner selectors and rejects artifact/head/run overrides', async () => {
  const env = { GITHUB_REPOSITORY: REPOSITORY };
  for (const argv of [['--head', 'a'], ['--artifact-id', '3'], ['--owner-run-id', '42'], ['--owner-run-id', '0', '--owner-run-attempt', '2'], ['--owner-run-id', '42', '--owner-run-id', '43']]) {
    await assert.rejects(main(argv, env));
  }
});
