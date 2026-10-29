import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  adoptionStages,
  adoptOrResume,
  planAdoption,
  validateAdoptionPlan,
  verifyAdoptionGate,
} from './deployment/adopt.mjs';
import { hash } from './deployment/release.mjs';
import { createAdoptionMethods } from './deployment/live-adoption.mjs';
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
    canonicalFile: 'apps/release.json',
    stagingFile: 'apps/adoption.json',
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
        managers: ['kustomize-controller'],
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
    const methods = createAdoptionMethods(
      { repository, branch: 'main' },
      command,
      {},
      {},
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
    await methods.casAdoption(snapshot, plan, final.state, final.canonical);
    const published = await methods.readAdoption(plan);
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
      spec: { url: plan.legacy.repository },
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
    const helpers = {
      get: async (kind, name) =>
        name === 'new-app'
          ? targetKS
          : name === 'new-source'
            ? { metadata: { uid: 'new-source-uid' } }
            : kind === 'gitrepository'
              ? source
              : ks,
      namespaceInventory: async () => [actual, ingress],
      verifyStopped: async () => {},
      maintenance: async () => {},
      bindings: async () => sha,
    };
    const methods = createAdoptionMethods(config, async () => '', helpers, {
      adoptionFenceObserver: async () => fence(plan),
    });
    assert.ok(await methods.qualifyAdoption(plan, snapshot));
    assert.ok(await methods.observeLegacy(plan, snapshot, 'legacy-stopped'));
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
    journal = final.state;
  const methods = createAdoptionMethods(
    config,
    async (tool, args) => {
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
