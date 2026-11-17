import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  adoptionStages,
  adoptOrResume,
  allowedManagers,
  legacyInventoryEntry,
  planAdoption,
  snapshotCaptureVersion,
  snapshotRequestVersion,
  validateAdoptionPlan,
  validateSnapshotRequest,
  verifyAdoptionGate,
} from './deployment/adopt.mjs';
import { hash } from './deployment/release.mjs';
import { createAdoptionMethods, proveLegacyAncestry } from './deployment/live-adoption.mjs';
import { main } from './deployment/cli.mjs';
const sha = 'a'.repeat(64),
  revision = 'b'.repeat(40);
const image = `registry/app@sha256:${sha}`;
function fixture() {
  const runtime = {
    workloads: {
      web: {
        image,
        command: ['node', 'server.mjs'],
        replicas: 1,
        service: { port: 80 },
        env: [],
      },
    },
    migration: { image, command: ['node', 'migrate.mjs'], env: [] },
  };
  const candidate = {
    kind: 'HelmRelease',
    metadata: { name: 'app', namespace: 'test' },
    spec: {
      values: {
        app: { name: 'app', environment: 'test' },
        release: { id: 'release-1', phase: 'stopped', sequence: 1, attempt: 1 },
        current: structuredClone(runtime),
        target: structuredClone(runtime),
        bindings: {},
        ingress: {},
      },
    },
  };
  const plan = {
    apiVersion: 'smrt.happyvertical.com/legacy-adoption-v1',
    adoptionId: 'adopt-1',
    releaseId: 'release-1',
    namespace: 'test',
    releaseName: 'app',
    canonicalFile: 'apps/release.yaml',
    stagingFile: 'apps/adoption.yaml',
    stateFile: 'proof/adoption.json',
    legacy: {
      repository: 'https://example.test/repo',
      revision,
      maintenanceRevision: revision,
      stopRevision: revision,
      relinquishRevision: revision,
      source: { namespace: 'flux-system', name: 'legacy', uid: 'source-uid' },
      kustomization: { namespace: 'test', name: 'legacy', uid: 'ks-uid' },
    },
    snapshot: { file: 'proof/snapshot.json', sha256: sha },
    qualification: { file: 'proof/qualification.json', sha256: sha },
    normalizedCurrentIdentity: hash(runtime),
    targetIdentity: hash(runtime),
    configurationIdentity: hash({ bindings: {}, ingress: {} }),
    chartArtifactSha256: sha,
    chartOciDigest: `sha256:${sha}`,
    fenceContract: { id: 'platform', identity: sha },
    candidate,
  };
  return {
    plan,
    config: {
      file: plan.canonicalFile,
      namespace: plan.namespace,
      adoption: { stateFile: plan.stateFile, stagingFile: plan.stagingFile },
    },
  };
}
function native(plan, stage) {
  const result = {
    planIdentity: hash(plan),
    adoptionId: plan.adoptionId,
    namespace: plan.namespace,
    stage,
    revision,
    inventoryIdentity: sha,
    observedAt: Date.now(),
    bindings: sha,
    resources: [
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        namespace: plan.namespace,
        name: 'app-web',
        uid: 'workload-uid',
        specIdentity: sha,
        selectorIdentity: sha,
        legacyManager: 'kustomize-controller',
        managers: [adoptionStages.indexOf(stage) >= 4 ? 'helm-controller' : 'kustomize-controller'],
        orphanedFieldsIdentity: null,
      },
    ],
    flux: {
      legacySourceUid: plan.legacy.source.uid,
      legacyKustomizationUid: plan.legacy.kustomization.uid,
      legacyRevision: revision,
      targetSourceUid: 'new-source-uid',
      targetKustomizationUid: 'new-ks-uid',
    },
  };
  result.inventoryIdentity = hash(result.resources);
  return result;
}
function fence(plan) {
  const now = Date.now();
  return {
    apiVersion: 'smrt.happyvertical.com/writer-fence-v1',
    contractId: plan.fenceContract.id,
    contractIdentity: plan.fenceContract.identity,
    adoptionId: plan.adoptionId,
    planIdentity: hash(plan),
    namespace: plan.namespace,
    epoch: 'epoch-1',
    observedAt: now,
    expiresAt: now + 20000,
    namespacePolicyIdentity: sha,
    databasePolicyIdentity: sha,
    observations: ['namespace', 'database'].map((scope) => ({
      scope,
      identity: sha,
      observedAt: now,
      activeWriters: 0,
    })),
  };
}
function unitAdapter(plan) {
  let snapshot = { revision, canonical: null, staging: null, state: null };
  const calls = [];
  return {
    calls,
    snapshot: () => snapshot,
    readAdoption: async () => structuredClone(snapshot),
    qualifyAdoption: async () => {},
    observeWriterFence: async () => {
      calls.push('fence');
      return fence(plan);
    },
    observeLegacy: async (_, __, stage) => {
      calls.push(`legacy:${stage}`);
      return native(plan, stage);
    },
    observeAdopted: async (_, __, stage) => {
      calls.push(`helm:${stage}`);
      return native(plan, stage);
    },
    preflightAdoption: async () => {
      calls.push('preflight');
      return { bindings: sha };
    },
    casAdoption: async (_, p, state, document) => {
      calls.push(`cas:${state.stage}`);
      snapshot = { ...snapshot, state };
      if (document) {
        if (state.stage === 'finalized') {
          snapshot.canonical = document;
          snapshot.staging = null;
        } else snapshot.staging = document;
      }
      return { stage: state.stage, revision };
    },
  };
}
test('explicit adoption rejects bootstrap, malformed schema, unsafe paths and forged runtime identities', () => {
  const { plan } = fixture();
  assert.equal(validateAdoptionPlan(plan), plan);
  for (const mutate of [
    (p) => (p.candidate.spec.values.current = false),
    (p) => (p.candidate.spec.values.release.sequence = 0),
    (p) => (p.candidate.spec.values.release.phase = 'active'),
    (p) => (p.candidate.spec.values.release.attempt = 2),
    (p) => (p.candidate.metadata.namespace = 'foreign'),
    (p) => (p.legacy.source.uid = ''),
    (p) => (p.legacy.stopRevision = 'main'),
    (p) => (p.targetIdentity = 'f'.repeat(64)),
    (p) => (p.extra = true),
    (p) => (p.stagingFile = p.canonicalFile),
    (p) => (p.canonicalFile = 'apps/release.json'),
    (p) => (p.stagingFile = 'apps/adoption.json'),
    (p) => (p.snapshot.file = '../secret'),
    (p) => (p.stateFile = '/tmp/state'),
    (p) =>
      (p.candidate.metadata.annotations = {
        'smrt.happyvertical.com/adoption-proof': sha,
      }),
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => validateAdoptionPlan(changed));
  }
});
test('every stage requires fresh bound native and namespace plus database fence observations', () => {
  const { plan } = fixture();
  assert.ok(
    verifyAdoptionGate(
      plan,
      'legacy-stopped',
      native(plan, 'legacy-stopped'),
      fence(plan),
    ),
  );
  for (const change of [
    (p) => (p.planIdentity = sha),
    (p) => (p.observedAt -= 31000),
    (p) => (p.namespace = 'foreign'),
    (p) => (p.stage = 'finalized'),
    (p) => (p.inventoryIdentity = true),
  ]) {
    const proof = native(plan, 'legacy-stopped');
    change(proof);
    assert.throws(() =>
      verifyAdoptionGate(plan, 'legacy-stopped', proof, fence(plan)),
    );
  }
  for (const change of [
    (p) => (p.expiresAt = 0),
    (p) => (p.contractIdentity = 'c'.repeat(64)),
    (p) => (p.observations[0].activeWriters = 1),
    (p) => p.observations.pop(),
    (p) => (p.planIdentity = sha),
    (p) => (p.epoch = ''),
    (p) => (p.observations[0].observedAt = 0),
  ]) {
    const proof = fence(plan);
    change(proof);
    assert.throws(() =>
      verifyAdoptionGate(
        plan,
        'legacy-stopped',
        native(plan, 'legacy-stopped'),
        proof,
      ),
    );
  }
  assert.throws(() =>
    verifyAdoptionGate(plan, 'legacy-stopped', true, { passed: true }),
  );
});
test('resume publishes one durable stage, keeps canonical absent until atomic finalization, then reobserves', async () => {
  const { plan, config } = fixture();
  const adapter = unitAdapter(plan);
  await planAdoption(config, adapter, plan);
  for (const stage of adoptionStages) {
    const result = await adoptOrResume(config, adapter, plan);
    assert.equal(result.stage, stage);
    if (stage !== 'finalized') assert.equal(adapter.snapshot().canonical, null);
  }
  const final = adapter.snapshot();
  assert.equal(final.staging, null);
  assert.equal(final.canonical.spec.values.current === false, false);
  assert.equal(final.canonical.spec.values.release.phase, 'stopped');
  assert.equal(
    final.canonical.metadata.annotations[
      'smrt.happyvertical.com/adoption-state'
    ],
    hash(final.state),
  );
  assert.equal(final.state.observations.length, 5);
  const before = adapter.calls.filter((c) => c.startsWith('cas:')).length;
  await adoptOrResume(config, adapter, plan);
  assert.equal(
    adapter.calls.filter((c) => c.startsWith('cas:')).length,
    before,
  );
  assert.equal(adapter.calls.at(-1), 'fence');
  assert.equal(adapter.calls.filter((c) => c === 'preflight').length, 1);
});
test('returned writers, missing fences and partial/ambiguous journal files never advance', async () => {
  const { plan, config } = fixture();
  const adapter = unitAdapter(plan);
  await adoptOrResume(config, adapter, plan);
  const count = adapter.calls.length;
  adapter.observeWriterFence = async () => ({ passed: true });
  await assert.rejects(
    () => adoptOrResume(config, adapter, plan),
    /writer fence/,
  );
  assert.equal(adapter.snapshot().state.stage, 'planned');
  adapter.snapshot().staging = plan.candidate;
  await assert.rejects(() => adoptOrResume(config, adapter, plan), /ambiguity/);
  assert.ok(adapter.calls.length >= count);
});
test('staging and final-rename crash retries observe exact established state without replaying mutation', async () => {
  const { plan, config } = fixture();
  const adapter = unitAdapter(plan);
  for (let i = 0; i < 4; i++) await adoptOrResume(config, adapter, plan);
  assert.equal(adapter.snapshot().state.stage, 'helm-staged');
  adapter.observeAdopted = async () => {
    throw new Error('pending Flux acknowledgement');
  };
  await assert.rejects(
    () => adoptOrResume(config, adapter, plan),
    /pending Flux/,
  );
  assert.equal(adapter.snapshot().state.stage, 'helm-staged');
  adapter.observeAdopted = async (_, __, stage) => native(plan, stage);
  await adoptOrResume(config, adapter, plan);
  await adoptOrResume(config, adapter, plan);
  assert.equal(adapter.snapshot().state.stage, 'finalized');
  await adoptOrResume(config, adapter, plan);
  assert.equal(adapter.snapshot().state.stage, 'finalized');
});
test('native fence provider is explicit, missing provider fails closed and thrown secrets are redacted', async () => {
  const { plan } = fixture();
  const methods = createAdoptionMethods(
    {},
    async () => {
      throw new Error('unused');
    },
    {},
    {},
  );
  await assert.rejects(
    () => methods.observeWriterFence(plan, { revision }, 'legacy-stopped'),
    /required/,
  );
  const protectedMethods = createAdoptionMethods(
    {},
    async () => {},
    {},
    {
      adoptionFenceObserver: () => {
        throw new Error('SECRET_CANARY');
      },
    },
  );
  await assert.rejects(
    () =>
      protectedMethods.observeWriterFence(plan, { revision }, 'legacy-stopped'),
    (error) =>
      !error.message.includes('SECRET_CANARY') &&
      error.code === 'ADOPTION_FENCE',
  );
});
test('normal CLI mutable operations call pending adoption interlock before bootstrap/repair/apply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smrt-adopt-cli-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, '{}');
    for (const operation of ['plan', 'repair', 'recover', 'apply-or-resume'])
      await assert.rejects(
        () =>
          main([operation, path], () => ({
            read: async () => ({ revision, document: null }),
            assertAdoptionComplete: async () => {
              throw new Error('pending adoption');
            },
          })),
        /pending adoption/,
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('native artifact read rejects symlink/duplicate paths and qualification cannot be an operator boolean', async () => {
  const { plan } = fixture();
  const method = createAdoptionMethods(
    { repository: '/repo', branch: 'main' },
    async (_, args) =>
      args.includes('rev-parse')
        ? revision
        : args.includes('ls-tree')
          ? `120000 blob ${sha}\tfile`
          : '',
    {},
    {},
  );
  await assert.rejects(
    () => method.readAdoption(plan),
    /regular tracked file|ancestor is not a Git tree/,
  );
  const untrusted = createAdoptionMethods(
    { adoption: {} },
    async () => '',
    {},
    {},
  );
  await assert.rejects(
    () => untrusted.qualifyAdoption(plan, { raw: {} }),
    /protected configuration/,
  );
});

test('native Git CAS atomically renames staging, rejects superseded file history and preserves other commits', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execute = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'smrt-adoption-git-'));
  const repository = join(dir, 'repo'),
    remote = join(dir, 'remote');
  const git = async (...args) =>
    (await execute('git', ['-C', repository, ...args])).stdout.trim();
  const command = async (tool, args) => (await execute(tool, args)).stdout;
  try {
    await execute('git', ['init', '--bare', remote]);
    await execute('git', ['init', '-b', 'main', repository]);
    await git('config', 'user.email', 'adoption-unit@example.test');
    await git('config', 'user.name', 'Adoption Unit');
    await writeFile(join(repository, 'unrelated.txt'), 'retained\n');
    await git('add', '.');
    await git('commit', '-m', 'initial');
    await git('remote', 'add', 'origin', remote);
    await git('push', 'origin', 'main');
    const { plan } = fixture();
    const fluxPath = plan.canonicalFile.slice(0, plan.canonicalFile.lastIndexOf('/'));
    let fences = 0, staleFence = false;
    const methods = createAdoptionMethods(
      { repository, branch: 'main', adoption: { fluxPath } },
      command,
      {},
      { adoptionFenceObserver: async () => { fences++; return staleFence ? { ...fence(plan), observedAt: Date.now() - 60000 } : fence(plan); } },
    );
    const adapter = unitAdapter(plan);
    // Produce valid protocol journals while exercising publication against a real local bare remote.
    let snapshot = await methods.readAdoption(plan);
    await adoptOrResume(fixture().config, adapter, plan);
    const planned = adapter.snapshot().state;
    await methods.casAdoption(snapshot, plan, planned);
    snapshot = await methods.readAdoption(plan);
    assert.equal(snapshot.state.stage, 'planned');
    assert.equal(
      await git('show', `${snapshot.revision}:unrelated.txt`),
      'retained',
    );
    // A complete staged tree is generated once, then canonical + final journal replace it in one commit.
    for (let i = 0; i < 3; i++) {
      await adoptOrResume(fixture().config, adapter, plan);
      const current = adapter.snapshot();
      await methods.casAdoption(
        snapshot,
        plan,
        current.state,
        current.staging ?? undefined,
      );
      snapshot = await methods.readAdoption(plan);
    }
    const staged = adapter.snapshot();
    snapshot = await methods.readAdoption(plan);
    assert.equal(snapshot.canonical, null);
    assert.ok(snapshot.staging);
    await adoptOrResume(fixture().config, adapter, plan);
    await methods.casAdoption(
      snapshot,
      plan,
      adapter.snapshot().state,
      adapter.snapshot().staging,
    );
    snapshot = await methods.readAdoption(plan);
    await adoptOrResume(fixture().config, adapter, plan);
    const final = adapter.snapshot();
    const beforeFinal = await git('rev-parse', 'origin/main');
    staleFence = true;
    await assert.rejects(() => methods.casAdoption(snapshot, plan, final.state, final.canonical), /fence/i);
    await git('fetch', 'origin');
    assert.equal(await git('rev-parse', 'origin/main'), beforeFinal, 'an unverified fence at the publication boundary pushes nothing');
    staleFence = false;
    // A rejected push is reported as a publication failure, not a generic Git
    // fault, and publishes nothing.
    const hook = join(remote, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(() => methods.casAdoption(snapshot, plan, final.state, final.canonical), /Adoption Git publication failed/);
    await git('fetch', 'origin');
    assert.equal(await git('rev-parse', 'origin/main'), beforeFinal, 'a rejected push publishes nothing');
    await rm(hook, { force: true });
    await methods.casAdoption(snapshot, plan, final.state, final.canonical);
    const published = await methods.readAdoption(plan);
    assert.equal(fences, 8, 'every publication refreshes and verifies the writer fence at its boundary');
    assert.equal(published.staging, null);
    assert.ok(published.canonical);
    assert.equal(
      published.canonical.metadata.annotations[
        'smrt.happyvertical.com/adoption-state'
      ],
      hash(published.state),
    );
    // Same bytes restored later still supersede the observed file history.
    await git('reset', '--hard', 'origin/main');
    const original = published.raw[plan.stateFile];
    await writeFile(join(repository, plan.stateFile), '{}\n');
    await git('add', plan.stateFile);
    await git('commit', '-m', 'racer changes state');
    await writeFile(join(repository, plan.stateFile), original);
    await git('add', plan.stateFile);
    await git('commit', '-m', 'racer restores state');
    await git('push', 'origin', 'main');
    await assert.rejects(
      () => methods.casAdoption(published, plan, final.state, final.canonical),
      /superseded protected history/,
    );
    // A racer adding a manifest under the dedicated Flux directory, outside the
    // proof files, is caught on the exact revision the CAS would build on.
    await git('reset', '--hard', published.revision);
    await git('push', '--force', 'origin', 'main');
    await writeFile(join(repository, fluxPath, 'stray.yaml'), 'kind: ConfigMap\n');
    await git('add', '.');
    await git('commit', '-m', 'racer adds manifest');
    await git('push', 'origin', 'main');
    await assert.rejects(
      () => methods.casAdoption(published, plan, final.state, final.canonical),
      /contains unreviewed resources/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native legacy gates bind actual UID, stop/relinquish revisions, selectors, specs and actual inventory absence', async () => {
  const { createHash } = await import('node:crypto');
  const { plan, config } = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'smrt-adoption-artifact-'));
  try {
    const chart = join(dir, 'chart.tgz');
    await writeFile(chart, 'packaged-chart-unit');
    const byteHash = (s) => createHash('sha256').update(s).digest('hex');
    plan.chartArtifactSha256 = byteHash('packaged-chart-unit');
    const podSpec = {
      containers: [{ name: 'web', image }],
      initContainers: [
        {
          name: 'legacy-init',
          image,
          env: [{ name: 'SECRET_CANARY', value: 'SECRET_CANARY' }],
        },
      ],
    };
    const selector = { matchLabels: { app: 'app-web' } };
    const original = { replicas: 1, selector, template: { spec: podSpec } };
    const normalized = { ...original, replicas: 0 };
    const saved = {
      apiVersion: 'smrt.happyvertical.com/legacy-snapshot-v1',
      adoptionId: plan.adoptionId,
      legacy: plan.legacy,
      normalization: {
        normalizedCurrentIdentity: plan.normalizedCurrentIdentity,
        explanation:
          'Reviewed stop and init-container removal at owning boundary',
      },
      resources: [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          namespace: 'test',
          name: 'app-web',
          uid: 'workload-uid',
          spec: original,
          specIdentity: hash(original),
          normalizedSpecIdentity: hash(normalized),
          selector,
          legacyManager: 'kustomize-controller',
          fluxInventoryId: 'test_app-web_apps_Deployment',
          podSpec,
          oldImages: [image, image],
        },
      ],
    };
    const ingressSpec = { ingressClassName: 'nginx', rules: [{ host: 'fixture.invalid' }] };
    saved.resources.push({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', namespace: 'test', name: 'app-ingress', uid: 'ingress-uid', spec: ingressSpec, specIdentity: hash(ingressSpec), normalizedSpecIdentity: hash(ingressSpec), selector: {}, legacyManager: 'kustomize-controller', fluxInventoryId: 'test_app-ingress_networking.k8s.io_Ingress' });
    const snapshotBytes = JSON.stringify(saved);
    plan.snapshot.sha256 = byteHash(snapshotBytes);
    const q = {
      apiVersion: 'smrt.happyvertical.com/legacy-adoption-qualification-v1',
      adoptionId: plan.adoptionId,
      snapshotSha256: plan.snapshot.sha256,
      normalizedCurrentIdentity: plan.normalizedCurrentIdentity,
      targetIdentity: plan.targetIdentity,
      configurationIdentity: plan.configurationIdentity,
      chartArtifactSha256: plan.chartArtifactSha256,
      chartOciDigest: plan.chartOciDigest,
      fenceContractIdentity: plan.fenceContract.identity,
      source: 'trusted-ci-run',
      tree: 'tree',
      lock: 'lock',
      toolchain: 'Node26',
      validation: { passed: true },
    };
    const qualificationBytes = JSON.stringify(q);
    plan.qualification.sha256 = byteHash(qualificationBytes);
    Object.assign(config, {
      chart,
      repository: '/unit',
      source: { name: 'new-source', namespace: 'flux-system' },
      kustomization: { name: 'new-app', namespace: 'test' },
      chartSource: { digest: plan.chartOciDigest },
    });
    Object.assign(config.adoption, {
      fluxPath: 'apps',
      sourceUid: 'new-source-uid',
      kustomizationUid: 'new-ks-uid',
      snapshotSha256: plan.snapshot.sha256,
      qualificationSha256: plan.qualification.sha256,
    });
    const condition = {
      conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }],
    };
    const targetKS = {
      metadata: { uid: 'new-ks-uid', namespace: 'test' },
      spec: {
        path: './apps',
        sourceRef: {
          kind: 'GitRepository',
          name: 'new-source',
          namespace: 'flux-system',
        },
      },
    };
    const source = {
      metadata: { uid: plan.legacy.source.uid, generation: 1 },
      spec: { url: plan.legacy.repository, ref: { branch: 'legacy' } },
      status: { ...condition, artifact: { revision: `main@sha1:${revision}` } },
    };
    const ks = {
      metadata: { uid: plan.legacy.kustomization.uid, generation: 1 },
      spec: { prune: false },
      status: {
        ...condition,
        lastAppliedRevision: `main@sha1:${revision}`,
        inventory: { entries: [] },
      },
    };
    const actual = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        namespace: 'test',
        name: 'app-web',
        uid: 'workload-uid',
        labels: { 'app.kubernetes.io/managed-by': 'Helm' },
        annotations: {
          'meta.helm.sh/release-name': 'app',
          'meta.helm.sh/release-namespace': 'test',
          'kustomize.toolkit.fluxcd.io/prune': 'disabled',
        },
        managedFields: [{ manager: 'kustomize-controller' }],
      },
      spec: structuredClone(normalized),
    };
    const ingress = { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { ...structuredClone(actual.metadata), name: 'app-ingress', uid: 'ingress-uid' }, spec: structuredClone(ingressSpec) };
    const snapshot = {
      revision,
      raw: {
        [plan.snapshot.file]: snapshotBytes,
        [plan.qualification.file]: qualificationBytes,
      },
    };
    // After finalization the legacy objects may be gone (retired); the fake
    // models deletion by name through getIfPresent only.
    const deleted = new Set();
    const helpers = {
      get: async (kind, name) => {
        // A plain read of a deleted object fails like the live adapter's.
        if (deleted.has(kind) && !['new-app', 'new-source'].includes(name))
          throw new Error(`Kubernetes read failed: get ${kind}/${name}`);
        return name === 'new-app'
          ? targetKS
          : name === 'new-source'
            ? { metadata: { uid: 'new-source-uid' } }
            : kind === 'gitrepository'
              ? source
              : ks;
      },
      getIfPresent: async (kind, name) => (deleted.has(kind) ? null : helpers.get(kind, name)),
      namespaceInventory: async () => [actual, ingress],
      verifyStopped: async () => {},
      maintenance: async () => {},
      bindings: async () => sha,
    };
    const commands = [];
    let failGit = null;
    const methods = createAdoptionMethods(
      config,
      async (tool, args) => {
        commands.push([tool, ...args]);
        if (tool === 'git' && failGit && args.join(' ').includes(failGit)) throw new Error('git failed');
        return '';
      },
      helpers,
      { adoptionFenceObserver: async () => fence(plan) },
    );
    assert.ok(await methods.qualifyAdoption(plan, snapshot));
    commands.length = 0;
    assert.ok(await methods.observeLegacy(plan, snapshot, 'legacy-stopped'));
    // Legacy ancestry is proven in a private store fetched from the legacy
    // repository's tracked ref, never in the deployment checkout.
    const legacyGit = commands.filter(([tool, , dir]) => tool === 'git' && /\.git-smrt-legacy-/.test(dir));
    const store = legacyGit[0][2];
    assert.deepEqual(commands.filter(([tool, ...args]) => tool === 'git' && args.includes(store)).map((c) => c.slice(1).join(' ').replace(store, 'STORE')), [
      `init --quiet --bare STORE`,
      `-C STORE fetch --quiet --no-tags ${plan.legacy.repository} +refs/heads/legacy:refs/smrt/legacy`,
      ...[plan.legacy.revision, plan.legacy.maintenanceRevision, plan.legacy.stopRevision].map((r) => `-C STORE cat-file -e ${r}^{commit}`),
      ...[plan.legacy.revision, plan.legacy.maintenanceRevision, plan.legacy.stopRevision].map((r) => `-C STORE merge-base --is-ancestor ${r} ${plan.legacy.stopRevision}`),
      `-C STORE merge-base --is-ancestor ${plan.legacy.stopRevision} refs/smrt/legacy`,
    ]);
    assert.ok(!commands.some(([tool, , dir, verb]) => tool === 'git' && dir === '/unit' && ['merge-base', 'cat-file', 'fetch'].includes(verb)), 'no ancestry query against the deployment repository');
    commands.length = 0;
    assert.ok(await methods.observeLegacy(plan, snapshot, 'relinquished'));
    assert.ok(commands.some(([tool, ...args]) => tool === 'git' && args.includes('cat-file') && args.includes(`${plan.legacy.relinquishRevision}^{commit}`)), 'the relinquish revision is required once relinquished');
    for (const failure of ['cat-file', 'merge-base --is-ancestor', 'fetch --quiet']) {
      failGit = failure;
      await assert.rejects(methods.observeLegacy(plan, snapshot, 'legacy-stopped'), /git/);
    }
    failGit = null;
    const ref = source.spec.ref;
    delete source.spec.ref;
    await assert.rejects(methods.observeLegacy(plan, snapshot, 'legacy-stopped'), /reviewed branch or tag/);
    source.spec.ref = { tag: 'bad ref' };
    await assert.rejects(methods.observeLegacy(plan, snapshot, 'legacy-stopped'), /reviewed branch or tag/);
    source.spec.ref = ref;
    config.adoption.legacyFetchUrl = '/srv/mirrors/legacy.git';
    commands.length = 0;
    assert.ok(await methods.observeLegacy(plan, snapshot, 'legacy-stopped'));
    assert.ok(commands.some(([tool, ...args]) => tool === 'git' && args.includes('fetch') && args.includes('/srv/mirrors/legacy.git')), 'fetches from the protected operator-reachable address');
    for (const bad of ['relative/path', 'https://user:secret@example.test/legacy.git', 'ftp://example.test/legacy.git']) {
      config.adoption.legacyFetchUrl = bad;
      await assert.rejects(methods.observeLegacy(plan, snapshot, 'legacy-stopped'), /Invalid legacy fetch source/);
    }
    delete config.adoption.legacyFetchUrl;
    assert.ok(await methods.observeLegacy(plan, snapshot, 'relinquished'));
    const statusEntry = { manager: 'nginx-ingress-controller', subresource: 'status', fieldsType: 'FieldsV1', fieldsV1: { 'f:status': { 'f:loadBalancer': {} } } };
    ingress.metadata.managedFields.push(statusEntry);
    assert.ok(await methods.observeLegacy(plan, snapshot, 'relinquished'), 'authenticated status subresource ownership is not specification ownership');
    for (const invalid of [
      { ...statusEntry, subresource: undefined },
      { ...statusEntry, fieldsV1: { 'f:spec': {} } },
      { ...statusEntry, fieldsV1: { 'f:status': {}, 'f:metadata': {} } },
      { ...statusEntry, fieldsType: undefined },
    ]) {
      ingress.metadata.managedFields[1] = invalid;
      await assert.rejects(methods.observeLegacy(plan, snapshot, 'relinquished'), /field manager/);
    }
    ingress.metadata.managedFields[1] = statusEntry;
    for (const [object, key, value, expected] of [
      [
        actual.metadata,
        'uid',
        'wrong',
        /UID\/spec\/selector|Unknown or unsupported/,
      ],
      [ingress.metadata, 'uid', 'wrong', /UID\/spec\/selector/],
      [ingress.spec, 'ingressClassName', 'changed', /UID\/spec\/selector/],
      [source.metadata, 'uid', 'wrong', /Legacy Flux UID/],
      [
        source.status.artifact,
        'revision',
        `main@sha1:${'c'.repeat(40)}`,
        /reviewed revision/,
      ],
      [
        actual.spec,
        'selector',
        { matchLabels: { app: 'other' } },
        /UID\/spec\/selector/,
      ],
      [
        ks.status.inventory,
        'entries',
        [{ id: saved.resources[0].fluxInventoryId }],
        /inventory remains managed/,
      ],
      [
        actual.metadata,
        'managedFields',
        [{ manager: 'foreign-owner' }],
        /field manager/,
      ],
      [ks.spec, 'prune', true, /pruning/],
      [targetKS.spec, 'path', './foreign', /identity\/path/],
    ]) {
      const before = object[key];
      object[key] = value;
      await assert.rejects(
        () => methods.observeLegacy(plan, snapshot, 'relinquished'),
        (error) =>
          expected.test(error.message) &&
          !error.message.includes('SECRET_CANARY'),
      );
      object[key] = before;
    }
    // Helm establishment: stage allowlist, fresh fence, one release, bounded
    // orphans; afterwards a returning legacy manager blocks.
    const helmEntry = { manager: 'helm-controller', operation: 'Apply', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': { 'f:replicas': {} }, 'f:metadata': { 'f:labels': { 'f:app.kubernetes.io/managed-by': {} } } } };
    const legacyEntry = { manager: 'kustomize-controller', operation: 'Apply', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': { 'f:replicas': {}, 'f:paused': {} }, 'f:metadata': { 'f:labels': { 'f:kustomize.toolkit.fluxcd.io/name': {}, 'f:kustomize.toolkit.fluxcd.io/namespace': {} }, 'f:annotations': { 'f:kustomize.toolkit.fluxcd.io/prune': {} } } } };
    const reset = (...extra) => {
      for (const o of [actual, ingress])
        o.metadata.managedFields = [structuredClone(legacyEntry), helmEntry, ...extra, ...(o === ingress ? [statusEntry] : [])];
    };
    const adopted = {
      ...snapshot,
      canonical: {
        spec: structuredClone(plan.candidate.spec),
        metadata: {
          annotations: {
            'smrt.happyvertical.com/adoption-id': plan.adoptionId,
            'smrt.happyvertical.com/adoption-plan': hash(plan),
          },
        },
      },
    };
    const released = [];
    let releaseWorks = true, fences = 0;
    Object.assign(helpers, {
      acknowledge: async () => {},
      provePhase: async () => ({ bindings: sha }),
      helmOwner: (o) => assert.ok(o.metadata.managedFields.some((e) => e.manager === 'helm-controller')),
      releaseLegacyManager: async (o, manager, document, record) => {
        assert.equal(document, adopted.canonical);
        assert.ok(fences > 0, 'fence observed before any release');
        assert.match(record, /^([a-f0-9]{64}|none)$/);
        released.push([o.kind, manager]);
        if (releaseWorks) {
          // Server-faithful: the update attributes the changed annotation to
          // the request's field manager (verified on kind v1.34.3).
          o.metadata.managedFields = [
            ...o.metadata.managedFields.filter((e) => e.manager !== manager),
            { manager: 'smrt-adoption', operation: 'Update', fieldsType: 'FieldsV1', fieldsV1: { 'f:metadata': { 'f:annotations': { 'f:smrt.happyvertical.com/adoption-orphaned-fields': {} } } } },
          ];
          o.metadata.annotations = { ...o.metadata.annotations, 'smrt.happyvertical.com/adoption-orphaned-fields': record };
        }
      },
    });
    let staleFence = false;
    const counting = createAdoptionMethods(config, async () => '', helpers, {
      adoptionFenceObserver: async () => {
        fences++;
        return staleFence ? { ...fence(plan), observedAt: Date.now() - 60000 } : fence(plan);
      },
    });
    reset();
    staleFence = true;
    await assert.rejects(counting.observeAdopted(plan, adopted, 'helm-established'), /fence/i);
    assert.equal(released.length, 0, 'an unverified fence blocks the release');
    staleFence = false;
    fences = 0;
    reset();
    const established = await counting.observeAdopted(plan, adopted, 'helm-established');
    assert.deepEqual(released, [['Deployment', 'kustomize-controller'], ['Ingress', 'kustomize-controller']]);
    assert.equal(fences, 1);
    assert.deepEqual(established.resources.map((r) => [r.legacyManager, r.managers, typeof r.orphanedFieldsIdentity]), [['kustomize-controller', ['helm-controller'], 'string'], ['kustomize-controller', ['helm-controller'], 'string']], 'status managers excluded; reviewed orphans recorded by identity');
    assert.ok(ingress.metadata.managedFields.includes(statusEntry), 'other managers are preserved');
    const again = await counting.observeAdopted(plan, adopted, 'helm-established');
    assert.equal(released.length, 2, 'an already released resource is not patched again');
    assert.equal(fences, 1, 'no fence needed without a release');
    assert.deepEqual(again.resources.map((r) => r.orphanedFieldsIdentity), established.resources.map((r) => r.orphanedFieldsIdentity), 'the recorded orphan identity survives a failed publication and resume');
    for (const o of [actual, ingress]) delete o.metadata.annotations['smrt.happyvertical.com/adoption-orphaned-fields'];
    assert.deepEqual((await counting.observeAdopted(plan, adopted, 'helm-established')).resources.map((r) => r.orphanedFieldsIdentity), [null, null], 'no record means no release happened here');
    await assert.rejects(counting.observeAdopted(plan, adopted, 'finalized'), /must be suspended before finalization/);
    ks.spec.suspend = true;
    // Suspending bumps the generation; the suspended controller never catches up.
    ks.metadata.generation = 2;
    await assert.rejects(counting.observeAdopted(plan, adopted, 'helm-established'), /not acknowledged|must not be suspended/);
    assert.ok(await counting.observeAdopted(plan, adopted, 'finalized'), 'the last reconciled Ready acknowledges a retired Kustomization');
    const conditions = ks.status.conditions;
    ks.status.conditions = [];
    await assert.rejects(counting.observeAdopted(plan, adopted, 'finalized'), /not acknowledged/);
    ks.status.conditions = conditions;
    assert.ok(await counting.observeAdopted(plan, adopted, 'finalized'));
    // Retired for good: a deleted legacy Kustomization (and source) is the
    // state assertAdoptionComplete already accepts, so the finalized
    // reobservation accepts it too — but only once the journal records
    // finalization. The observation that commits finalization (journal still
    // at helm-established) must see the suspended applier; before that
    // absence is an error, and a same-name replacement with another UID
    // never passes.
    deleted.add('kustomization');
    await assert.rejects(counting.observeAdopted(plan, { ...adopted, state: { stage: 'helm-established' } }, 'finalized'), /Kubernetes read failed/, 'absence is refused while committing finalization');
    await assert.rejects(counting.observeAdopted(plan, { ...adopted, state: { stage: 'helm-established' } }, 'helm-established'), /Kubernetes read failed/);
    const retired = { ...adopted, state: { stage: 'finalized' } };
    assert.ok(await counting.observeAdopted(plan, retired, 'finalized'), 'deleted legacy Kustomization is retired');
    deleted.add('gitrepository');
    assert.ok(await counting.observeAdopted(plan, retired, 'finalized'), 'deleted legacy source too');
    deleted.delete('kustomization');
    assert.ok(await counting.observeAdopted(plan, retired, 'finalized'), 'suspended Kustomization without its source');
    deleted.clear();
    source.metadata.uid = 'replacement';
    deleted.add('kustomization');
    await assert.rejects(counting.observeAdopted(plan, retired, 'finalized'), /not acknowledged/);
    source.metadata.uid = plan.legacy.source.uid;
    deleted.clear();
    const uid = ks.metadata.uid;
    ks.metadata.uid = 'replacement';
    await assert.rejects(counting.observeAdopted(plan, retired, 'finalized'), /not acknowledged/);
    ks.metadata.uid = uid;
    // A present but unsuspended applier is still refused at the retired stage.
    delete ks.spec.suspend;
    await assert.rejects(counting.observeAdopted(plan, retired, 'finalized'), /must be suspended/);
    ks.spec.suspend = true;
    actual.metadata.managedFields.unshift(structuredClone(legacyEntry));
    await assert.rejects(counting.observeAdopted(plan, adopted, 'finalized'), /returned after establishment/);
    assert.equal(released.length, 2, 'nothing is released after establishment');
    delete ks.spec.suspend;
    ks.metadata.generation = 1;
    for (const entry of [
      { manager: 'kubectl-patch', operation: 'Update', fieldsType: 'FieldsV1', fieldsV1: { 'f:metadata': { 'f:annotations': { 'f:smrt.happyvertical.com/adoption-orphaned-fields': {} } } } },
      { manager: 'smrt-adoption', operation: 'Update', fieldsType: 'FieldsV1', fieldsV1: { 'f:metadata': { 'f:annotations': { 'f:smrt.happyvertical.com/adoption-orphaned-fields': {}, 'f:other': {} } } } },
      { manager: 'smrt-adoption', operation: 'Update', fieldsType: 'FieldsV1', fieldsV1: { 'f:data': { 'f:a': {} } } },
      { manager: 'smrt-adoption', operation: 'Apply', fieldsType: 'FieldsV1', fieldsV1: { 'f:metadata': { 'f:annotations': { 'f:smrt.happyvertical.com/adoption-orphaned-fields': {} } } } },
    ]) {
      reset(entry);
      await assert.rejects(counting.observeAdopted(plan, adopted, 'helm-established'), /Unreviewed adopted resource field manager/, `record manager owning more than its annotation: ${JSON.stringify(entry).slice(0, 80)}`);
    }
    assert.equal(released.length, 2);
    reset({ manager: 'kubectl-edit', operation: 'Update', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': { 'f:replicas': {} } } });
    await assert.rejects(counting.observeAdopted(plan, adopted, 'helm-established'), /Unreviewed adopted resource field manager/);
    assert.equal(released.length, 2, 'a foreign manager blocks before any release');
    reset();
    actual.metadata.managedFields[0].fieldsV1['f:metadata']['f:labels']['f:team'] = {};
    await assert.rejects(counting.observeAdopted(plan, adopted, 'helm-established'), /unreviewed fields outside the Helm render/);
    assert.equal(released.length, 2);
    reset();
    releaseWorks = false;
    await assert.rejects(counting.observeAdopted(plan, adopted, 'helm-established'), /legacy field manager not released/);
    reset();
    helpers.releaseLegacyManager = async () => { throw new Error('Legacy field manager release failed'); };
    await assert.rejects(counting.observeAdopted(plan, adopted, 'helm-established'), /release failed/);
    for (const o of [actual, ingress]) o.metadata.managedFields = o === ingress ? [{ manager: 'kustomize-controller' }, statusEntry] : [{ manager: 'kustomize-controller' }];
    const before = snapshot.raw[plan.qualification.file];
    snapshot.raw[plan.qualification.file] = '{"passed":true}';
    await assert.rejects(
      () => methods.qualifyAdoption(plan, snapshot),
      /content mismatch/,
    );
    snapshot.raw[plan.qualification.file] = before;
    config.adoption.qualificationSha256 = 'f'.repeat(64);
    await assert.rejects(
      () => methods.qualifyAdoption(plan, snapshot),
      /protected configuration/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native normal-command interlock refuses pending live markers, missing journals, and final annotation mismatch', async () => {
  const { plan, config } = fixture();
  const adapter = unitAdapter(plan);
  for (const stage of adoptionStages)
    await adoptOrResume(config, adapter, plan);
  const final = adapter.snapshot();
  let pending = false,
    staging = false,
    journal = final.state,
    legacyKs = null;
  const methods = createAdoptionMethods(
    config,
    async (tool, args) => {
      if (tool === 'kubectl' && args.includes('kustomizations.kustomize.toolkit.fluxcd.io'))
        return JSON.stringify({
          items: legacyKs ? [legacyKs] : [],
        });
      if (tool === 'kubectl')
        return JSON.stringify({
          items: pending
            ? [
                {
                  metadata: {
                    annotations: {
                      'smrt.happyvertical.com/adoption-status': 'pending',
                    },
                  },
                },
              ]
            : [],
        });
      if (args.includes('ls-tree')) {
        const path = args.at(-1);
        if ([plan.stateFile, plan.stagingFile].includes(path))
          return path === plan.stateFile
            ? journal
              ? `100644 blob ${sha}\t${path}`
              : ''
            : staging
              ? `100644 blob ${sha}\t${path}`
              : '';
        return `040000 tree ${sha}\t${path}`;
      }
      if (args.includes('show')) return JSON.stringify(journal);
      throw new Error('Unexpected fixture operation');
    },
    {},
    {},
  );
  const snapshot = { revision, document: final.canonical };
  await methods.assertAdoptionComplete(snapshot);
  pending = true;
  await assert.rejects(
    () => methods.assertAdoptionComplete(snapshot),
    /Pending live adoption/,
  );
  pending = false;
  staging = true;
  await assert.rejects(
    () => methods.assertAdoptionComplete(snapshot),
    /Pending adoption/,
  );
  staging = false;
  journal = null;
  await assert.rejects(
    () => methods.assertAdoptionComplete(snapshot),
    /journal is missing/,
  );
  journal = final.state;
  const legacyUid = final.state.observations.at(-1).nativeObservation.flux.legacyKustomizationUid;
  legacyKs = { metadata: { uid: legacyUid }, spec: { suspend: true } };
  await methods.assertAdoptionComplete(snapshot);
  legacyKs = { metadata: { uid: 'other-uid' }, spec: {} };
  await methods.assertAdoptionComplete(snapshot);
  legacyKs = { metadata: { uid: legacyUid }, spec: { prune: false } };
  await assert.rejects(() => methods.assertAdoptionComplete(snapshot), /resumed after adoption/);
  legacyKs = null;
  snapshot.document.metadata.annotations[
    'smrt.happyvertical.com/adoption-state'
  ] = 'c'.repeat(64);
  await assert.rejects(
    () => methods.assertAdoptionComplete(snapshot),
    /mismatched adoption journal/,
  );
});


test('reviewed legacy repository accepts exact nonsecret Git SSH and HTTP URLs without normalizing native identity',()=>{
  for(const repository of ['ssh://git@github.com/willgriffin/jobgeni.git','ssh://git@github.com:22/willgriffin/jobgeni.git','https://github.com/willgriffin/jobgeni.git','http://git.fixture.svc.cluster.local:8080/repo.git']){
    const {plan}=fixture();plan.legacy.repository=repository;assert.equal(validateAdoptionPlan(plan).legacy.repository,repository);
  }
  for(const repository of ['ssh://root@github.com/willgriffin/jobgeni.git','ssh://git:password@github.com/willgriffin/jobgeni.git','https://git@github.com/willgriffin/jobgeni.git','https://git:password@github.com/willgriffin/jobgeni.git','https://@github.com/willgriffin/jobgeni.git','https://github.com/willgriffin/jobgeni.git?token=x','ssh://git@github.com/willgriffin/jobgeni.git#fragment','https://github.com/willgriffin/\njobgeni.git','file:///tmp/repo.git','not-a-url']){
    const {plan}=fixture();plan.legacy.repository=repository;assert.throws(()=>validateAdoptionPlan(plan),/legacy revisions/);
  }
});

import { verifyKnownLegacyWorkloads } from './deployment/live-adoption.mjs';
import { verifyPodEnvelope } from './deployment/live.mjs';
test('qualified legacy ancestry accepts actual legacy labels and rejects unknown or forged controller ownership', () => {
  const spec = {
    selector: { matchLabels: { app: 'legacy-site' } },
    template: {
      spec: {
        automountServiceAccountToken: false,
        containers: [{ name: 'app', image }],
      },
    },
  };
  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      namespace: 'test',
      name: 'legacy-site',
      uid: 'deployment',
      labels: { app: 'legacy-site' },
    },
    spec,
  };
  const ref = (o) => ({
    controller: true,
    apiVersion: o.apiVersion,
    kind: o.kind,
    name: o.metadata.name,
    uid: o.metadata.uid,
  });
  const rs = {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      namespace: 'test',
      name: 'legacy-site-hash',
      uid: 'rs',
      labels: { app: 'legacy-site' },
      ownerReferences: [ref(deployment)],
    },
    spec: structuredClone(spec),
  };
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      namespace: 'test',
      name: 'legacy-site-pod',
      uid: 'pod',
      labels: { app: 'legacy-site' },
      ownerReferences: [ref(rs)],
    },
    spec: structuredClone(spec.template.spec),
  };
  const saved = {
    resources: [
      {
        apiVersion: deployment.apiVersion,
        kind: deployment.kind,
        namespace: 'test',
        name: deployment.metadata.name,
        uid: deployment.metadata.uid,
        normalizedSpecIdentity: hash(spec),
        selector: spec.selector,
      },
    ],
  };
  const all = [deployment, rs, pod];
  verifyKnownLegacyWorkloads(all, saved, verifyPodEnvelope);
  for (const mutate of [
    (a) => (a[0].metadata.uid = 'other'),
    (a) => (a[1].metadata.ownerReferences[0].controller = false),
    (a) => (a[1].metadata.ownerReferences[0].kind = 'Job'),
    (a) => (a[2].metadata.ownerReferences[0].name = 'forged'),
    (a) => (a[2].metadata.namespace = 'foreign'),
    (a) => a[2].spec.containers.push({ name: 'writer', image }),
    (a) =>
      a.push({
        ...structuredClone(deployment),
        metadata: { ...deployment.metadata, name: 'unknown', uid: 'unknown' },
      }),
  ]) {
    const bad = structuredClone(all);
    mutate(bad);
    assert.throws(() =>
      verifyKnownLegacyWorkloads(bad, saved, verifyPodEnvelope),
    );
  }
});

test('adoption gate admits only stage-appropriate spec managers', () => {
  const { plan } = fixture();
  for (const [stage, managers, ok] of [
    ['planned', ['kustomize-controller'], true],
    ['helm-staged', ['kustomize-controller', 'kube-controller-manager'], true],
    ['helm-staged', ['helm-controller'], false],
    ['helm-established', ['helm-controller'], true],
    ['helm-established', ['kustomize-controller'], false],
    ['finalized', ['helm-controller', 'kube-scheduler'], true],
    ['finalized', ['kustomize-controller'], false],
    ['finalized', ['kubectl-edit'], false],
  ]) {
    const observation = native(plan, stage);
    observation.resources[0].managers = managers;
    observation.inventoryIdentity = hash(observation.resources);
    const run = () => verifyAdoptionGate(plan, stage, observation, fence(plan));
    if (ok) assert.ok(run(), `${stage} ${managers}`);
    else assert.throws(run, /safe native adoption observation/, `${stage} ${managers}`);
  }
  assert.deepEqual(allowedManagers('planned', { legacyManager: 'legacy-applier' }), ['kube-controller-manager', 'kube-scheduler', 'legacy-applier']);
  const observation = native(plan, 'finalized');
  observation.resources[0].orphanedFieldsIdentity = 'not-a-sha';
  observation.inventoryIdentity = hash(observation.resources);
  assert.throws(() => verifyAdoptionGate(plan, 'finalized', observation, fence(plan)), /safe native adoption observation/);
});

test('legacy ancestry is proven against the legacy repository in push order and cleans up its store', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execute = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'smrt-legacy-ancestry-'));
  const legacyBare = join(dir, 'legacy.git'), work = join(dir, 'work'), repository = join(dir, 'deploy');
  const command = async (tool, args) => (await execute(tool, args)).stdout;
  const git = async (...args) => (await execute('git', ['-C', work, ...args])).stdout.trim();
  try {
    await execute('git', ['init', '--bare', '--initial-branch=legacy', legacyBare]);
    await execute('git', ['init', '-b', 'legacy', work]);
    await execute('mkdir', ['-p', repository]);
    await git('config', 'user.email', 'legacy@example.test');
    await git('config', 'user.name', 'Legacy');
    await git('remote', 'add', 'origin', legacyBare);
    const commit = async (name) => { await writeFile(join(work, 'app.yaml'), `${name}\n`); await git('add', '.'); await git('commit', '-q', '-m', name); return git('rev-parse', 'HEAD'); };
    const revision = await commit('active'), maintenanceRevision = await commit('maintenance'), stopRevision = await commit('stop');
    await git('push', '-q', 'origin', 'HEAD:legacy');
    const relinquishRevision = await commit('relinquish');
    const plan = { legacy: { revision, maintenanceRevision, stopRevision, relinquishRevision } };
    const prove = (rev, relinquished, overrides = {}) => proveLegacyAncestry({ command, repository, plan: { legacy: { ...plan.legacy, ...overrides } }, ref: 'refs/heads/legacy', fetchUrl: legacyBare, rev, relinquished });
    await prove(stopRevision, false);
    await assert.rejects(prove(relinquishRevision, true), /git/, 'relinquish revision not yet pushed');
    await git('push', '-q', 'origin', 'HEAD:legacy');
    await prove(relinquishRevision, true);
    await prove(stopRevision, false);
    await assert.rejects(prove(revision, false, { stopRevision: revision, maintenanceRevision }), /git/, 'stop must descend from maintenance');
    await git('checkout', '-q', '-b', 'other');
    const stray = await commit('stray');
    await git('push', '-q', 'origin', 'HEAD:other');
    await assert.rejects(prove(stray, true, { relinquishRevision: stray }), /git/, 'observed revision must be on the tracked ref');
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual((await readdir(repository)).filter((n) => n.startsWith('.git-smrt-legacy-')), [], 'private stores are removed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot request and Flux inventory ids are strict', () => {
  const request = {
    apiVersion: snapshotRequestVersion,
    adoptionId: 'adopt-1',
    legacy: {
      revision,
      source: { namespace: 'flux-system', name: 'legacy' },
      kustomization: { namespace: 'flux-system', name: 'legacy-app' },
    },
    current: { workloads: {} },
    explanation: 'Reviewed stop scales Deployments to zero',
  };
  assert.ok(validateSnapshotRequest(structuredClone(request)));
  assert.ok(validateSnapshotRequest({ ...request, legacy: { ...request.legacy, maintenanceRevision: revision, stopRevision: revision, relinquishRevision: revision } }));
  for (const broken of [
    { ...request, apiVersion: 'smrt.happyvertical.com/legacy-snapshot-v1' },
    { ...request, legacy: { ...request.legacy, stopRevision: revision } },
    { ...request, legacy: { ...request.legacy, revision: 'HEAD' } },
    { ...request, legacy: { ...request.legacy, source: { namespace: 'flux-system', name: 'legacy', uid: 'x' } } },
    { ...request, current: {} },
    { ...request, current: [] },
    { ...request, explanation: '  ' },
    { ...request, extra: true },
  ])
    assert.throws(() => validateSnapshotRequest(broken), /snapshot request|legacy/i);
  assert.deepEqual(legacyInventoryEntry('test_app-web_apps_Deployment'), { id: 'test_app-web_apps_Deployment', namespace: 'test', name: 'app-web', group: 'apps', kind: 'Deployment' });
  assert.deepEqual(legacyInventoryEntry('test_cfg__ConfigMap').group, '');
  assert.deepEqual(legacyInventoryEntry('_ns_rbac.authorization.k8s.io_ClusterRole').namespace, '');
  for (const id of ['test_app_Deployment', 'test_a_b_c_d', 'Test_app__ConfigMap', 42, 'test__apps_Deployment'])
    assert.throws(() => legacyInventoryEntry(id), /inventory entry/);
});
test('adopt-snapshot observes the legacy inventory with managed fields, then completes it after the reviewed stop', async () => {
  const { plan, config } = fixture();
  Object.assign(config, { repository: '/unit', source: { name: 'new-source', namespace: 'flux-system' }, kustomization: { name: 'new-app', namespace: 'test' }, chart: '/unit/chart.tgz' });
  const condition = { conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }] };
  const stop = 'c'.repeat(40), maintenance = 'd'.repeat(40), relinquish = 'e'.repeat(40);
  let applied = revision, drift = null, ref = { branch: 'legacy' };
  const source = () => ({ metadata: { uid: 'source-uid', generation: 1 }, spec: { url: 'https://example.test/legacy', ref }, status: { ...condition, artifact: { revision: `legacy@sha1:${applied}` } } });
  let fluxReads = 0;
  // `drift` models a reconcile landing between the first Flux check and the
  // steadiness re-read: a new generation whose Ready condition still matches.
  const ks = () => { const generation = drift && ++fluxReads > 1 ? 2 : 1; return ({ metadata: { uid: 'ks-uid', generation, namespace: 'flux-system' }, spec: { prune: true, sourceRef: { kind: 'GitRepository', name: 'legacy' } }, status: { conditions: [{ type: 'Ready', status: 'True', observedGeneration: generation }], lastAppliedRevision: `legacy@sha1:${applied}`, inventory: { entries: [{ id: 'test_app-web_apps_Deployment', v: 'v1' }, { id: 'test_app-config__ConfigMap', v: 'v1' }, { id: 'other_app-web_apps_Deployment', v: 'v1' }, { id: 'test_app-monitor_batch_CronJob', v: 'v1' }] } } }); };
  const podSpec = { containers: [{ name: 'web', image }], initContainers: [{ name: 'init', image: `${image}-init` }] };
  const selector = { matchLabels: { app: 'app-web' } };
  const managedFields = [
    { manager: 'kustomize-controller', operation: 'Apply', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': {} } },
    { manager: 'kube-controller-manager', operation: 'Update', fieldsType: 'FieldsV1', fieldsV1: { 'f:metadata': { 'f:annotations': { 'f:deployment.kubernetes.io/revision': {} } } } },
    { manager: 'kube-controller-manager', operation: 'Update', subresource: 'status', fieldsType: 'FieldsV1', fieldsV1: { 'f:status': { 'f:replicas': {} } } },
  ];
  const deployment = () => ({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'app-web', namespace: 'test', uid: 'workload-uid', managedFields: structuredClone(managedFields) }, spec: { replicas: applied === revision ? 1 : 0, selector, template: { spec: podSpec } } });
  const cron = () => ({ apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: 'app-monitor', namespace: 'test', uid: 'cron-uid', managedFields: [managedFields[0]] }, spec: { schedule: '* * * * *', suspend: applied !== revision, jobTemplate: { spec: { template: { spec: { containers: [{ name: 'monitor', image }] } } } } } });
  const configMap = () => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'app-config', namespace: 'test', uid: 'config-uid', managedFields: [managedFields[0]] }, data: { key: 'value' } });
  const reads = [];
  const commands = [];
  const helpers = {
    get: async (kind) => (kind === 'gitrepository' ? source() : ks()),
    getManaged: async (type, name, ns) => {
      reads.push(`${type} ${name} ${ns}`);
      return { 'deployment.apps': deployment, 'cronjob.batch': cron, configmap: configMap }[type]();
    },
  };
  const methods = createAdoptionMethods(config, async (tool, args) => { commands.push([tool, ...args]); return ''; }, helpers, {});
  const request = {
    apiVersion: snapshotRequestVersion,
    adoptionId: plan.adoptionId,
    legacy: { revision, source: { namespace: 'flux-system', name: 'legacy' }, kustomization: { namespace: 'flux-system', name: 'legacy-app' } },
    current: plan.candidate.spec.values.current,
    explanation: 'Reviewed stop scales the Deployment to zero and suspends the CronJob',
  };
  const { createHash } = await import('node:crypto');
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const bytesOf = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const capture = await methods.snapshotLegacy(structuredClone(request));
  assert.equal(capture.apiVersion, snapshotCaptureVersion);
  const captureBytes = bytesOf(capture);
  config.adoption.captureSha256 = sha256(captureBytes);
  assert.deepEqual(reads, ['deployment.apps app-web test', 'configmap app-config test', 'cronjob.batch app-monitor test'], 'only this namespace, each object read with managed fields');
  assert.deepEqual(capture.legacy, { repository: 'https://example.test/legacy', revision, source: { namespace: 'flux-system', name: 'legacy', uid: 'source-uid' }, kustomization: { namespace: 'flux-system', name: 'legacy-app', uid: 'ks-uid' } });
  assert.equal(capture.normalization.normalizedCurrentIdentity, plan.normalizedCurrentIdentity);
  const web = capture.resources.find((r) => r.kind === 'Deployment');
  assert.deepEqual({ ...web, spec: undefined, podSpec: undefined }, { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'test', name: 'app-web', uid: 'workload-uid', spec: undefined, specIdentity: hash(deployment().spec), selector, legacyManager: 'kustomize-controller', fluxInventoryId: 'test_app-web_apps_Deployment', podSpec: undefined, oldImages: [image, `${image}-init`] });
  assert.deepEqual(web.podSpec, podSpec);
  assert.equal(capture.resources.find((r) => r.kind === 'ConfigMap').specIdentity, hash({ key: 'value' }));
  assert.ok(capture.resources.every((r) => !('normalizedSpecIdentity' in r)), 'capture precedes the stop');
  // Completion is refused while the legacy applier is not at the stop revision.
  const completion = { ...request, legacy: { ...request.legacy, maintenanceRevision: maintenance, stopRevision: stop, relinquishRevision: relinquish } };
  await assert.rejects(methods.snapshotLegacy(structuredClone(completion), captureBytes), /acknowledged the reviewed revision/);
  await assert.rejects(methods.snapshotLegacy(structuredClone(request), captureBytes), /completion requires/);
  await assert.rejects(methods.snapshotLegacy(structuredClone(completion)), /capture precedes/);
  applied = stop;
  commands.length = 0;
  const snapshot = await methods.snapshotLegacy(structuredClone(completion), captureBytes);
  assert.equal(snapshot.apiVersion, 'smrt.happyvertical.com/legacy-snapshot-v1');
  assert.deepEqual(snapshot.legacy, { ...capture.legacy, maintenanceRevision: maintenance, stopRevision: stop, relinquishRevision: relinquish });
  const stoppedWeb = snapshot.resources.find((r) => r.kind === 'Deployment');
  assert.equal(stoppedWeb.specIdentity, web.specIdentity, 'original spec identity retained');
  assert.equal(stoppedWeb.normalizedSpecIdentity, hash({ ...deployment().spec, replicas: 0 }));
  assert.deepEqual(Object.keys(stoppedWeb), ['apiVersion', 'kind', 'namespace', 'name', 'uid', 'spec', 'specIdentity', 'normalizedSpecIdentity', 'selector', 'legacyManager', 'fluxInventoryId', 'podSpec', 'oldImages']);
  const store = commands.find(([tool, , dir]) => tool === 'git' && /\.git-smrt-legacy-/.test(dir))?.[2];
  assert.ok(store, 'reviewed revisions are proven in the legacy repository');
  assert.ok(commands.some((c) => c.join(' ') === `git -C ${store} fetch --quiet --no-tags https://example.test/legacy +refs/heads/legacy:refs/smrt/legacy`));
  assert.ok(commands.some((c) => c.join(' ') === `git -C ${store} merge-base --is-ancestor ${stop} refs/smrt/legacy`));
  assert.ok(!commands.some((c) => c.join(' ').includes(relinquish)), 'the relinquish commit is pushed only after the writers stop');
  // The completed snapshot is exactly what the plan later qualifies.
  const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;
  plan.legacy = snapshot.legacy;
  plan.snapshot.sha256 = sha256(bytes);
  Object.assign(config.adoption, { fluxPath: 'apps', sourceUid: 'new-source-uid', kustomizationUid: 'new-ks-uid', snapshotSha256: plan.snapshot.sha256, qualificationSha256: plan.qualification.sha256 });
  // The capture is admitted by protected byte identity: any edit, including a
  // self-consistent rewrite of the original PodSpec and images, fails closed
  // unless the protected digest is updated for it.
  const forged = structuredClone(capture);
  const web0 = forged.resources.find((r) => r.kind === 'Deployment');
  web0.podSpec.containers[0].image = 'registry/evil@sha256:' + 'f'.repeat(64);
  web0.spec.template.spec = web0.podSpec;
  web0.oldImages = [web0.podSpec.containers[0].image, `${image}-init`];
  web0.specIdentity = hash(web0.spec);
  await assert.rejects(methods.snapshotLegacy(structuredClone(completion), bytesOf(forged)), /protected adoption.captureSha256/);
  await assert.rejects(methods.snapshotLegacy(structuredClone(completion), Buffer.from(`${captureBytes.toString()} `)), /protected adoption.captureSha256/);
  const bound = async (value, override = {}) => {
    const b = bytesOf(value);
    config.adoption.captureSha256 = sha256(b);
    try { return await methods.snapshotLegacy(structuredClone({ ...completion, ...override }), b); } finally { config.adoption.captureSha256 = sha256(captureBytes); }
  };
  // Even a bound (reviewed) capture must still match the live cluster.
  await assert.rejects(bound({ ...capture, legacy: { ...capture.legacy, kustomization: { ...capture.legacy.kustomization, uid: 'other' } } }), /identity changed/);
  await assert.rejects(bound(capture, { adoptionId: 'adopt-2' }), /belong to this request/);
  await assert.rejects(bound({ ...capture, resources: capture.resources.map((r) => ({ ...r, uid: 'forged' })) }), /UID\/selector changed/);
  await assert.rejects(bound({ ...capture, resources: capture.resources.filter((r) => r.kind !== 'ConfigMap') }), /inventory differs/, 'a dropped record is refused');
  await assert.rejects(bound({ ...capture, resources: capture.resources.map((r) => (r.kind === 'ConfigMap' ? { ...r, kind: 'Secret', name: 'app-config' } : r)) }), /UID\/selector changed|inventory entry/, 'a renamed record is refused');
  // An apply landing between the Flux check and the resource reads fails closed.
  drift = true; fluxReads = 0;
  await assert.rejects(methods.snapshotLegacy(structuredClone(completion), captureBytes), /changed while the snapshot was observed/);
  drift = null;
  ref = {};
  await assert.rejects(methods.snapshotLegacy(structuredClone(completion), captureBytes), /acknowledged the reviewed revision/, 'the source must track a branch or tag');
  ref = { branch: 'legacy' };
  // A second non-native field manager on a legacy object blocks the capture.
  managedFields.push({ manager: 'kubectl-client-side-apply', operation: 'Update', fieldsType: 'FieldsV1', fieldsV1: { 'f:spec': { 'f:replicas': {} } } });
  applied = revision;
  await assert.rejects(methods.snapshotLegacy(structuredClone(request)), /exactly one non-native field manager/);
  managedFields.pop();
  drift = true; fluxReads = 0;
  await assert.rejects(methods.snapshotLegacy(structuredClone(request)), /changed while the snapshot was observed/, 'capture also brackets its reads');
});
test('adopt-snapshot CLI prints the capture and the snapshot and forwards the saved capture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smrt-adopt-snapshot-'));
  try {
    const { plan, config } = fixture();
    const request = { apiVersion: snapshotRequestVersion, adoptionId: plan.adoptionId, legacy: { revision, source: { namespace: 'flux-system', name: 'legacy' }, kustomization: { namespace: 'flux-system', name: 'legacy-app' } }, current: plan.candidate.spec.values.current, explanation: 'reviewed' };
    const configFile = join(dir, 'config.json'), requestFile = join(dir, 'request.json'), captureFile = join(dir, 'capture.json');
    await writeFile(configFile, JSON.stringify(config));
    await writeFile(requestFile, JSON.stringify(request));
    await writeFile(captureFile, JSON.stringify({ apiVersion: snapshotCaptureVersion }));
    const calls = [];
    const adapter = { snapshotLegacy: async (r, capture) => { calls.push([r, capture === null ? null : JSON.parse(capture.toString())]); assert.ok(capture === null || Buffer.isBuffer(capture), 'the capture reaches the adapter as bytes'); return { apiVersion: capture ? 'snapshot' : 'capture' }; } };
    assert.deepEqual(await main(['adopt-snapshot', configFile, requestFile], () => adapter), { apiVersion: 'capture' });
    assert.deepEqual(await main(['adopt-snapshot', configFile, requestFile, captureFile], () => adapter), { apiVersion: 'snapshot' });
    assert.deepEqual(calls.map(([r, c]) => [r.adoptionId, c]), [[plan.adoptionId, null], [plan.adoptionId, { apiVersion: snapshotCaptureVersion }]]);
    await writeFile(requestFile, JSON.stringify({ ...request, explanation: '' }));
    await assert.rejects(main(['adopt-snapshot', configFile, requestFile], () => adapter), /explanation/);
    await assert.rejects(main(['adopt-snapshot', configFile], () => adapter), /request file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
