import assert from 'node:assert/strict';
import test from 'node:test';
import { main as releaseCli } from './deployment/cli.mjs';
import {
  DeploymentError,
  applyOrResume,
  hash,
  identity,
  phases,
  planRelease,
  repair,
  repairRelease,
  validateRepairEvidence,
  transition,
  validate,
} from './deployment/release.mjs';
import {
  createLiveAdapter,
  run,
  verifyRuntime,
  parseObjects,
  containsDesired,
} from './deployment/live.mjs';
const image = `registry/app@sha256:${'a'.repeat(64)}`;
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
const document = (phase = 'active') => ({
  kind: 'HelmRelease',
  metadata: { name: 'example' },
  spec: {
    releaseName: 'example',
    chartRef: { kind: 'OCIRepository', name: 'chart' },
    driftDetection: { mode: 'enabled' },
    install: { strategy: { name: 'RetryOnFailure' } },
    upgrade: { strategy: { name: 'RetryOnFailure' } },
    values: {
      app: { name: 'example', environment: 'test' },
      release: { id: 'release-1', phase, sequence: 1, attempt: 1 },
      current: structuredClone(runtime),
      target: structuredClone(runtime),
      bindings: {},
      ingress: {},
    },
  },
});
const evidence = (doc) => ({
  accepted: true,
  proven: true,
  identity: identity(doc),
  revision: 'abc',
  bindings: 'versions',
});
test('canonical values identity ignores JSON key order', () =>
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 })));
test('new release preserves entire previous runtime', () => {
  const old = document();
  old.spec.values.target.extra = { config: ['all', 'fields'] };
  const plan = planRelease(old, { ...runtime, new: true }, 'release-2');
  assert.deepEqual(plan.spec.values.current, old.spec.values.target);
  assert.equal(plan.spec.values.release.phase, 'maintenance');
  assert.throws(
    () => planRelease(document('verify'), runtime, 'release-2'),
    /unfinished/,
  );
});
test('restart at each phase advances one acknowledged phase', async () => {
  for (const phase of phases.slice(0, -1)) {
    const doc = document(phase);
    let saved;
    const adapter = {
      read: async () => ({ document: doc, revision: 'abc' }),
      observe: async () => evidence(doc),
      preflight: async () => {},
      cas: async (_, next) => {
        saved = next;
      },
    };
    await applyOrResume({}, adapter);
    assert.equal(
      saved.spec.values.release.phase,
      phases[phases.indexOf(phase) + 1],
    );
    assert.equal(saved.spec.values.release.sequence, 2);
  }
});
test('stale evidence and failed proof cannot advance', () => {
  const doc = document('stopped');
  for (const mutation of [
    { identity: 'stale' },
    { accepted: false },
    { proven: false },
  ])
    assert.throws(() => transition(doc, { ...evidence(doc), ...mutation }));
});
test('recovery stops target writers and never restores old image', () => {
  const verify = document('verify');
  assert.equal(
    transition(verify, { ...evidence(verify), proven: false }, true).spec.values
      .release.phase,
    'stopped',
  );
  const active = document();
  active.spec.values.current.workloads.web.image = `registry/old@sha256:${'b'.repeat(64)}`;
  const result = transition(active, evidence(active), true);
  assert.equal(result.spec.values.release.phase, 'maintenance');
  assert.deepEqual(result.spec.values.current, runtime);
  const failed = document('migrate');
  assert.throws(
    () => transition(failed, evidence(failed), true),
    /terminal failed/,
  );
});
function objects() {
  return [
    {
      kind: 'Deployment',
      spec: { template: { spec: { automountServiceAccountToken: false, containers: [{ image }] } } },
      metadata: { name: 'example-web', uid: 'deployment', generation: 2 },
      status: {
        observedGeneration: 2,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
      },
    },
    {
      kind: 'ReplicaSet',
      metadata: { uid: 'rs', ownerReferences: [{ uid: 'deployment' }] },
    },
    {
      kind: 'Pod',
      metadata: { uid: 'pod', ownerReferences: [{ uid: 'rs' }] },
      spec: { automountServiceAccountToken: false, containers: [{ image }] },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [{ imageID: image }],
      },
    },
    {
      kind: 'EndpointSlice',
      metadata: { labels: { 'kubernetes.io/service-name': 'example-web' } },
      endpoints: [{ conditions: { ready: true }, targetRef: { uid: 'pod' } }],
    },
  ];
}
test('ready exact images and endpoint UID pass', async () =>
  verifyRuntime(document('verify'), objects()));
for (const [name, mutate] of [
  [
    'old imageID',
    (o) => {
      o[2].status.containerStatuses[0].imageID = `sha256:${'b'.repeat(64)}`;
    },
  ],
  [
    'stale generation',
    (o) => {
      o[0].status.observedGeneration = 1;
    },
  ],
  [
    'terminating Pod',
    (o) => {
      o[2].metadata.deletionTimestamp = 'now';
    },
  ],
  [
    'old endpoint',
    (o) => {
      o[3].endpoints[0].targetRef.uid = 'old';
    },
  ],
  [
    'unready worker',
    (o) => {
      o[2].status.conditions = [];
    },
  ],
  [
    'unexpected deployment',
    (o) => {
      o.push({ ...o[0], metadata: { ...o[0].metadata, name: 'unknown' } });
    },
  ],
])
  test(`${name} cannot pass readiness`, async () => {
    const actual = objects();
    mutate(actual);
    await assert.rejects(verifyRuntime(document('verify'), actual));
  });
test('subprocess stderr containing secrets is redacted', async () => {
  await assert.rejects(
    run(process.execPath, [
      '-e',
      'console.error("password=do-not-print");process.exit(1)',
    ]),
    (error) => !error.message.includes('do-not-print'),
  );
});
test('live preflight fails before mutation for missing secret permission', async () => {
  const doc = document('maintenance');
  doc.spec.values.bindings.database = {
    secretName: 'database-v1',
    secretKey: 'uri',
  };
  const adapter = createLiveAdapter(
    {
      repository: '.',
      branch: 'main',
      file: 'release.json',
      namespace: 'test',
      source: { name: 'source' },
      kustomization: { name: 'apps' },
      chart: 'chart',
    },
    async () => {
      throw new Error('denied');
    },
  );
  await assert.rejects(
    adapter.preflight(doc),
    (error) =>
      error instanceof DeploymentError &&
      error.code === 'RESOURCE_READ' &&
      error.message.includes('get secret/database-v1 namespace test'),
  );
});
test('competing same-file update fails CAS', async () => {
  const doc = document('maintenance');
  const adapter = createLiveAdapter(
    {
      repository: '.',
      branch: 'main',
      file: 'release.json',
      namespace: 'test',
      source: { name: 'source' },
      kustomization: { name: 'apps' },
      chart: 'chart',
    },
    async (_, args) => {
      if (args.includes('rev-parse')) return 'new-head';
      if (args.includes('show')) return JSON.stringify(document('stopped'));
      return '';
    },
  );
  await assert.rejects(
    adapter.cas({ revision: 'old', raw: JSON.stringify(doc) }, doc),
    /CAS conflict/,
  );
});
function liveFixture(phase = 'stopped', mutate = () => {}, httpStatus) {
  const doc = document(phase);
  doc.metadata.annotations = {
    'smrt.happyvertical.com/binding-versions': hash([]),
  };
  doc.spec.values.ingress.host = 'app.test';
  doc.spec.values.target.workloads.web.role = 'web';
  doc.metadata.generation = 1;
  doc.status = {
    observedGeneration: 1,
    conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }],
  };
  const all = phase === 'verify' || phase === 'active' ? objects() : [];
  all.push({
    kind: 'Ingress',
    metadata: { name: 'example' },
    spec: {
      rules: [
        {
          host: 'app.test',
          http: {
            paths: [
              {
                backend: {
                  service: {
                    name:
                      phase === 'active'
                        ? 'example-web'
                        : 'example-maintenance',
                  },
                },
              },
            ],
          },
        },
      ],
    },
  });
  for (const o of all)
    o.metadata.labels = {
      ...o.metadata.labels,
      'app.kubernetes.io/instance': 'example',
      'smrt.happyvertical.com/release': 'release-1',
      'smrt.happyvertical.com/phase': phase,
      'smrt.happyvertical.com/sequence': '1',
    };
  const source = {
    metadata: { generation: 1 },
    status: {
      conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }],
      artifact: { revision: 'main@sha1:abc' },
      lastAppliedRevision: 'main@sha1:abc',
    },
  };
  const config = {
    repository: '.',
    branch: 'main',
    file: 'release.json',
    namespace: 'test',
    source: { name: 'source' },
    kustomization: { name: 'apps' },
    chart: 'chart',
    chartSource: { name: 'chart', digest: `sha256:${'c'.repeat(64)}` },
    maintenanceAssertions: [{ url: 'https://app.test/', status: 503 }],
    privateAssertions: [
      { url: 'http://example-web.test.svc.cluster.local/health', status: 200 },
    ],
    publicAssertions: [{ url: 'https://app.test/', status: 200 }],
  };
  mutate({ doc, all, config, source });
  const command = async (name, args) => {
    if (name === 'helm') {
      if (args.includes('template')) return 'rendered';
      config.fixtureAfterHelmValues?.();
      return JSON.stringify(doc.spec.values);
    }
    if (args.includes('create'))
      return JSON.stringify({ items: config.fixtureRenderedResources ?? all.filter((o) => o.kind === 'Ingress') });
    if (args.includes('ocirepository'))
      return JSON.stringify({
        ...source,
        spec: { ref: { digest: config.chartSource.digest } },
      });
    if (args.includes('gitrepository') || args.includes('kustomization'))
      return JSON.stringify(source);
    if (args.includes('helmrelease')) return JSON.stringify(doc);
    if (args.includes('secret')) return JSON.stringify(config.fixtureSecret);
    if (args.includes('get')) return JSON.stringify({ items: all });
    throw new Error('Unexpected tool operation');
  };
  const request = async (url) => {
    config.fixtureDuringRequest?.();
    if (config.fixtureRequestError) throw new Error(config.fixtureRequestError);
    return new Response('healthy', {
      status:
        httpStatus ??
        (url.startsWith('https:') && phase !== 'active' ? 503 : 200),
      headers: { 'X-Smrt-Release': 'release-1', 'X-Smrt-Sequence': '1' },
    });
  };
  return { doc, adapter: createLiveAdapter(config, command, request) };
}
test('live stopped proof checks independent maintenance HTTP', async () => {
  const { adapter, doc } = liveFixture();
  assert.equal((await adapter.observe(doc, 'abc')).proven, true);
});
test('live terminating writer and unknown namespace writer fail closed', async () => {
  for (const labels of [{ 'app.kubernetes.io/instance': 'example' }, {}]) {
    const { adapter, doc } = liveFixture('stopped', ({ all }) =>
      all.push({
        kind: 'Pod',
        metadata: { name: 'writer', deletionTimestamp: 'now', labels },
        status: { phase: 'Running' },
      }),
    );
    assert.equal((await adapter.observe(doc, 'abc')).proven, false);
  }
});
test('live verify HTTP500 retains accepted identity for explicit recovery', async () => {
  const { adapter, doc } = liveFixture('verify', () => {}, 500);
  const proof = await adapter.observe(doc, 'abc');
  assert.equal(proof.accepted, true);
  assert.equal(proof.proven, false);
  assert.equal(
    transition(doc, proof, true).spec.values.release.phase,
    'stopped',
  );
});
test('live stale source revision cannot authorize recovery', async () => {
  const { adapter, doc } = liveFixture('verify', ({ source }) => {
    source.status.artifact.revision = 'main@sha1:old';
  });
  await assert.rejects(adapter.observe(doc, 'abc'), /exact Git revision/);
});
test('live public assertions cannot target unrelated healthy host', async () => {
  const { adapter, doc } = liveFixture('active', ({ config }) => {
    config.publicAssertions[0].url = 'https://unrelated.test/';
  });
  assert.equal((await adapter.observe(doc, 'abc')).proven, false);
});
test('fresh install publishes only reviewed bootstrap maintenance', async () => {
  const plan = document('maintenance');
  plan.spec.values.current = false;
  plan.spec.values.release.sequence = 0;
  let published;
  const adapter = {
    read: async () => ({ document: null, revision: 'abc' }),
    preflight: async () => ({ bindings: 'pinned' }),
    cas: async (_, next) => {
      published = next;
    },
  };
  await applyOrResume({}, adapter, { planned: plan });
  assert.equal(published.spec.values.current, false);
  assert.equal(
    published.metadata.annotations['smrt.happyvertical.com/binding-versions'],
    'pinned',
  );
});
test('real Git CAS preserves unrelated monorepo updates and rejects same-file races', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { promisify } = await import('node:util');
  const { execFile } = await import('node:child_process');
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), 'smrt-release-git-'));
  const remote = join(root, 'remote.git');
  const repository = join(root, 'checkout');
  const git = async (...args) =>
    (await exec('git', ['-C', repository, ...args])).stdout.trim();
  try {
    await exec('git', ['init', '--bare', '--initial-branch=main', remote]);
    await exec('git', ['clone', remote, repository]);
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'Deployment test');
    await mkdir(join(repository, 'deploy'));
    await writeFile(
      join(repository, 'deploy/release.json'),
      JSON.stringify(document('maintenance')),
    );
    await git('add', '.');
    await git('commit', '-m', 'initial');
    await git('push', 'origin', 'main');
    const adapter = createLiveAdapter({
      repository,
      branch: 'main',
      file: 'deploy/release.json',
      namespace: 'test',
      source: { name: 'source' },
      kustomization: { name: 'apps' },
      chart: 'chart',
    });
    const snapshot = await adapter.read();
    await writeFile(join(repository, 'unrelated.txt'), 'preserved');
    await git('add', '.');
    await git('commit', '-m', 'unrelated');
    await git('push', 'origin', 'main');
    const next = transition(snapshot.document, evidence(snapshot.document));
    const published = await adapter.cas(snapshot, next);
    assert.equal(
      await git('show', `${published.revision}:unrelated.txt`),
      'preserved',
    );
    assert.equal(
      JSON.parse(await git('show', `${published.revision}:deploy/release.json`))
        .spec.values.release.phase,
      'stopped',
    );
    await assert.rejects(adapter.cas(snapshot, next), /CAS conflict/);
    const fresh = await adapter.read();
    const successor = transition(fresh.document, evidence(fresh.document));
    const results = await Promise.allSettled([
      adapter.cas(fresh, successor),
      adapter.cas(fresh, successor),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('full inventory preflight impersonates reconciler and rejects permission/admission failures', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'smrt-release-preflight-'));
  try {
    const doc = document('maintenance');
    doc.spec.serviceAccountName = 'reconciler';
    doc.spec.values.target.migration.serviceAccountName = 'observer';
    doc.spec.values.target.migration.observerAccess = true;
    doc.spec.chart = { spec: { chart: 'smrt-app', version: '0.1.0' } };
    doc.spec.values.ingress = { host: 'app.test', className: 'nginx' };
    const chart = join(root, 'chart.tgz');
    await writeFile(chart, 'packaged-chart');
    const receipt = {
      chartSourceIdentity: hash({
        ref: { digest: `sha256:${'c'.repeat(64)}` },
      }),
      chartOciDigest: `sha256:${'c'.repeat(64)}`,
      runtimeIdentity: hash(doc.spec.values.target),
      migrationImage: image,
      migrationCommandIdentity: hash(doc.spec.values.target.migration.command),
      migrationProtocol: 'smrt-release-v1',
      validation: { passed: true },
      source: 'commit',
      tree: 'tree',
      lock: 'lock',
      toolchain: 'node26',
      chartArtifactSha256: createHash('sha256')
        .update('packaged-chart')
        .digest('hex'),
      chartReferenceIdentity: hash(doc.spec.chartRef),
      configurationIdentity: hash({
        maintenance: doc.spec.values.maintenance,
        bindings: doc.spec.values.bindings,
        ingress: doc.spec.values.ingress,
      }),
    };
    const receiptFile = join(root, 'evidence.json');
    const content = JSON.stringify(receipt);
    await writeFile(receiptFile, content);
    const config = {
      repository: '.',
      branch: 'main',
      file: 'release.json',
      namespace: 'test',
      source: { name: 'source' },
      kustomization: { name: 'apps' },
      chart,
      chartSource: { name: 'chart', digest: `sha256:${'c'.repeat(64)}` },
      validationEvidence: {
        file: receiptFile,
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    };
    for (const failure of [
      null,
      'permission',
      'admission',
      'storage',
      'named-secret',
      'ownership',
      'foreign-manager',
      'owned',
      'observer-permission',
      'observer-sa',
      'observer-ca',
      'pod-admission',
      'pod-permission',
      'pod-sa-drift',
      'controller-sa-drift',
      'controller-token-volume',
    ]) {
      const calls = [];
      const command = async (name, args, input) => {
        calls.push({ name, args, input });
        if (name === 'helm') return 'rendered';
        if (args.includes('--ignore-not-found')) {
          if (failure === 'ownership')
            return JSON.stringify({ metadata: { name: 'example-inventory' } });
          if (['foreign-manager', 'owned'].includes(failure))
            return JSON.stringify({
              metadata: {
                labels: { 'app.kubernetes.io/managed-by': 'Helm' },
                annotations: {
                  'meta.helm.sh/release-name': 'example',
                  'meta.helm.sh/release-namespace': 'test',
                },
                managedFields: [
                  {
                    manager:
                      failure === 'owned'
                        ? 'helm-controller'
                        : 'foreign-controller',
                    operation: 'Update',
                    fieldsType: 'FieldsV1',
                    fieldsV1: { 'f:data': {} },
                  },
                ],
              },
            });
          return '';
        }
        if (args.includes('ocirepository'))
          return JSON.stringify({
            metadata: { generation: 1 },
            spec: { ref: { digest: config.chartSource.digest } },
            status: {
              conditions: [
                { type: 'Ready', status: 'True', observedGeneration: 1 },
              ],
            },
          });
        if (args.includes('serviceaccount') && args.includes('observer') && failure === 'observer-sa') throw new Error('missing');
        if (args.includes('configmap') && args.includes('kube-root-ca.crt')) return JSON.stringify({ data: failure === 'observer-ca' ? {} : { 'ca.crt': '-----BEGIN CERTIFICATE-----fixture' } });
        if (args.includes('create') && args.includes('--dry-run=server')) {
          if (failure === 'pod-admission') throw new Error('denied');
          const admitted = JSON.parse(input);
          if (failure === 'pod-sa-drift') admitted.spec.serviceAccountName = 'alternate';
          return JSON.stringify(admitted);
        }
        if (args.includes('can-i'))
          return (failure === 'observer-permission' && args.includes('--as=system:serviceaccount:test:observer')) ||
            (failure === 'pod-permission' && args.includes('create') && args.includes('pods')) ||
            (failure === 'permission' &&
            args.includes('configmap/example-inventory')) ||
            (failure === 'storage' && args.includes('secrets')) ||
            (failure === 'named-secret' && args.includes('secret/named-secret'))
            ? 'no'
            : 'yes';
        if (args.includes('apply')) {
          if (failure === 'admission') throw new Error('admission denied');
          const admitted = JSON.parse(input);
          if (admitted.spec?.template) {
            if (failure === 'controller-sa-drift') admitted.spec.template.spec.serviceAccountName = 'alternate';
            if (failure === 'controller-token-volume') admitted.spec.template.spec.volumes = [{ name: 'injected', projected: { sources: [{ serviceAccountToken: { path: 'token' } }] } }];
          }
          return JSON.stringify(admitted);
        }
        if (args.includes('create'))
          return JSON.stringify({
            items: [
              { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'example-web' }, spec: { template: { metadata: { labels: { app: 'example' } }, spec: { automountServiceAccountToken: false, containers: [{ name: 'app', image }] } } } },
              {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: { name: 'example-inventory' },
                data: {
                  'inventory.json': JSON.stringify({
                    secrets: [{ name: 'named-secret' }],
                  }),
                },
              },
            ],
          });
        if (args.some((a) => a.startsWith('pods,')))
          return JSON.stringify({ items: [] });
        return JSON.stringify({ metadata: {} });
      };
      const adapter = createLiveAdapter(config, command);
      if (failure && failure !== 'owned')
        await assert.rejects(
          adapter.preflight(doc),
          (error) =>
            error instanceof DeploymentError &&
            (failure !== 'ownership' ||
              (error.code === 'OWNERSHIP_CONFLICT' &&
                error.message.includes(
                  'namespace test',
                ))),
        );
      else {
        assert.deepEqual(await adapter.preflight(doc), {
          bindings: hash([]),
          bindingReferences: [],
        });
        assert.equal(calls.filter((c) => c.name === 'helm').length, 5);
      }
      for (const call of calls.filter(
        (c) =>
          c.args.includes('apply') ||
          (c.args.includes('can-i') &&
            !c.args.includes('list') &&
            !c.args.some((arg) =>
              /^(gitrepository|kustomization|helmrelease)\//.test(arg),
            )),
      ))
        assert.ok(
          call.args.includes('--as=system:serviceaccount:test:reconciler') || call.args.includes('--as=system:serviceaccount:test:observer'),
        );
      for (const call of calls.filter((c) => c.args.includes('apply'))) {
        assert.ok(call.args.includes('--dry-run=server'));
        assert.ok(call.args.includes('--field-manager=helm-controller'));
        assert.ok(!call.args.includes('--force-conflicts'));
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('kubectl concatenated JSON decoder handles braces inside strings and Lists', () => {
  assert.deepEqual(
    parseObjects(
      '{"kind":"ConfigMap","data":{"text":"brace } and \\\" quote"}}\n{"items":[{"kind":"Service"}]}',
    ),
    [
      { kind: 'ConfigMap', data: { text: 'brace } and " quote' } },
      { kind: 'Service' },
    ],
  );
  assert.throws(() => parseObjects('{"kind":'));
  assert.equal(
    containsDesired(
      { env: [{ name: 'MODE', value: 'wrong' }] },
      { env: [{ name: 'MODE', value: 'expected' }] },
    ),
    false,
  );
});
test('retained terminal declared CronJob Pods are drained; active or terminating ones block', async () => {
  for (const blocked of [false, true]) {
    const { adapter, doc } = liveFixture('stopped', ({ all, doc }) => {
      doc.spec.values.current.workloads.monitor = {
        ...runtime.workloads.web,
        schedule: '*/5 * * * *',
      };
      const labels = all[0].metadata.labels;
      all.push({
        kind: 'CronJob',
        metadata: { name: 'example-monitor', uid: 'cron', labels },
        spec: { suspend: true },
      });
      all.push({
        kind: 'Job',
        metadata: {
          name: 'example-monitor-history',
          uid: 'job',
          labels,
          ownerReferences: [{ uid: 'cron' }],
        },
        status: { succeeded: 1 },
      });
      all.push({
        kind: 'Pod',
        metadata: {
          name: 'example-monitor-history-pod',
          uid: 'monitor-pod',
          labels,
          ownerReferences: [{ uid: 'job' }],
          ...(blocked ? { deletionTimestamp: 'now' } : {}),
        },
        status: { phase: 'Succeeded' },
      });
    });
    assert.equal((await adapter.observe(doc, 'abc')).proven, !blocked);
  }
});
test('migration attempt completion binds actual Pod image; failure cannot retry implicitly', async () => {
  for (const failure of [null, 'job', 'image', 'controller-token-volume', 'controller-sa-drift']) {
    const { adapter, doc } = liveFixture('migrate', ({ all }) => {
      const labels = all[0].metadata.labels;
      const name = 'example-migration-release-1-1';
      all.push({
        kind: 'Job',
        metadata: { name, uid: 'migration-job', labels },
        spec: {
          backoffLimit: 0,
          template: {
            spec: { automountServiceAccountToken: false, restartPolicy: 'Never', containers: [{ image }] },
          },
        },
        status: failure === 'job' ? { failed: 1 } : { succeeded: 1 },
      });
      all.push({
        kind: 'Pod',
        metadata: {
          name: `${name}-pod`,
          uid: 'migration-pod',
          labels,
          ownerReferences: [{ uid: 'migration-job' }],
        },
        spec: { automountServiceAccountToken: false, restartPolicy: 'Never', containers: [{ image }] },
        status: {
          phase: failure === 'job' ? 'Failed' : 'Succeeded',
          containerStatuses: [
            {
              imageID: failure === 'image' ? `sha256:${'b'.repeat(64)}` : image,
            },
          ],
        },
      });
      if (failure === 'controller-token-volume' || failure === 'controller-sa-drift') {
        const jobSpec = all.find((o) => o.kind === 'Job').spec.template.spec;
        const podSpec = all.find((o) => o.kind === 'Pod').spec;
        for (const spec of [jobSpec, podSpec]) {
          if (failure === 'controller-sa-drift') spec.serviceAccountName = 'alternate';
          else spec.volumes = [{ name: 'token', projected: { sources: [{ serviceAccountToken: { path: 'token' } }] } }];
        }
      }
    });
    assert.equal((await adapter.observe(doc, 'abc')).proven, !failure);
  }
});
test('default Helm rollback and mutable OCI source cannot be acknowledged', async () => {
  const badPolicy = liveFixture('stopped', ({ doc }) => {
    delete doc.spec.upgrade.strategy;
  });
  await assert.rejects(
    badPolicy.adapter.observe(badPolicy.doc, 'abc'),
    /RetryOnFailure/,
  );
  const badSource = liveFixture('stopped', ({ config }) => {
    config.chartSource.digest = 'latest';
  });
  await assert.rejects(
    badSource.adapter.observe(badSource.doc, 'abc'),
    /digest-pinned/,
  );
});
test('immutable Secret UID/key/version changes cannot advance a phase', async () => {
  for (const failure of [null, 'mutable', 'uid', 'key', 'version']) {
    const { adapter, doc } = liveFixture('stopped', ({ doc, config }) => {
      doc.spec.values.current.workloads.web.env = [
        {
          name: 'DATABASE_URL',
          valueFrom: { secretKeyRef: { name: 'database-v1', key: 'uri' } },
        },
      ];
      doc.metadata.annotations['smrt.happyvertical.com/binding-versions'] =
        hash([['database-v1', 'uri', 'secret-uid', '1']]);
      config.fixtureSecret = {
        immutable: failure !== 'mutable',
        metadata: {
          uid: failure === 'uid' ? 'different' : 'secret-uid',
          resourceVersion: failure === 'version' ? '2' : '1',
        },
        data: failure === 'key' ? {} : { uri: 'not-logged' },
      };
    });
    assert.equal((await adapter.observe(doc, 'abc')).proven, !failure);
  }
});
test('explicit false is the only zero-runtime bootstrap marker', () => {
  const bootstrap = document('maintenance');
  bootstrap.spec.values.current = false;
  bootstrap.spec.values.release.sequence = 0;
  assert.equal(validate(bootstrap).current, false);
  for (const marker of [
    undefined,
    null,
    true,
    {},
    [],
    { workloads: {} },
    { workloads: { web: {} }, migration: {} },
  ]) {
    const invalid = structuredClone(bootstrap);
    if (marker === undefined) delete invalid.spec.values.current;
    else invalid.spec.values.current = marker;
    assert.throws(() => validate(invalid));
  }
  const missing = structuredClone(bootstrap);
  missing.spec.values = Object.assign(
    Object.create({ current: false }),
    missing.spec.values,
  );
  delete missing.spec.values.current;
  assert.throws(() => validate(missing), /Explicit current/);
  for (const target of [false, true, null, {}, { workloads: {} }]) {
    const invalid = structuredClone(bootstrap);
    invalid.spec.values.target = target;
    assert.throws(() => validate(invalid));
  }
  const wrongPhase = structuredClone(bootstrap);
  wrongPhase.spec.values.release.phase = 'active';
  assert.throws(() => validate(wrongPhase), /Bootstrap/);
  const wrongSequence = structuredClone(bootstrap);
  wrongSequence.spec.values.release.sequence = 1;
  assert.throws(() => validate(wrongSequence), /Bootstrap/);
});
test('bootstrap false survives all acknowledged phases and active recovery sets actual current', () => {
  let doc = document('maintenance');
  doc.spec.values.current = false;
  doc.spec.values.release.sequence = 0;
  for (const phase of phases) {
    assert.equal(validate(doc).release.phase, phase);
    assert.equal(doc.spec.values.current, false);
    if (phase !== 'active') doc = transition(doc, evidence(doc));
  }
  const recovered = transition(doc, evidence(doc), true);
  assert.deepEqual(validate(recovered).current, runtime);
});
test('failed evidence exposes only typed safe diagnostics for image, readiness and HTTP500', async () => {
  for (const [mutate, status, code, message] of [
    [
      ({ all }) => {
        all.find((o) => o.kind === 'Pod').status.containerStatuses[0].imageID =
          `sha256:${'b'.repeat(64)}`;
      },
      undefined,
      'IMAGE_IDENTITY',
      /Runtime imageID mismatch/,
    ],
    [
      ({ all }) => {
        all.find((o) => o.kind === 'Deployment').status.readyReplicas = 0;
      },
      undefined,
      'READINESS',
      /generation is not ready/,
    ],
    [() => {}, 500, 'HTTP_STATUS', /expected 503, received 500/],
    [
      ({ config }) => {
        config.fixtureRequestError = 'credentials=SECRET_CANARY';
      },
      undefined,
      'UNKNOWN_PROOF_FAILURE',
      /Live phase proof failed/,
    ],
  ]) {
    const { adapter, doc } = liveFixture('verify', mutate, status);
    const proof = await adapter.observe(doc, 'abc');
    assert.equal(proof.accepted, true);
    assert.equal(proof.proven, false);
    assert.equal(proof.failureCode, code);
    assert.match(proof.failure, message);
    assert.ok(!JSON.stringify(proof).includes('SECRET_CANARY'));
  }
  await assert.rejects(
    run(process.execPath, [
      '-e',
      'console.error("credentials=SECRET_CANARY");process.exit(1)',
    ]),
    (error) =>
      error instanceof DeploymentError &&
      error.code === 'OPERATION_FAILED' &&
      !error.message.includes('SECRET_CANARY'),
  );
});

test('destructive Helm settings and disabled or excluded drift repair fail before preflight reads', async () => {
  for (const [mutate, diagnostic] of [
    [
      (doc) => {
        doc.spec.install.replace = true;
      },
      /install.replace/,
    ],
    [
      (doc) => {
        doc.spec.upgrade.force = true;
      },
      /upgrade.force/,
    ],
    [
      (doc) => {
        doc.spec.upgrade.cleanupOnFail = true;
      },
      /upgrade.cleanupOnFail/,
    ],
    [
      (doc) => {
        delete doc.spec.driftDetection;
      },
      /driftDetection.mode/,
    ],
    [
      (doc) => {
        doc.spec.driftDetection.mode = 'warn';
      },
      /driftDetection.mode/,
    ],
    [
      (doc) => {
        doc.spec.driftDetection.ignore = [{ paths: ['/spec/replicas'] }];
      },
      /without ignored resources/,
    ],
  ]) {
    const doc = document('maintenance');
    mutate(doc);
    let calls = 0;
    const adapter = createLiveAdapter(
      {
        repository: '.',
        branch: 'main',
        file: 'release.json',
        namespace: 'test',
        source: { name: 'source' },
        kustomization: { name: 'apps' },
        chart: 'chart',
      },
      async () => {
        calls++;
        throw new Error('must not read before settings pass');
      },
    );
    await assert.rejects(
      adapter.preflight(doc),
      (error) =>
        error instanceof DeploymentError &&
        error.code === 'FLUX_POLICY' &&
        diagnostic.test(error.message),
    );
    assert.equal(calls, 0);
    const live = liveFixture('stopped', ({ doc }) => mutate(doc));
    await assert.rejects(
      live.adapter.observe(live.doc, 'abc'),
      (error) =>
        error instanceof DeploymentError && error.code === 'FLUX_POLICY',
    );
  }
});

test('documented CLI plan, apply-or-resume, status and recover dispatch through protected configuration', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const scratch = await mkdtemp(join(tmpdir(), 'smrt-release-cli-'));
  try {
    const configuration = {
      repository: '/checkout/deployment-repo',
      branch: 'main',
      file: 'apps/example/release.json',
      namespace: 'example-production',
      chart: '/artifacts/smrt-app-0.1.0.tgz',
      chartSource: {
        name: 'smrt-app',
        namespace: 'flux-system',
        digest: `sha256:${'c'.repeat(64)}`,
      },
      source: { name: 'deployment-source', namespace: 'flux-system' },
      kustomization: { name: 'example', namespace: 'flux-system' },
      validationEvidence: {
        file: '/artifacts/validated-app.json',
        sha256: 'protected-evidence-identity',
      },
      maintenanceAssertions: [{ url: 'https://example.test/', status: 503 }],
      privateAssertions: [
        {
          url: 'http://example-web.example-production.svc.cluster.local:3000/health',
          status: 200,
          bodyIncludes: 'ready',
        },
      ],
      publicAssertions: [{ url: 'https://example.test/', status: 200 }],
    };
    const configFile = join(scratch, 'deployment-config.json');
    const targetFile = join(scratch, 'target-runtime.json');
    const planFile = join(scratch, 'reviewed-plan.json');
    await writeFile(configFile, JSON.stringify(configuration));
    await writeFile(targetFile, JSON.stringify(runtime));
    let stored = document();
    let writes = 0;
    const phasesChecked = [];
    // This adapter tests CLI dispatch only; its observations are deliberately unit fixtures.
    const factory = (loaded) => {
      assert.deepEqual(loaded, configuration);
      return {
        read: async () => ({ document: stored, revision: 'unit-head' }),
        preflight: async (doc) => {
          phasesChecked.push(doc.spec.values.release.phase);
          return { bindings: 'unit-versions' };
        },
        observe: async (doc, revision) => ({ ...evidence(doc), revision }),
        cas: async (_, next) => {
          stored = next;
          writes++;
          return {
            revision: `unit-revision-${writes}`,
            phase: next.spec.values.release.phase,
          };
        },
      };
    };
    const planned = await releaseCli(
      ['plan', configFile, targetFile, 'release-2'],
      factory,
    );
    assert.equal(planned.spec.values.release.phase, 'maintenance');
    assert.equal(writes, 0);
    await writeFile(planFile, JSON.stringify(planned));
    const published = await releaseCli(
      ['apply-or-resume', configFile, planFile],
      factory,
    );
    assert.equal(published.phase, 'maintenance');
    const status = await releaseCli(['status', configFile], factory);
    assert.equal(status.release.phase, 'maintenance');
    assert.equal(status.evidence.proven, true);
    assert.equal(writes, 1);
    assert.equal(
      (await releaseCli(['apply-or-resume', configFile], factory)).phase,
      'stopped',
    );
    await releaseCli(['apply-or-resume', configFile], factory);
    await releaseCli(['apply-or-resume', configFile], factory);
    assert.equal(stored.spec.values.release.phase, 'verify');
    assert.equal(
      (await releaseCli(['recover', configFile], factory)).phase,
      'stopped',
    );
    assert.deepEqual(phasesChecked, [
      'maintenance',
      'stopped',
      'migrate',
      'verify',
      'stopped',
    ]);
    assert.equal(
      (await releaseCli(['repair', configFile, targetFile], factory)).phase,
      'stopped',
    );
    assert.equal(stored.spec.values.release.attempt, 2);
    assert.equal(
      (await releaseCli(['apply-or-resume', configFile], factory)).phase,
      'migrate',
    );
    stored = null;
    const bootstrap = document('maintenance');
    bootstrap.spec.values.current = false;
    bootstrap.spec.values.release.sequence = 0;
    await writeFile(targetFile, JSON.stringify(bootstrap));
    const initial = await releaseCli(['plan', configFile, targetFile], factory);
    assert.equal(initial.spec.values.current, false);
    assert.equal(stored, null);
    await writeFile(planFile, JSON.stringify(initial));
    assert.equal(
      (await releaseCli(['apply-or-resume', configFile, planFile], factory))
        .phase,
      'maintenance',
    );
    assert.equal(stored.spec.values.current, false);
    const failed = document('migrate');
    stored = transition(
      failed,
      {
        ...evidence(failed),
        failedMigration: {
          jobUid: 'unit-retained-job',
          jobSpecIdentity: 'unit-job-spec',
          name: 'example-migration-release-1-1',
          releaseId: 'release-1',
          attempt: 1,
          targetIdentity: hash(failed.spec.values.target),
        },
      },
      true,
    );
    const corrected = structuredClone(runtime);
    corrected.migration.command = ['node', 'corrected-migration.mjs'];
    await writeFile(targetFile, JSON.stringify(corrected));
    assert.equal(
      (await releaseCli(['repair', configFile, targetFile], factory)).phase,
      'stopped',
    );
    assert.equal(stored.spec.values.release.attempt, 2);
    assert.deepEqual(stored.spec.values.target, corrected);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
test('CLI rejects invalid arguments and redacts malformed configuration at process boundary', async () => {
  await assert.rejects(
    releaseCli(['unknown', '/unused']),
    (error) => error instanceof DeploymentError && /Usage:/.test(error.message),
  );
  await assert.rejects(
    releaseCli(['status']),
    (error) => error instanceof DeploymentError && /Usage:/.test(error.message),
  );
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const scratch = await mkdtemp(join(tmpdir(), 'smrt-release-cli-redaction-'));
  try {
    const config = join(scratch, 'invalid.json');
    await writeFile(config, 'credentials=SECRET_CANARY malformed json');
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        new URL('./deployment/cli.mjs', import.meta.url).pathname,
        'status',
        config,
      ]),
      (error) =>
        error.code === 1 &&
        error.stdout === '' &&
        !error.stderr.includes('SECRET_CANARY') &&
        error.stderr.includes('Deployment command failed'),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('CLI plan rejects inline environment secrets in current, target and bootstrap before returning output', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const scratch = await mkdtemp(
    join(tmpdir(), 'smrt-release-cli-environment-'),
  );
  try {
    const config = join(scratch, 'config.json');
    const input = join(scratch, 'target.json');
    await writeFile(config, '{}');
    for (const location of [
      'current-workload',
      'current-migration',
      'previous-target',
      'new-target',
      'bootstrap',
    ]) {
      let previous = location === 'bootstrap' ? null : document();
      let target = structuredClone(runtime);
      const inline = [{ name: 'PASSWORD', value: 'SECRET_CANARY' }];
      if (location === 'current-workload')
        previous.spec.values.current.workloads.web.env = inline;
      if (location === 'current-migration')
        previous.spec.values.current.migration.env = inline;
      if (location === 'previous-target')
        previous.spec.values.target.workloads.web.env = inline;
      if (location === 'new-target') target.migration.env = inline;
      if (location === 'bootstrap') {
        target = document('maintenance');
        target.spec.values.current = false;
        target.spec.values.release.sequence = 0;
        target.spec.values.target.workloads.web.env = inline;
      }
      await writeFile(input, JSON.stringify(target));
      let returnedOutput = false;
      await assert.rejects(
        releaseCli(['plan', config, input, 'release-2'], () => ({
          read: async () => ({ document: previous }),
        })).then((result) => {
          returnedOutput = true;
          return result;
        }),
        (error) =>
          error instanceof DeploymentError &&
          error.code === 'ENVIRONMENT_REFERENCE' &&
          !error.message.includes('SECRET_CANARY'),
      );
      assert.equal(returnedOutput, false);
    }
    for (const invalid of [
      {
        name: 'PASSWORD',
        valueFrom: { secretKeyRef: { name: 'db-v1', key: 'uri' } },
        value: 'SECRET_CANARY',
      },
      {
        name: 'PASSWORD',
        valueFrom: {
          secretKeyRef: { name: 'db-v1', key: 'uri', optional: true },
        },
      },
      {
        name: 'PASSWORD',
        valueFrom: { configMapKeyRef: { name: 'database', key: 'uri' } },
      },
    ]) {
      const doc = document();
      doc.spec.values.target.workloads.web.env = [invalid];
      assert.throws(
        () => validate(doc),
        (error) =>
          error instanceof DeploymentError &&
          error.code === 'ENVIRONMENT_REFERENCE' &&
          !error.message.includes('SECRET_CANARY'),
      );
    }
    const envFrom = document();
    envFrom.spec.values.target.workloads.web.envFrom = [
      { secretRef: { name: 'database' } },
    ];
    assert.throws(
      () => validate(envFrom),
      (error) => error.code === 'ENVIRONMENT_REFERENCE',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
function failedMigrationFixture(mutate = () => {}) {
  return liveFixture('migrate', (context) => {
    const { all, doc } = context;
    doc.status.conditions = [
      {
        type: 'Ready',
        status: 'False',
        observedGeneration: 1,
        reason: 'UpgradeFailed',
        message: 'Job failed: BackoffLimitExceeded',
      },
    ];
    const labels = all[0].metadata.labels;
    all.push({
      kind: 'Job',
      metadata: {
        name: 'example-migration-release-1-1',
        uid: 'failed-job-uid',
        labels,
      },
      spec: {
        backoffLimit: 0,
        template: { spec: { automountServiceAccountToken: false, restartPolicy: 'Never', containers: [{ image }] } },
      },
      status: {
        failed: 1,
        conditions: [
          { type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' },
        ],
      },
    });
    all.push({
      kind: 'Pod',
      metadata: {
        name: 'example-migration-release-1-1-pod',
        uid: 'failed-pod-uid',
        labels,
        ownerReferences: [{ uid: 'failed-job-uid' }],
      },
      spec: { automountServiceAccountToken: false, restartPolicy: 'Never', containers: [{ image }] },
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            imageID: image,
            state: {
              terminated: { exitCode: 1, finishedAt: '2026-10-24T12:00:00Z' },
            },
          },
        ],
      },
    });
    mutate(context);
  });
}
test('correlated terminal failed migration permits only explicit recovery to stopped', async () => {
  const { adapter, doc } = failedMigrationFixture();
  await assert.rejects(adapter.observe(doc, 'abc'), /acknowledged/);
  const proof = await adapter.observe(doc, 'abc', {
    allowFailedMigration: true,
  });
  assert.equal(proof.failedMigration.jobUid, 'failed-job-uid');
  assert.equal(
    proof.failedMigration.targetIdentity,
    hash(doc.spec.values.target),
  );
  assert.throws(() => transition(doc, proof), /cannot activate/);
  const stopped = transition(doc, proof, true);
  assert.equal(stopped.spec.values.release.phase, 'stopped');
  assert.equal(stopped.spec.values.release.attempt, 1);
  assert.deepEqual(stopped.spec.values.current, doc.spec.values.current);
  assert.equal(
    JSON.parse(
      stopped.metadata.annotations['smrt.happyvertical.com/failed-migration'],
    ).jobUid,
    'failed-job-uid',
  );
  assert.throws(
    () => transition(stopped, evidence(stopped)),
    /explicit reviewed repair/,
  );
});
test('failed migration recovery rejects unrelated controller errors, stale revisions and live writer Pods', async () => {
  for (const mutate of [
    ({ doc }) => {
      doc.status.conditions[0].message = 'deployments is forbidden';
    },
    ({ doc }) => {
      doc.status.conditions[0].message =
        'admission webhook denied unrelated resource';
    },
    ({ doc }) => {
      doc.status.observedGeneration = 0;
    },
    ({ source }) => {
      source.status.artifact.revision = 'main@sha1:stale';
    },
    ({ all }) => {
      all.find((o) => o.kind === 'Pod').status.phase = 'Running';
    },
    ({ all }) => {
      all.find((o) => o.kind === 'Pod').metadata.deletionTimestamp = 'now';
    },
    ({ all }) => {
      all.find((o) => o.kind === 'Job').status.active = 1;
    },
    ({ all }) => {
      all.find((o) => o.kind === 'Job').status.conditions = [];
    },
    ({ all }) => {
      all.find((o) => o.kind === 'Pod').status.containerStatuses[0].imageID =
        `sha256:${'b'.repeat(64)}`;
    },
  ]) {
    const { adapter, doc } = failedMigrationFixture(mutate);
    await assert.rejects(
      adapter.observe(doc, 'abc', { allowFailedMigration: true }),
    );
  }
});
test('repair publishes reviewed corrected target and new attempt without changing runtime or bindings', async () => {
  const live = failedMigrationFixture();
  const failure = await live.adapter.observe(live.doc, 'abc', {
    allowFailedMigration: true,
  });
  const stopped = transition(live.doc, failure, true);
  const corrected = structuredClone(runtime);
  corrected.migration.command = ['node', 'corrected-migration.mjs'];
  const next = repairRelease(stopped, corrected, evidence(stopped));
  assert.equal(next.spec.values.release.phase, 'stopped');
  assert.equal(next.spec.values.release.attempt, 2);
  assert.equal(
    next.spec.values.release.sequence,
    stopped.spec.values.release.sequence + 1,
  );
  for (const key of ['current', 'app', 'bindings', 'ingress'])
    assert.deepEqual(next.spec.values[key], stopped.spec.values[key]);
  const receipt = {
    recovery: {
      predecessor: JSON.parse(
        next.metadata.annotations['smrt.happyvertical.com/repair-predecessor'],
      ),
      targetIdentity: hash(corrected),
      ledgerState: 'reconciled',
      ledgerEvidenceIdentity: 'f'.repeat(64),
    },
  };
  validateRepairEvidence(next, receipt);
  for (const mutation of [
    { ledgerState: 'needs-repair' },
    { ledgerState: 'running' },
    { targetIdentity: 'wrong' },
    { ledgerEvidenceIdentity: '' },
    { predecessor: {} },
  ])
    assert.throws(
      () =>
        validateRepairEvidence(next, {
          recovery: { ...receipt.recovery, ...mutation },
        }),
      /durable ledger/,
    );
  let published;
  const adapter = {
    read: async () => ({ document: stopped, revision: 'unit-stopped' }),
    observe: async () => evidence(stopped),
    preflight: async (candidate) => {
      validateRepairEvidence(candidate, receipt);
      return { bindings: 'new-pins' };
    },
    cas: async (_, candidate) => {
      published = candidate;
      return { phase: candidate.spec.values.release.phase };
    },
  };
  await repair({}, adapter, corrected);
  assert.equal(published.spec.values.release.attempt, 2);
  assert.equal(
    transition(published, evidence(published)).spec.values.release.phase,
    'migrate',
  );
  const denied = {
    ...adapter,
    preflight: async (candidate) =>
      validateRepairEvidence(candidate, {
        recovery: { ...receipt.recovery, ledgerState: 'needs-repair' },
      }),
    cas: async () => assert.fail('invalid ledger must not publish'),
  };
  await assert.rejects(repair({}, denied, corrected), /durable ledger/);
});
test('accepted active public failure automatically publishes maintenance while stale acknowledgement never writes', async () => {
  const live = liveFixture('active', () => {}, 500);
  let published;
  const adapter = {
    ...live.adapter,
    read: async () => ({ document: live.doc, revision: 'abc' }),
    preflight: async () => ({}),
    cas: async (_, candidate) => {
      published = candidate;
      return { phase: candidate.spec.values.release.phase };
    },
  };
  assert.equal((await applyOrResume({}, adapter)).phase, 'maintenance');
  assert.deepEqual(published.spec.values.current, live.doc.spec.values.target);
  assert.deepEqual(published.spec.values.target, live.doc.spec.values.target);
  const stale = liveFixture('active', ({ source }) => {
    source.status.artifact.revision = 'main@sha1:stale';
  });
  await assert.rejects(
    applyOrResume(
      {},
      {
        ...stale.adapter,
        read: async () => ({ document: stale.doc, revision: 'abc' }),
        cas: async () => assert.fail('stale acknowledgement cannot mutate Git'),
      },
    ),
    /exact Git revision/,
  );
});
test('successful migration then verify HTTP failure requires reviewed target repair and a fresh migration attempt', () => {
  const migrated = document('migrate');
  migrated.spec.values.release.attempt = 2;
  migrated.metadata.annotations = {
    'smrt.happyvertical.com/failed-migration': JSON.stringify({
      name: 'example-migration-release-1-1',
      jobUid: 'retained-job-1',
      attempt: 1,
      releaseId: 'release-1',
      targetIdentity: hash(runtime),
      jobSpecIdentity: 'retained-spec',
    }),
  };
  const verified = transition(migrated, evidence(migrated));
  const stopped = transition(
    verified,
    { ...evidence(verified), proven: false, failureCode: 'HTTP_STATUS' },
    true,
  );
  const marker = JSON.parse(
    stopped.metadata.annotations['smrt.happyvertical.com/runtime-recovery'],
  );
  assert.equal(marker.phase, 'verify');
  assert.equal(marker.attempt, 2);
  assert.equal(marker.revision, 'abc');
  assert.equal(marker.targetIdentity, hash(verified.spec.values.target));
  assert.throws(
    () => transition(stopped, evidence(stopped)),
    /explicit reviewed repair/,
  );
  const corrected = structuredClone(runtime);
  corrected.workloads.web.image = `registry/app@sha256:${'b'.repeat(64)}`;
  const repaired = repairRelease(stopped, corrected, evidence(stopped));
  assert.equal(repaired.spec.values.release.phase, 'stopped');
  assert.equal(repaired.spec.values.release.attempt, 3);
  assert.deepEqual(repaired.spec.values.current, stopped.spec.values.current);
  assert.equal(
    repaired.metadata.annotations['smrt.happyvertical.com/failed-migration'],
    stopped.metadata.annotations['smrt.happyvertical.com/failed-migration'],
  );
  const predecessor = JSON.parse(
    repaired.metadata.annotations['smrt.happyvertical.com/repair-predecessor'],
  );
  assert.deepEqual(predecessor.runtimeRecovery, marker);
  assert.equal(Object.hasOwn(predecessor, 'failedJobUid'), false);
  const receipt = {
    recovery: {
      predecessor,
      targetIdentity: hash(corrected),
      ledgerState: 'reconciled',
      ledgerEvidenceIdentity: 'a'.repeat(64),
    },
  };
  validateRepairEvidence(repaired, receipt);
  assert.throws(
    () =>
      validateRepairEvidence(repaired, {
        recovery: { ...receipt.recovery, ledgerState: 'needs-repair' },
      }),
    /durable ledger/,
  );
  const migration3 = transition(repaired, evidence(repaired));
  assert.equal(migration3.spec.values.release.phase, 'migrate');
  assert.equal(migration3.spec.values.release.attempt, 3);
  const verify3 = transition(migration3, evidence(migration3));
  assert.equal(verify3.spec.values.release.phase, 'verify');
  assert.deepEqual(verify3.spec.values.target, corrected);
  assert.equal(
    verify3.metadata.annotations['smrt.happyvertical.com/failed-migration'],
    stopped.metadata.annotations['smrt.happyvertical.com/failed-migration'],
  );
  for (const mutation of [
    { attempt: 1 },
    { releaseId: 'another-release' },
    { targetIdentity: 'other-target' },
    { revision: '' },
    { phase: 'stopped' },
  ]) {
    const invalid = structuredClone(stopped);
    invalid.metadata.annotations['smrt.happyvertical.com/runtime-recovery'] =
      JSON.stringify({ ...marker, ...mutation });
    assert.throws(
      () => repairRelease(invalid, corrected, evidence(invalid)),
      /does not match/,
    );
  }
});
test('active recovery preserves target, then stopped requires repair before any new migration', () => {
  const active = document();
  const maintenance = transition(
    active,
    { ...evidence(active), proven: false, failureCode: 'HTTP_STATUS' },
    true,
  );
  assert.equal(maintenance.spec.values.release.phase, 'maintenance');
  assert.deepEqual(maintenance.spec.values.current, active.spec.values.target);
  const stopped = transition(maintenance, evidence(maintenance));
  assert.throws(
    () => transition(stopped, evidence(stopped)),
    /explicit reviewed repair/,
  );
  const marker = JSON.parse(
    stopped.metadata.annotations['smrt.happyvertical.com/runtime-recovery'],
  );
  assert.equal(marker.phase, 'active');
  assert.equal(marker.identity, identity(active));
  const repaired = repairRelease(stopped, runtime, evidence(stopped));
  assert.equal(
    transition(repaired, evidence(repaired)).spec.values.release.phase,
    'migrate',
  );
  const newRelease = planRelease(active, runtime, 'release-2');
  assert.equal(
    newRelease.metadata.annotations?.[
      'smrt.happyvertical.com/runtime-recovery'
    ],
    undefined,
  );
});

test('new release publication requires the exact accepted healthy predecessor', async (t) => {
  const current = document('active');
  const planned = planRelease(current, runtime, 'release-2');
  for (const change of [
    { accepted: false },
    { proven: false },
    { identity: 'other-runtime' },
    { revision: 'other-revision' },
  ]) {
    await t.test(JSON.stringify(change), async () => {
      await assert.rejects(
        applyOrResume({}, {
          read: async () => ({ document: current, revision: 'abc' }),
          observe: async (doc, revision) => {
            assert.equal(doc, current);
            assert.equal(revision, 'abc');
            return { ...evidence(doc), ...change };
          },
          preflight: async () => assert.fail('invalid predecessor must not preflight'),
          cas: async () => assert.fail('invalid predecessor must not publish'),
        }, { planned }),
        /accepted healthy predecessor/,
      );
    });
  }
  let publications = 0;
  await applyOrResume({}, {
    read: async () => ({ document: current, revision: 'abc' }),
    observe: async () => evidence(current),
    preflight: async () => ({}),
    cas: async (_, candidate) => {
      publications++;
      assert.equal(candidate.spec.values.release.phase, 'maintenance');
      assert.deepEqual(candidate.spec.values.current, current.spec.values.target);
    },
  }, { planned });
  assert.equal(publications, 1);
});

test('acknowledgement lost during phase proof cannot authorize recovery publication', async (t) => {
  for (const phase of ['active', 'verify']) {
    for (const boundary of ['after-initial-ack', 'healthy-http', 'failed-http']) {
      await t.test(`${phase}: ${boundary}`, async () => {
        const live = liveFixture(phase, ({ config, source }) => {
          const moveSource = () => {
            source.status.artifact.revision = 'main@sha1:moved';
          };
          if (boundary === 'after-initial-ack')
            config.fixtureAfterHelmValues = moveSource;
          else config.fixtureDuringRequest = moveSource;
        }, boundary === 'failed-http' ? 500 : undefined);
        await assert.rejects(
          applyOrResume({}, {
            ...live.adapter,
            read: async () => ({ document: live.doc, revision: 'abc' }),
            preflight: async () => assert.fail('lost acknowledgement must not preflight'),
            cas: async () => assert.fail('lost acknowledgement must not publish'),
          }, { recovery: phase === 'verify' }),
          /exact Git revision/,
          `${phase}: ${boundary}`,
        );
      });
    }
  }
});

test('live predecessor health gates new plans while existing recovery remains available', async (t) => {
  for (const scenario of ['healthy', 'unhealthy', 'unaccepted']) {
    await t.test(scenario, async () => {
      const live = liveFixture('active', ({ source }) => {
        if (scenario === 'unaccepted')
          source.status.artifact.revision = 'main@sha1:stale';
      }, scenario === 'unhealthy' ? 500 : 200);
      const planned = planRelease(live.doc, runtime, 'release-2');
      const publications = [];
      const adapter = {
        ...live.adapter,
        read: async () => ({ document: live.doc, revision: 'abc' }),
        preflight: async () => ({}),
        cas: async (_, candidate) => publications.push(candidate),
      };
      if (scenario === 'healthy') {
        await applyOrResume({}, adapter, { planned });
        assert.equal(publications.length, 1);
        assert.equal(publications[0].spec.values.release.id, 'release-2');
      } else {
        await assert.rejects(
          applyOrResume({}, adapter, { planned }),
          scenario === 'unhealthy' ? /accepted healthy predecessor/ : /exact Git revision/,
        );
        assert.equal(publications.length, 0);
        if (scenario === 'unhealthy') {
          await applyOrResume({}, adapter);
          assert.equal(publications.length, 1);
          assert.equal(publications[0].spec.values.release.id, 'release-1');
          assert.equal(publications[0].spec.values.release.phase, 'maintenance');
        }
      }
    });
  }
});

test('runtime capability validation rejects security and observer escapes', () => {
  const doc = document();
  const migration = doc.spec.values.target.migration;
  migration.serviceAccountName = 'migration-observer';
  migration.observerAccess = true;
  migration.podSecurityContext = { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } };
  migration.securityContext = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
  migration.scratch = [{ name: 'tmp', mountPath: '/tmp' }];
  assert.ok(validate(doc));
  for (const change of [
    (v) => { delete v.target.migration.serviceAccountName; },
    (v) => { v.target.workloads.web.observerAccess = true; },
    (v) => { v.target.migration.podSecurityContext.runAsUser = 0; },
    (v) => { v.target.migration.securityContext.privileged = true; },
    (v) => { v.target.migration.securityContext.capabilities.add = ['SYS_ADMIN']; },
    (v) => { v.target.migration.scratch[0].mountPath = '/var/run'; },
  ]) {
    const invalid = structuredClone(doc);
    change(invalid.spec.values);
    assert.throws(() => validate(invalid), DeploymentError);
  }
});

test('actual Pod observation rejects added privilege, credentials and identity changes', async () => {
  const { verifyPodEnvelope } = await import('./deployment/live.mjs');
  const desired = { automountServiceAccountToken: false, serviceAccountName: 'runtime', securityContext: { runAsNonRoot: true, runAsUser: 10001 }, containers: [{ name: 'app', image }] };
  assert.doesNotThrow(() => verifyPodEnvelope(structuredClone(desired), desired));
  for (const change of [
    (p) => { p.serviceAccountName = 'other'; },
    (p) => { p.securityContext.runAsUser = 10002; },
    (p) => { p.containers[0].securityContext = { runAsUser: 0 }; },
    (p) => { p.containers[0].securityContext = { privileged: true }; },
    (p) => { p.volumes = [{ name: 'token', secret: { secretName: 'long-lived' } }]; },
    (p) => { p.hostPID = true; },
    (p) => { p.automountServiceAccountToken = true; },
  ]) {
    const actual = structuredClone(desired);
    change(actual);
    assert.throws(() => verifyPodEnvelope(actual, desired), DeploymentError);
  }
});

test('active scheduled Pods retain the rendered service-account and security envelope', async () => {
  const doc = document('active');
  const workload = { ...runtime.workloads.web, schedule: '* * * * *', service: undefined, serviceAccountName: 'schedule-runtime' };
  doc.spec.values.target.workloads = { monitor: workload };
  const podSpec = { automountServiceAccountToken: false, serviceAccountName: 'schedule-runtime', containers: [{ image, command: workload.command }] };
  const all = [
    { kind: 'CronJob', metadata: { name: 'example-monitor', uid: 'cron' }, spec: { schedule: workload.schedule, suspend: false, concurrencyPolicy: 'Forbid', jobTemplate: { spec: { template: { spec: podSpec } } } } },
    { kind: 'Job', metadata: { uid: 'job', ownerReferences: [{ uid: 'cron' }] }, spec: { template: { spec: structuredClone(podSpec) } }, status: { active: 1 } },
    { kind: 'Pod', metadata: { ownerReferences: [{ uid: 'job' }] }, spec: structuredClone(podSpec) },
  ];
  await assert.doesNotReject(() => verifyRuntime(doc, all));
  all[2].spec.serviceAccountName = 'privileged-other';
  await assert.rejects(() => verifyRuntime(doc, all), /Pod security or credential envelope/);
  all[2].spec.serviceAccountName = 'schedule-runtime';
  for (const spec of [all[0].spec.jobTemplate.spec.template.spec, all[1].spec.template.spec, all[2].spec])
    spec.volumes = [{ name: 'token', projected: { sources: [{ serviceAccountToken: { path: 'token' } }] } }];
  await assert.rejects(() => verifyRuntime(doc, all), /Pod security or credential envelope/);
});

test('implicit default service account, API defaults and unsupported host/confinement changes fail closed', async () => {
  const { verifyPodEnvelope } = await import('./deployment/live.mjs');
  const desired = { automountServiceAccountToken: false, containers: [{ image }] };
  assert.doesNotThrow(() => verifyPodEnvelope({ ...structuredClone(desired), serviceAccountName: 'default', hostUsers: true }, desired));
  assert.doesNotThrow(() => verifyPodEnvelope(structuredClone(desired), { ...desired, serviceAccountName: 'default', hostUsers: true }));
  assert.doesNotThrow(() => verifyPodEnvelope({ ...structuredClone(desired), hostUsers: false }, { ...desired, hostUsers: false }));
  for (const change of [
    (p) => { p.serviceAccountName = 'alternate'; },
    (p) => { p.hostUsers = false; },
    (p) => { p.shareProcessNamespace = true; },
    (p) => { p.securityContext = { seccompProfile: { type: 'Unconfined' } }; },
    (p) => { p.securityContext = { appArmorProfile: { type: 'Unconfined' } }; },
    (p) => { p.securityContext = { seLinuxOptions: { type: 'spc_t' } }; },
    (p) => { p.containers[0].ports = [{ containerPort: 8080, hostPort: 8080 }]; },
    (p) => { p.containers[0].securityContext = { seccompProfile: { type: 'Unconfined' } }; },
    (p) => { p.containers[0].securityContext = { appArmorProfile: { type: 'Unconfined' } }; },
    (p) => { p.containers[0].securityContext = { seLinuxOptions: { type: 'spc_t' } }; },
  ]) {
    const actual = structuredClone(desired);
    change(actual);
    assert.throws(() => verifyPodEnvelope(actual, desired), DeploymentError);
  }
  assert.throws(() => verifyPodEnvelope({ ...structuredClone(desired), hostUsers: true }, { ...desired, hostUsers: false }), DeploymentError);
});

test('live runtime controller and matching Pods cannot jointly inject account or projected credentials', async () => {
  for (const change of [
    (spec) => { spec.serviceAccountName = 'alternate'; },
    (spec) => { spec.volumes = [{ name: 'token', projected: { sources: [{ serviceAccountToken: { path: 'token' } }] } }]; },
  ]) {
    const all = objects();
    change(all[0].spec.template.spec);
    change(all[2].spec);
    await assert.rejects(() => verifyRuntime(document('verify'), all), /Pod security or credential envelope/);
    const live = liveFixture('verify', ({ all }) => {
      change(all[0].spec.template.spec);
      change(all[2].spec);
    });
    assert.equal((await live.adapter.observe(live.doc, 'abc')).proven, false);
  }
});

test('live inventory binds maintenance controller envelope to the original rendered template', async () => {
  for (const inject of [false, true]) {
    const live = liveFixture('stopped', ({ all, config }) => {
      const desired = {
        kind: 'Deployment', metadata: { name: 'example-maintenance', labels: { ...all[0].metadata.labels } },
        spec: { replicas: 1, template: { spec: { automountServiceAccountToken: false, containers: [{ image }] } } },
      };
      config.fixtureRenderedResources = [structuredClone(desired), structuredClone(all[0])];
      all.push(desired);
      if (inject) desired.spec.template.spec.volumes = [{ name: 'token', projected: { sources: [{ serviceAccountToken: { path: 'token' } }] } }];
    });
    assert.equal((await live.adapter.observe(live.doc, 'abc')).proven, !inject);
  }
});
