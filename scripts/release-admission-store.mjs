import { createHash } from 'node:crypto';
import { validateReleaseAdmissionState } from './release-admission-state.mjs';

export const RELEASE_ADMISSION_REF = 'refs/heads/hv-release-admission';
const REF_SUFFIX = 'heads/hv-release-admission';
const MAX_BYTES = 32_768;
const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);

export class ReleaseAdmissionStoreError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'ReleaseAdmissionStoreError';
    this.code = code;
    this.status = status;
  }
}

function check(value, code) {
  if (!value) throw new ReleaseAdmissionStoreError(code);
}

function gitBlobSha(bytes, length = 40) {
  return createHash(length === 64 ? 'sha256' : 'sha1')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * Options are trusted caller configuration, never values from a PR or state.
 * This backend makes no admission/initialization decision of its own. Protect
 * its fixed branch and writer credential before enabling runtime use.
 */
export function createReleaseAdmissionStore({ repository, token, fetchImpl = fetch, apiUrl = 'https://api.github.com' } = {}) {
  check(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'invalid-repository');
  check(typeof token === 'string' && token.length > 0 && !/[\r\n]/.test(token), 'missing-trusted-token');
  let base;
  try {
    base = new URL(apiUrl);
  } catch {
    throw new ReleaseAdmissionStoreError('invalid-api-origin');
  }
  check(base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash, 'invalid-api-origin');
  const endpoint = `${base.href.replace(/\/$/, '')}/repos/${repository}/git`;

  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${endpoint}/${path}`, {
        method, redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ReleaseAdmissionStoreError('github-network-error');
    }
    check(response && Number.isInteger(response.status), 'invalid-http-response');
    if (response.status < 200 || response.status >= 300) return { status: response.status };
    try {
      return { status: response.status, data: await response.json() };
    } catch {
      throw new ReleaseAdmissionStoreError('invalid-github-json');
    }
  }

  function success(response) {
    if (!response.data) throw new ReleaseAdmissionStoreError('github-request-rejected', response.status);
    return response.data;
  }

  async function refHead() {
    const response = await request('GET', `ref/${REF_SUFFIX}`);
    if (response.status === 404) return null;
    const ref = success(response);
    check(ref.ref === RELEASE_ADMISSION_REF && ref.object?.type === 'commit' && validSha(ref.object.sha), 'invalid-state-ref');
    return ref.object.sha;
  }

  async function read() {
    const revision = await refHead();
    if (revision === null) return null;
    const commit = success(await request('GET', `commits/${revision}`));
    check(commit.sha === revision && validSha(commit.tree?.sha) && Array.isArray(commit.parents) &&
      commit.parents.length <= 1 && commit.parents.every((parent) => validSha(parent?.sha)), 'invalid-state-commit');
    const tree = success(await request('GET', `trees/${commit.tree.sha}`));
    check(tree.sha === commit.tree.sha && tree.truncated !== true && Array.isArray(tree.tree) && tree.tree.length === 1, 'invalid-state-tree');
    const entry = tree.tree[0];
    check(entry.path === 'state.json' && entry.type === 'blob' && entry.mode === '100644' && validSha(entry.sha), 'invalid-state-path');
    const blob = success(await request('GET', `blobs/${entry.sha}`));
    check(blob.sha === entry.sha && blob.encoding === 'base64' && Number.isSafeInteger(blob.size) &&
      blob.size > 0 && blob.size <= MAX_BYTES && typeof blob.content === 'string' &&
      blob.content.length <= MAX_BYTES * 2, 'invalid-state-blob');
    const encoded = blob.content.replace(/\n/g, '');
    check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), 'invalid-state-base64');
    const bytes = Buffer.from(encoded, 'base64');
    check(bytes.length === blob.size && bytes.toString('base64') === encoded && gitBlobSha(bytes, entry.sha.length) === entry.sha, 'state-blob-digest-mismatch');
    let state;
    try {
      state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      validateReleaseAdmissionState(state);
    } catch {
      throw new ReleaseAdmissionStoreError('invalid-state-json');
    }
    check(state.repository === repository, 'state-repository-mismatch');
    check(commit.parents.length === (state.revision === 0 ? 0 : 1), 'invalid-state-lineage');
    return { revision, state };
  }

  async function writeCommit(state, parents) {
    validateReleaseAdmissionState(state);
    check(state.repository === repository, 'state-repository-mismatch');
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
    check(bytes.length <= MAX_BYTES, 'state-size-limit');
    const blob = success(await request('POST', 'blobs', { content: bytes.toString('utf8'), encoding: 'utf-8' }));
    check(validSha(blob.sha) && blob.sha === gitBlobSha(bytes, blob.sha.length), 'created-blob-digest-mismatch');
    const tree = success(await request('POST', 'trees', {
      tree: [{ path: 'state.json', mode: '100644', type: 'blob', sha: blob.sha }],
    }));
    check(validSha(tree.sha) && Array.isArray(tree.tree) && tree.tree.length === 1 &&
      tree.tree[0].path === 'state.json' && tree.tree[0].mode === '100644' &&
      tree.tree[0].type === 'blob' && tree.tree[0].sha === blob.sha, 'invalid-created-tree');
    const commit = success(await request('POST', 'commits', {
      message: 'chore: update release admission state', tree: tree.sha, parents,
    }));
    check(validSha(commit.sha) && commit.tree?.sha === tree.sha && Array.isArray(commit.parents) &&
      commit.parents.length === parents.length && commit.parents.every((parent, index) => parent?.sha === parents[index]), 'invalid-created-commit');
    return commit.sha;
  }

  async function initialize(state) {
    validateReleaseAdmissionState(state);
    check(state.phase === 'open' && state.revision === 0 && state.admitted.length === 0 &&
      state.lastRelease === null && state.lastWindow === null, 'invalid-initial-state');
    check(await refHead() === null, 'state-already-initialized');
    const commitSha = await writeCommit(state, []);
    const ref = success(await request('POST', 'refs', { ref: RELEASE_ADMISSION_REF, sha: commitSha }));
    check(ref.ref === RELEASE_ADMISSION_REF && ref.object?.type === 'commit' && ref.object.sha === commitSha, 'invalid-created-ref');
    return { revision: commitSha, state: structuredClone(state) };
  }

  async function compareAndSwap(expectedSha, nextState) {
    check(validSha(expectedSha), 'invalid-expected-sha');
    validateReleaseAdmissionState(nextState);
    // Ref must exist: a caller cannot bootstrap via an admission write.
    const current = await read();
    check(current !== null, 'state-not-initialized');
    if (current.revision !== expectedSha) return false;
    check(nextState.revision === current.state.revision + 1, 'invalid-next-revision');
    const commitSha = await writeCommit(nextState, [expectedSha]);
    const response = await request('PATCH', `refs/${REF_SUFFIX}`, { sha: commitSha, force: false });
    if (response.status === 422) {
      const refreshed = await refHead();
      if (refreshed !== null && refreshed !== expectedSha) return false;
      throw new ReleaseAdmissionStoreError('git-ref-policy-rejected', 422);
    }
    const ref = success(response);
    check(ref.ref === RELEASE_ADMISSION_REF && ref.object?.type === 'commit' && ref.object.sha === commitSha, 'invalid-updated-ref');
    return true;
  }

  return { read, initialize, compareAndSwap };
}
