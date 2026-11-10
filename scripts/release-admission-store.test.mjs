import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createReleaseAdmissionState, transitionReleaseAdmission, updateReleaseAdmissionState } from './release-admission-state.mjs';
import { createReleaseAdmissionStore, RELEASE_ADMISSION_REF } from './release-admission-store.mjs';

const repository = 'happyvertical/smrt';
const initial = () => createReleaseAdmissionState({ repository });
const admission = (character) => (state) => transitionReleaseAdmission(state, { type: 'admit', sha: character.repeat(40) });

function github() {
  let head = null;
  let counter = 0;
  const objects = new Map();
  const calls = [];
  const id = () => (++counter).toString(16).padStart(40, '0');
  const ref = () => ({ ref: RELEASE_ADMISSION_REF, object: { type: 'commit', sha: head } });
  const server = {
    objects, calls,
    get head() { return head; },
    set head(value) { head = value; },
    intercept: null,
    fetch: async (url, options) => {
      const path = new URL(url).pathname.split('/git/')[1];
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ method: options.method, path, body });
      const response = (status, data) => ({ status, json: async () => structuredClone(data) });
      if (server.intercept) {
        const override = await server.intercept({ path, method: options.method, body, response });
        if (override) return override;
      }
      if (options.method === 'GET') {
        if (path === 'ref/heads/hv-release-admission') return head ? response(200, ref()) : response(404);
        const object = objects.get(path.split('/')[1]);
        return object ? response(200, object) : response(404);
      }
      if (path === 'blobs') {
        const bytes = Buffer.from(body.content);
        const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        const object = { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
        objects.set(sha, object);
        return response(201, object);
      }
      if (path === 'trees') {
        const object = { sha: id(), tree: body.tree, truncated: false };
        objects.set(object.sha, object);
        return response(201, object);
      }
      if (path === 'commits') {
        const object = { sha: id(), tree: { sha: body.tree }, parents: body.parents.map((sha) => ({ sha })) };
        objects.set(object.sha, object);
        return response(201, object);
      }
      if (path === 'refs') {
        if (head) return response(422);
        head = body.sha;
        return response(201, ref());
      }
      if (path === 'refs/heads/hv-release-admission') {
        assert.equal(body.force, false);
        const commit = objects.get(body.sha);
        if (commit.parents[0]?.sha !== head) return response(422);
        head = body.sha;
        return response(200, ref());
      }
      throw new Error('unexpected fake route');
    },
  };
  return server;
}

function store(server) {
  return createReleaseAdmissionStore({ repository, token: 'never-log-this-token', fetchImpl: server.fetch });
}

test('absent ref reads null and admission cannot bootstrap; initialization is explicit', async () => {
  const server = github();
  const backend = store(server);
  assert.equal(await backend.read(), null);
  await assert.rejects(backend.compareAndSwap('a'.repeat(40), admission('a')(initial())), { code: 'state-not-initialized' });
  assert.equal(server.calls.some((call) => call.method === 'POST'), false);
  const created = await backend.initialize(initial());
  assert.equal(created.revision, server.head);
  assert.deepEqual(await backend.read(), created);
  await assert.rejects(backend.initialize(initial()), { code: 'state-already-initialized' });
});

test('CAS commits one state file as a direct child and refuses stale expected SHA', async () => {
  const server = github();
  const backend = store(server);
  const head = await backend.initialize(initial());
  const next = admission('a')(head.state);
  assert.equal(await backend.compareAndSwap(head.revision, next), true);
  assert.deepEqual(server.objects.get(server.head).parents, [{ sha: head.revision }]);
  assert.deepEqual((await backend.read()).state, next);
  const posts = server.calls.filter((call) => call.method === 'POST').length;
  assert.equal(await backend.compareAndSwap(head.revision, admission('b')(head.state)), false);
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, posts);
});

test('publishing recovery artifact identities persist exactly in the state branch', async () => {
  const server = github();
  const backend = store(server);
  const head = await backend.initialize(initial());
  const snapshotSha = 'a'.repeat(40);
  const next = {
    ...head.state, revision: 1, phase: 'publishing',
    owner: { runId: 100, runAttempt: 1 }, deadlineMs: 1000, snapshotSha,
    release: {
      snapshotSha, releaseCommitSha: 'b'.repeat(40), version: '0.57.27', ref: 'refs/tags/v0.57.27',
      recoveryArtifacts: [
        { id: 1, name: 'release-bundle', digest: `sha256:${'1'.repeat(64)}` },
        { id: 2, name: 'release-packs', digest: `sha256:${'2'.repeat(64)}` },
      ],
    },
  };
  assert.equal(await backend.compareAndSwap(head.revision, next), true);
  assert.deepEqual((await backend.read()).state.release.recoveryArtifacts, next.release.recoveryArtifacts);
});

test('sibling commits race safely and refreshed retries preserve both admissions', async () => {
  const server = github();
  const backend = store(server);
  await backend.initialize(initial());
  await Promise.all(['a', 'b'].map((character) => updateReleaseAdmissionState(backend, admission(character))));
  const head = await backend.read();
  assert.equal(head.state.revision, 2);
  assert.deepEqual(new Set(head.state.admitted.map((entry) => entry.sha)), new Set(['a'.repeat(40), 'b'.repeat(40)]));
  assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, 3, 'one sibling conflict followed by refreshed retry');
});

test('422 with unchanged remote is policy rejection, not an infinite conflict retry', async () => {
  const server = github();
  const backend = store(server);
  const head = await backend.initialize(initial());
  server.intercept = ({ method, response }) => method === 'PATCH' ? response(422, { message: 'never-log-this-token' }) : null;
  await assert.rejects(backend.compareAndSwap(head.revision, admission('a')(head.state)), (error) => {
    assert.equal(error.code, 'git-ref-policy-rejected');
    assert.equal(error.status, 422);
    assert.doesNotMatch(String(error), /never-log/);
    return true;
  });
});

test('permissions, network and malformed JSON fail without exposing token or response bodies', async () => {
  for (const status of [401, 403, 409, 500]) {
    const backend = createReleaseAdmissionStore({ repository, token: 'secret', fetchImpl: async () => ({ status, json: async () => ({ token: 'secret' }) }) });
    await assert.rejects(backend.read(), (error) => error.status === status && !String(error).includes('secret'));
  }
  const network = createReleaseAdmissionStore({ repository, token: 'secret', fetchImpl: async () => { throw new Error('request secret'); } });
  await assert.rejects(network.read(), { code: 'github-network-error' });
  const malformed = createReleaseAdmissionStore({ repository, token: 'secret', fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('secret body'); } }) });
  await assert.rejects(malformed.read(), { code: 'invalid-github-json' });
});

test('read rejects wrong ref, commit SHA, tree shape, path and entry type', async () => {
  const mutations = [
    ['ref/heads/hv-release-admission', (data) => { data.ref = 'refs/heads/main'; }],
    ['commits/', (data) => { data.sha = 'f'.repeat(40); }],
    ['commits/', (data) => { data.parents = [{ sha: 'a'.repeat(40) }, { sha: 'b'.repeat(40) }]; }],
    ['trees/', (data) => { data.tree.push({ ...data.tree[0], path: 'extra' }); }],
    ['trees/', (data) => { data.tree[0].path = '../state.json'; }],
    ['trees/', (data) => { data.tree[0].type = 'tree'; }],
    ['trees/', (data) => { data.tree[0].mode = '120000'; }],
    ['trees/', (data) => { data.truncated = true; }],
    ['blobs/', (data) => { data.content = Buffer.from('{}').toString('base64'); }],
    ['blobs/', (data) => { data.size = 40_000; }],
  ];
  for (const [path, mutate] of mutations) {
    const server = github();
    const backend = store(server);
    await backend.initialize(initial());
    server.intercept = ({ path: actual, method, response }) => {
      if (method !== 'GET' || !actual.startsWith(path)) return null;
      const data = path.startsWith('ref/') ? { ref: RELEASE_ADMISSION_REF, object: { type: 'commit', sha: server.head } } : structuredClone(server.objects.get(actual.split('/')[1]));
      mutate(data);
      return response(200, data);
    };
    await assert.rejects(backend.read());
  }
});

test('valid blob hashes do not excuse malformed state schema or another repository', async () => {
  const server = github();
  const backend = store(server);
  await backend.initialize(initial());
  for (const state of [{ ...initial(), schemaVersion: 2 }, { ...initial(), repository: 'other/smrt' }]) {
    const bytes = Buffer.from(JSON.stringify(state));
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    server.objects.set(sha, { sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
    server.objects.get(server.objects.get(server.head).tree.sha).tree[0].sha = sha;
    await assert.rejects(backend.read());
  }
});

test('write validates schema and revision before creating objects', async () => {
  const server = github();
  const backend = store(server);
  const head = await backend.initialize(initial());
  const count = server.calls.filter((call) => call.method === 'POST').length;
  await assert.rejects(backend.compareAndSwap(head.revision, { ...initial(), schemaVersion: 2 }));
  await assert.rejects(backend.compareAndSwap(head.revision, initial()), { code: 'invalid-next-revision' });
  assert.equal(server.calls.filter((call) => call.method === 'POST').length, count);
});

test('malformed created tree or commit is rejected before any ref update', async () => {
  for (const path of ['trees', 'commits']) {
    const server = github();
    const backend = store(server);
    const head = await backend.initialize(initial());
    const patches = server.calls.filter((call) => call.method === 'PATCH').length;
    server.intercept = ({ method, path: actual, response }) => {
      if (method !== 'POST' || actual !== path) return null;
      return response(201, { sha: 'f'.repeat(40), tree: [], parents: [] });
    };
    await assert.rejects(backend.compareAndSwap(head.revision, admission('a')(head.state)));
    assert.equal(server.calls.filter((call) => call.method === 'PATCH').length, patches);
    assert.equal(server.head, head.revision);
  }
});
