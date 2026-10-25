#!/usr/bin/env node
/** Trusted adapter. Never load this script from an event's head or execute artifacts. */
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createReleaseAdmissionState, transitionReleaseAdmission, updateReleaseAdmissionState, validateReleaseRecoveryArtifacts } from './release-admission-state.mjs';
import { createReleaseAdmissionStore } from './release-admission-store.mjs';
import { verifyPublishArtifacts } from './publish-artifacts-lib.mjs';
import { primaryRegistry, registryArgs } from './release-registry.mjs';

export const REPOSITORY = 'happyvertical/smrt';
export const CONTEXT = 'Release Admission';
const RELEASE_APP_BOT_ID = 244849939; // GitHub API identity for App 2315871.
const grantDescription = (id) => `Validated admission grant ${id}`;
const WORKFLOW = '.github/workflows/on-pull-request.yml';
const check = (condition, code) => { if (!condition) throw new Error(code); };
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const appStatus = (status, head) => Number.isSafeInteger(status?.id) && status.id > 0 &&
  status.context === CONTEXT && status.creator?.id === RELEASE_APP_BOT_ID &&
  status.creator.login === 'have-release-bot[bot]' && status.creator.type === 'Bot' &&
  status.url === `https://api.github.com/repos/${REPOSITORY}/statuses/${head}`;

export function createForge({ readToken, writeToken, readOnly = false, fetchImpl = fetch }) {
  check(readToken && (readOnly || (writeToken && readToken !== writeToken)), 'Separate GITHUB_TOKEN and RELEASE_GITHUB_TOKEN are required');
  async function request(path, { method = 'GET', body, missing = false } = {}) {
    check(!readOnly || method === 'GET', 'Read-only release assertion cannot mutate GitHub');
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
      method, redirect: 'error', headers: {
        Authorization: `Bearer ${method === 'GET' ? readToken : writeToken}`,
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      const rejected = (message) => Object.assign(new Error(message), {
        // A received 4xx rejection can settle this POST, except request timeout.
        // Transport errors, redirects and 5xx also leave the outcome unknown.
        statusWriteRejected: method === 'POST' && path.startsWith('statuses/') && response.status >= 400 && response.status < 500 && response.status !== 408,
      });
      if (method === 'POST' && path.startsWith('statuses/') && [403, 404].includes(response.status)) {
        throw rejected('Release App requires statuses:write (App 2315871); do not substitute the Actions token');
      }
      throw rejected(`GitHub request rejected (${response.status})`);
    }
    return response.json();
  }
  async function list(path, key) {
    const result = [];
    for (let page = 1; page <= 20; page++) {
      const response = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const entries = key ? response[key] : response;
      check(Array.isArray(entries), 'Invalid GitHub list');
      if (key) check(Number.isSafeInteger(response.total_count) && response.total_count <= 1000, 'Validation run inventory exceeds GitHub search limit; narrow reconciliation before retrying');
      result.push(...entries);
      if (key && entries.length < 100) check(result.length === response.total_count, 'Validation run inventory incomplete; retry reconciliation');
      if (entries.length < 100 || (key && result.length === response.total_count)) return result;
    }
    throw new Error('GitHub inventory exceeds safe pagination bound; narrow reconciliation before retrying');
  }
  return {
    request, list,
    main: () => request('branches/main'),
    groups: () => list('git/matching-refs/heads/gh-readonly-queue/main/'),
    status: async (head, state, description) => {
      const result = await request(`statuses/${head}`, {
        method: 'POST', body: { state, context: CONTEXT, description },
      });
      check(appStatus(result, head) && result.state === state && result.description === description, 'Status POST acknowledgement malformed; result unknown');
      return result;
    },
  };
}

export function createController({ store, forge, grantOwner = { runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) }, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim(), verifyArtifacts = verifyPublishArtifacts, registryMetadata = (artifact) => JSON.parse(execFileSync('npm', ['view', `${artifact.name}@${artifact.version}`, '--json', '--prefer-online', ...registryArgs(primaryRegistry())], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }) {
  const update = (operation) => updateReleaseAdmissionState(store, (state) => transitionReleaseAdmission(state, operation));
  async function state() {
    const head = await store.read();
    check(head?.state?.repository === REPOSITORY, 'Release admission state missing or wrong repository; explicit init required');
    return head.state;
  }
  async function liveGroup(run) {
    const [main, groups, commit] = await Promise.all([forge.main(), forge.groups(), forge.request(`git/commits/${run.head_sha}`)]);
    const ref = groups.find((entry) => entry.object?.sha === run.head_sha && entry.ref === `refs/heads/${run.head_branch}`);
    check(main.protected === true && ref && commit.sha === run.head_sha && commit.parents?.[0]?.sha === main.commit.sha, 'Stale or unverifiable merge group');
    return ref;
  }
  async function grantGreen(head, validationRunId, revalidate) {
    const existing = (await state()).admitted.find((entry) => entry.sha === head);
    const observedWindowGrantId = existing?.windowGrantId ?? null;
    if (existing?.grant === null && observedWindowGrantId !== null) {
      await revalidate();
      const latest = await latestAppStatus(head);
      if (latest?.state === 'success' && latest.description === grantDescription(observedWindowGrantId)) return state();
    }
    const grant = { id: randomBytes(16).toString('hex'), runId: grantOwner.runId, runAttempt: grantOwner.runAttempt, validationRunId };
    const reserved = await update({ type: 'reserveGrant', sha: head, grant, observedWindowGrantId });
    if (reserved.admitted.find((entry) => entry.sha === head)?.grant?.id !== grant.id) return reserved;
    try { await revalidate(); } catch (error) {
      // No POST was attempted, so releasing this reservation is safe.
      await update({ type: 'cancelGrant', sha: head, grant });
      throw error;
    }
    try { await forge.status(head, 'success', grantDescription(grant.id)); } catch (error) {
      if (error.statusWriteRejected === true) await update({ type: 'cancelGrant', sha: head, grant });
      throw error;
    }
    return update({ type: 'finishGrant', sha: head, grant });
  }
  async function latestAppStatus(head) {
    const statuses = await forge.list(`commits/${head}/statuses`);
    // Only the latest relevant authenticated status represents current state;
    // finding a historical matching success would ignore a later revocation.
    return statuses.filter((status) => appStatus(status, head)).sort((left, right) => right.id - left.id)[0];
  }
  async function pending(head, description) {
    const latest = await latestAppStatus(head);
    if (latest?.state === 'pending' && latest.description === description) return;
    await forge.status(head, 'pending', description);
  }
  async function admit(runId) {
    check(Number.isSafeInteger(runId) && runId > 0, 'Invalid source run ID');
    const run = await forge.request(`actions/runs/${runId}`);
    const workflow = await forge.request(`actions/workflows/${run.workflow_id}`);
    check(run.id === runId && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY &&
      run.path === WORKFLOW && workflow.path === WORKFLOW && run.status === 'completed' && run.conclusion === 'success' && sha(run.head_sha), 'Untrusted or unsuccessful validation run');
    if (run.event === 'merge_group') {
      await liveGroup(run);
      const current = await state();
      if (current.phase !== 'open') {
        const existing = current.admitted.find((entry) => entry.sha === run.head_sha);
        // Preserve already admitted work while draining, but never issue a new
        // green POST from a closed window that can race with drain revocation.
        if (current.phase === 'draining' && existing?.disposition === 'pending') return current;
        await pending(run.head_sha, 'Release window closed; awaiting admission');
        return current;
      }
      return grantGreen(run.head_sha, run.id, () => liveGroup(run));
    }
    check(['pull_request', 'pull_request_target'].includes(run.event), 'Unsupported validation event');
    const associated = await forge.list(`commits/${run.head_sha}/pulls`);
    const candidates = associated.filter((pr) => pr.state === 'open' && pr.head?.sha === run.head_sha && pr.base?.ref === 'main');
    check(candidates.length === 1, 'Ambiguous or stale PR validation');
    const pr = await forge.request(`pulls/${candidates[0].number}`);
    check(pr.state === 'open' && pr.base?.ref === 'main' && pr.base?.repo?.full_name === REPOSITORY && pr.head?.repo?.full_name === REPOSITORY && pr.head.sha === run.head_sha, 'Stale, forked or unverifiable PR validation head');
    const current = await state();
    if (current.phase !== 'open') {
      await pending(run.head_sha, 'Release window closed; awaiting admission');
      return current;
    }
    return grantGreen(run.head_sha, run.id, async () => {
      const latest = await forge.request(`pulls/${pr.number}`);
      check(latest.state === 'open' && latest.head?.sha === run.head_sha && latest.head.repo?.full_name === REPOSITORY, 'Stale PR validation head');
    });
  }
  async function verifyFence() {
    const rules = await Promise.all((await forge.list('rulesets')).filter((rule) => rule.enforcement === 'active').map((rule) => forge.request(`rulesets/${rule.id}`)));
    const applies = (rule, refs) => rule.target === 'branch' && rule.enforcement === 'active' && rule.conditions?.ref_name?.exclude?.length === 0 && rule.conditions.ref_name.include.some((ref) => refs.includes(ref));
    const onlyApp = (rule) => (rule.bypass_actors ?? []).every((actor) => actor.actor_type === 'Integration' && actor.actor_id === 2315871 && actor.bypass_mode === 'always');
    const mainRules = rules.filter((rule) => applies(rule, ['refs/heads/main', '~DEFAULT_BRANCH']));
    check(mainRules.some((rule) => onlyApp(rule) && rule.bypass_actors?.some((actor) => actor.actor_id === 2315871) && rule.rules.some((entry) => entry.type === 'required_status_checks' && entry.parameters.required_status_checks.some((status) => status.context === CONTEXT && status.integration_id === 2315871))), 'Provision App-bound Release Admission required status before activation');
    check(mainRules.some((rule) => rule.rules.some((entry) => entry.type === 'merge_queue' && entry.parameters.max_entries_to_build === 1 && entry.parameters.max_entries_to_merge === 1)), 'Release admission requires a one-entry merge queue');
    check(rules.some((rule) => applies(rule, ['refs/heads/hv-release-admission']) && onlyApp(rule) && rule.bypass_actors?.some((actor) => actor.actor_id === 2315871) && ['creation', 'update', 'deletion', 'non_fast_forward'].every((type) => rule.rules.some((entry) => entry.type === type))), 'Protect admission ref against non-App creation/updates/deletion/force-push before activation');
  }
  async function assertWindow(owner, snapshotSha) {
    await verifyFence();
    const current = await state();
    check(current.phase === 'qualifying' && current.owner.runId === owner.runId && current.owner.runAttempt === owner.runAttempt && current.snapshotSha === snapshotSha && now() < current.deadlineMs, 'Release window owner/snapshot/phase/deadline mismatch');
    const main = await forge.main();
    check(main.protected === true && main.commit.sha === snapshotSha, 'Main differs from frozen release source');
    return current;
  }
  async function close(owner, { timeoutMinutes = 90, drainMinutes = 30 } = {}) {
    check(Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 && Number.isFinite(drainMinutes) && drainMinutes > 0 && drainMinutes <= timeoutMinutes, 'Invalid release window');
    await verifyFence();
    let current = await update({ type: 'close', owner, nowMs: now(), timeoutMs: timeoutMinutes * 60_000 });
    const drainDeadline = Math.min(current.deadlineMs, now() + drainMinutes * 60_000);
    while (current.phase === 'draining') {
      current = await state();
      check(current.owner?.runId === owner.runId && current.owner?.runAttempt === owner.runAttempt, 'Release window owner mismatch during drain');
      if (current.phase !== 'draining') break;
      const groups = await forge.groups();
      const main = await forge.main();
      check(main.protected === true, 'Protected main required');
      for (const group of current.admitted.filter((entry) => entry.disposition === 'pending')) {
        if (group.grant !== null) continue; // Never race an unacknowledged success POST.
        const refExists = groups.some((entry) => entry.object?.sha === group.sha);
        let disposition;
        if (!refExists) {
          // Squash queue commits need not survive in main's ancestry. The live
          // ref's disappearance resolves this admission without stale Git lookup.
          await pending(group.sha, 'Queue admission drained; a new window must revalidate this head');
          disposition = 'deleted';
        }
        current = await update({ type: 'observeGroup', owner, facts: { authenticated: true, repository: REPOSITORY, sha: group.sha, refExists, disposition } });
      }
      if (current.admitted.every((entry) => entry.disposition !== 'pending')) {
        const latest = await forge.main();
        current = await update({ type: 'freeze', owner, nowMs: now(), main: { authenticated: true, repository: REPOSITORY, protected: latest.protected === true, ref: 'refs/heads/main', sha: latest.commit.sha } });
        break;
      }
      const unsettled = current.admitted.filter((entry) => entry.grant !== null).map((entry) => `${entry.sha}: controller ${entry.grant.runId}/${entry.grant.runAttempt}, grant ${entry.grant.id}, validation ${entry.grant.validationRunId}`).join('; ');
      check(now() < drainDeadline, unsettled ? `Merge-group drain blocked by unsettled status grants; reviewed recovery required: ${unsettled}` : 'Merge-group drain timed out; owning run must abort before publication');
      await sleep(Math.min(10_000, drainDeadline - now()));
    }
    check(current.phase === 'qualifying', 'Release window cannot freeze in current phase');
    return current;
  }
  function artifacts(directory, version) {
    check(directory, '--artifact-dir required');
    const inventory = verifyArtifacts(directory);
    check(inventory.releaseVersion === version && inventory.packages.length > 0, 'Release artifact version/inventory mismatch');
    return inventory;
  }
  async function recoveryArtifacts(owner) {
    const sourceRun = await forge.request(`actions/runs/${owner.runId}/attempts/${owner.runAttempt}`);
    const workflow = await forge.request(`actions/workflows/${sourceRun.workflow_id}`);
    check(sourceRun.id === owner.runId && sourceRun.run_attempt === owner.runAttempt && sourceRun.repository?.full_name === REPOSITORY && sourceRun.head_repository?.full_name === REPOSITORY && sourceRun.path === '.github/workflows/on-merge-main.yml' && workflow.path === sourceRun.path, 'Unverifiable originating release run/attempt');
    const names = [
      `release-candidate-${owner.runId}-${owner.runAttempt}`,
      `publish-release-pack-${owner.runId}-${owner.runAttempt}-1`,
      `publish-release-pack-${owner.runId}-${owner.runAttempt}-2`,
    ];
    const inventory = await forge.list(`actions/runs/${owner.runId}/artifacts`, 'artifacts');
    const selected = names.map((name) => {
      const matches = inventory.filter((artifact) => artifact.name === name);
      check(matches.length === 1, 'Release recovery artifact missing or ambiguous');
      const artifact = matches[0];
      check(artifact.expired === false && artifact.workflow_run?.id === owner.runId, 'Release recovery artifact expired or wrong originating run');
      return { id: artifact.id, name: artifact.name, digest: artifact.digest };
    });
    return validateReleaseRecoveryArtifacts(selected);
  }
  async function beginPublishing(owner, { snapshotSha, version, ref = `refs/tags/v${version}`, artifactDir }) {
    await assertWindow(owner, snapshotSha);
    const releaseCommitSha = git(['rev-parse', 'HEAD']);
    check(sha(snapshotSha) && sha(releaseCommitSha) && git(['rev-list', '--parents', '-n', '1', 'HEAD']) === `${releaseCommitSha} ${snapshotSha}`, 'Release commit must have exactly the frozen source as parent');
    check(JSON.parse(readFileSync('package.json', 'utf8')).version === version, 'Local version does not match release');
    artifacts(artifactDir, version);
    const boundArtifacts = await recoveryArtifacts(owner);
    const main = await forge.main();
    check(main.commit.sha === snapshotSha, 'Main advanced after release freeze');
    return update({ type: 'beginPublishing', owner, nowMs: now(), release: { snapshotSha, releaseCommitSha, version, ref, recoveryArtifacts: boundArtifacts }, qualification: { authenticated: true, repository: REPOSITORY, success: true, snapshotSha } });
  }
  async function complete(owner, { artifactDir }) {
    const current = await state();
    const release = current.release;
    check(release, 'No owned release to complete');
    check(current.owner?.runId === owner.runId && current.owner?.runAttempt === owner.runAttempt, 'Release completion owner mismatch');
    const [main, tag, commit] = await Promise.all([
      forge.main(), forge.request(`git/ref/tags/v${release.version}`), forge.request(`git/commits/${release.releaseCommitSha}`),
    ]);
    // Publication creates a lightweight tag. Annotated or moved tags fail closed.
    check(main.protected === true && main.commit.sha === release.releaseCommitSha && tag.object?.type === 'commit' && tag.object.sha === release.releaseCommitSha && commit.sha === release.releaseCommitSha && commit.parents?.length === 1 && commit.parents[0].sha === release.snapshotSha, 'Published refs/parent do not match owned release');
    const boundArtifacts = await recoveryArtifacts(owner);
    check(JSON.stringify(boundArtifacts) === JSON.stringify(release.recoveryArtifacts), 'Release recovery artifacts differ from original publication');
    const inventory = artifacts(artifactDir, release.version);
    for (const artifact of inventory.packages) {
      let metadata;
      try { metadata = await registryMetadata(artifact); } catch { throw new Error('Primary registry metadata verification unavailable'); }
      const integrity = `sha512-${createHash('sha512').update(readFileSync(artifact.path)).digest('base64')}`;
      check(metadata.name === artifact.name && metadata.version === release.version && metadata.dist?.integrity === integrity, 'Primary registry inventory/content mismatch');
    }
    // Recheck refs after registry reads; a changed source never reopens admission.
    const [latest, latestTag] = await Promise.all([forge.main(), forge.request(`git/ref/tags/v${release.version}`)]);
    check(latest.commit.sha === release.releaseCommitSha && latestTag.object?.type === 'commit' && latestTag.object.sha === release.releaseCommitSha, 'Published refs changed during publication verification');
    return update({ type: 'complete', owner, release, evidence: { authenticated: true, repository: REPOSITORY, ...release, recoveryArtifacts: boundArtifacts, refSha: tag.object.sha, sourceParentSha: commit.parents[0].sha, registries: { primary: 'success' } } });
  }
  async function finishRun(runId, runAttempt) {
    check(Number.isSafeInteger(runId) && runId > 0, 'Invalid source run ID');
    check(runAttempt === undefined || (Number.isSafeInteger(runAttempt) && runAttempt > 0), 'Invalid source release attempt');
    const run = await forge.request(runAttempt === undefined ? `actions/runs/${runId}` : `actions/runs/${runId}/attempts/${runAttempt}`);
    check(runAttempt === undefined || run.run_attempt === runAttempt, 'Unverifiable source release attempt');
    const workflow = await forge.request(`actions/workflows/${run.workflow_id}`);
    check(run.id === runId && run.repository?.full_name === REPOSITORY && run.path === '.github/workflows/on-merge-main.yml' && workflow.path === run.path && run.status === 'completed', 'Untrusted release completion event');
    const current = await state();
    if (current.phase === 'open' || current.owner.runId !== run.id || current.owner.runAttempt !== run.run_attempt) return current;
    return update({ type: 'abort', owner: { runId: run.id, runAttempt: run.run_attempt } });
  }
  async function ackGrant({ head, grantId, writerRunId, writerRunAttempt }) {
    check(sha(head), 'Invalid grant SHA');
    const current = await state();
    const grant = current.admitted.find((entry) => entry.sha === head)?.grant;
    check(grant && grant.id === grantId && grant.runId === writerRunId && grant.runAttempt === writerRunAttempt, 'Saved status grant identity mismatch');
    const writer = await forge.request(`actions/runs/${grant.runId}/attempts/${grant.runAttempt}`);
    const workflow = await forge.request(`actions/workflows/${writer.workflow_id}`);
    check(writer.id === grant.runId && writer.run_attempt === grant.runAttempt && writer.repository?.full_name === REPOSITORY && writer.head_repository?.full_name === REPOSITORY && writer.path === '.github/workflows/release-admission.yml' && workflow.path === writer.path && writer.status === 'completed', 'Original status writer must be authenticated and terminated before acknowledgement');
    const statuses = await forge.list(`commits/${head}/statuses`);
    check(statuses.some((status) => Number.isSafeInteger(status.id) && status.id > 0 && status.context === CONTEXT && status.state === 'success' && status.description === grantDescription(grant.id) && status.creator?.id === RELEASE_APP_BOT_ID && status.creator.login === 'have-release-bot[bot]' && status.creator.type === 'Bot' && status.url === `https://api.github.com/repos/${REPOSITORY}/statuses/${head}`), 'Exact App-created success grant evidence missing; leave grant unsettled for reviewed recovery');
    // Never repost green. Only acknowledge the exact already committed write.
    return update({ type: 'finishGrant', sha: head, grant });
  }
  async function reconcile() {
    let current = await state();
    if (['draining', 'qualifying'].includes(current.phase) && now() >= current.deadlineMs) {
      // Queue wait time is outside job timeouts. Expire the exact owner through
      // CAS; if publication won the race, timeout moves it to recovery instead.
      current = await update({ type: 'timeout', owner: current.owner, nowMs: now() });
    }
    if (current.phase !== 'open') {
      // workflow_run events may be coalesced by Actions concurrency. Poll the
      // independently fetched owner so a lost completion cannot strand a window.
      const run = await forge.request(`actions/runs/${current.owner.runId}/attempts/${current.owner.runAttempt}`);
      check(run.id === current.owner.runId, 'Invalid owning release run');
      check(run.run_attempt === current.owner.runAttempt, 'Owning release attempt changed; reviewed recovery is required');
      if (run.status === 'completed') await finishRun(run.id, current.owner.runAttempt);
      current = await state();
      if (current.phase !== 'open') return current;
    }
    const errors = [];
    async function retryHead(head, events) {
      try {
        const runs = await forge.list(`actions/workflows/on-pull-request.yml/runs?head_sha=${head}&status=success`, 'workflow_runs');
        const run = runs.find((entry) => entry.head_sha === head && events.includes(entry.event));
        if (run) await admit(run.id);
      } catch (error) { errors.push(error.message); }
    }
    // PR events can also disappear from Actions' single pending slot. Enumerate
    // current heads, not old run associations, then revalidate each via admit.
    for (const pr of await forge.list('pulls?state=open&base=main')) {
      if (pr.head?.repo?.full_name === REPOSITORY && sha(pr.head.sha)) {
        await retryHead(pr.head.sha, ['pull_request', 'pull_request_target']);
      }
    }
    // Never replay stored stale queue heads after reopening.
    for (const ref of await forge.groups()) {
      if (sha(ref.object?.sha)) await retryHead(ref.object.sha, ['merge_group']);
    }
    check(errors.length === 0, `Admission reconciliation incomplete (${errors.length} heads): ${errors.join('; ')}`);
    return state();
  }
  return { admit, close, assertWindow, finishRun, ackGrant, beginPublishing, complete, reconcile,
    init: () => store.initialize(createReleaseAdmissionState({ repository: REPOSITORY })),
    abort: (owner) => update({ type: 'abort', owner }),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  check(env.GITHUB_REPOSITORY === REPOSITORY, 'Wrong repository');
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    check(args[i]?.startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--'), 'Expected --option value');
    check(!Object.hasOwn(options, args[i].slice(2)), 'Duplicate CLI option');
    options[args[i].slice(2)] = args[i + 1];
  }
  const owner = { runId: Number(options['owner-run-id'] ?? env.GITHUB_RUN_ID), runAttempt: Number(options['owner-run-attempt'] ?? env.GITHUB_RUN_ATTEMPT) };
  // Qualification checks use only the Actions read credential. They neither
  // require nor receive the release App credential used by state/status writers.
  const readOnly = command === 'assert-window';
  const controller = createController({
    store: createReleaseAdmissionStore({ repository: REPOSITORY, token: readOnly ? env.GITHUB_TOKEN : env.RELEASE_GITHUB_TOKEN }),
    forge: createForge({ readToken: env.GITHUB_TOKEN, writeToken: readOnly ? undefined : env.RELEASE_GITHUB_TOKEN, readOnly }),
  });
  let result;
  if (command === 'init') result = await controller.init();
  else if (command === 'admit') result = await controller.admit(Number(options['run-id']));
  else if (command === 'finish-run') result = await controller.finishRun(Number(options['run-id']), options['run-attempt'] === undefined ? undefined : Number(options['run-attempt']));
  else if (command === 'reconcile') result = await controller.reconcile();
  else if (command === 'ack-grant') result = await controller.ackGrant({ head: options.sha, grantId: options['grant-id'], writerRunId: Number(options['writer-run-id']), writerRunAttempt: Number(options['writer-run-attempt']) });
  else if (command === 'assert-window') result = await controller.assertWindow(owner, options['snapshot-sha'] ?? env.RELEASE_SOURCE_SHA);
  else if (command === 'close') {
    check(env.CI_MERGE_QUEUE_ENABLED === 'true', 'Release window requires CI_MERGE_QUEUE_ENABLED=true');
    result = await controller.close(owner, { timeoutMinutes: Number(options['timeout-minutes'] ?? 90), drainMinutes: Number(options['drain-minutes'] ?? 30) });
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `snapshot_sha=${result.snapshotSha}\n`);
  } else if (command === 'begin-publishing') result = await controller.beginPublishing(owner, { snapshotSha: options['snapshot-sha'] ?? env.RELEASE_SOURCE_SHA, version: options.version ?? env.RELEASE_VERSION, ref: options.ref, artifactDir: options['artifact-dir'] });
  else if (command === 'complete') result = await controller.complete(owner, { artifactDir: options['artifact-dir'] });
  else if (command === 'abort') result = await controller.abort(owner);
  else throw new Error('Unknown release admission command');
  if (result) console.log(JSON.stringify({ phase: result.phase ?? result.state?.phase, snapshotSha: result.snapshotSha }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
