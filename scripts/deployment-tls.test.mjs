import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:tls';
import { test } from 'node:test';
import {
  planTlsRotation,
  validateTlsPlan,
  tlsDocument,
  validateTlsCurrent,
  applyTlsRotation,
  rollbackTlsRotation,
  tlsAnnotation,
} from './deployment/tls.mjs';
import {
  inspectTlsSecret,
  servedTlsIdentity,
} from './deployment/tls-native.mjs';
import { hash } from './deployment/release.mjs';
const sha = 'a'.repeat(64),
  revision = 'b'.repeat(40);
function predecessor() {
  const values = JSON.parse(
    readFileSync(
      new URL('../charts/smrt-app/fixtures/iolaus.json', import.meta.url),
      'utf8',
    ),
  );
  values.release.phase = 'active';
  values.release.sequence = 1;
  values.ingress.tlsSecretName = 'tls-v1';
  return {
    kind: 'HelmRelease',
    metadata: {
      name: 'example',
      namespace: 'test',
      annotations: { 'smrt.happyvertical.com/binding-versions': sha },
    },
    spec: { releaseName: 'example', values },
  };
}
function plan() {
  return planTlsRotation(
    { document: predecessor(), revision },
    [{ name: 'example', tlsSecretName: 'tls-v2' }],
    'rotate-1',
  );
}
const templates = [
  {
    kind: 'Deployment',
    name: 'example-web',
    uid: 'deployment',
    templateSha256: sha,
  },
];
const retained = [
  { name: 'tls-v1', uid: 'old', resourceVersion: '1', leafSha256: sha },
  {
    name: 'tls-v2',
    uid: 'new',
    resourceVersion: '2',
    leafSha256: 'c'.repeat(64),
  },
];
test('TLS plan is exact active-only reference editing, preserving all runtime and control fields', () => {
  const p = plan();
  validateTlsPlan(p);
  const next = tlsDocument(p, retained, 'pending', null, templates);
  validateTlsCurrent(p, next);
  assert.deepEqual(
    next.spec.values.target,
    p.predecessor.document.spec.values.target,
  );
  assert.deepEqual(
    next.spec.values.current,
    p.predecessor.document.spec.values.current,
  );
  assert.deepEqual(
    next.spec.values.release,
    p.predecessor.document.spec.values.release,
  );
  assert.deepEqual(
    next.spec.values.bindings,
    p.predecessor.document.spec.values.bindings,
  );
  const expected = structuredClone(p.predecessor.document.spec);
  expected.values.ingress.tlsSecretName = 'tls-v2';
  assert.deepEqual(next.spec, expected);
  for (const change of [
    (d) => (d.spec.values.release.phase = 'verify'),
    (d) => {
      d.spec.values.current = false;
      d.spec.values.release.phase = 'maintenance';
      d.spec.values.release.sequence = 0;
    },
  ]) {
    const d = predecessor();
    change(d);
    assert.throws(() =>
      planTlsRotation(
        { document: d, revision },
        [{ name: 'example', tlsSecretName: 'tls-v2' }],
        'rotate-1',
      ),
    );
  }
  for (const refs of [
    [{ name: 'unknown', tlsSecretName: 'v2' }],
    [{ name: 'example', tlsSecretName: 'v2', host: 'other' }],
    [{ name: 'example', tlsSecretName: 'tls-v1' }],
    [],
    [{ name: 'example', tlsSecretName: '../escape' }],
  ])
    assert.throws(() =>
      planTlsRotation({ document: predecessor(), revision }, refs, 'rotate-1'),
    );
  const bad = structuredClone(p);
  bad.predecessor.document.spec.values.target.workloads.web.image = `registry/other@sha256:${sha}`;
  assert.throws(() => validateTlsPlan(bad));
  const drift = structuredClone(next);
  drift.spec.values.ingress.host = 'other.test';
  assert.throws(() => validateTlsCurrent(p, drift), /unrelated/);
});
function adapterFixture() {
  const p = plan();
  let snapshot = { revision, document: predecessor() };
  let healthy = true,
    unrelated = false,
    publications = 0;
  return {
    p,
    get snapshot() {
      return snapshot;
    },
    set healthy(v) {
      healthy = v;
    },
    set unrelated(v) {
      unrelated = v;
    },
    get publications() {
      return publications;
    },
    read: async () => structuredClone(snapshot),
    prepareTls: async (plan, status, rollback, bindings = retained) => {
      const d = tlsDocument(plan, bindings, status, rollback, templates);
      d.metadata.annotations['smrt.happyvertical.com/binding-versions'] =
        'd'.repeat(64);
      return d;
    },
    observeTls: async (document, rev) => {
      if (unrelated) throw new Error('unrelated runtime failure');
      if (healthy)
        return {
          accepted: true,
          proven: true,
          revision: rev,
          documentSha256: hash(document),
          observedAt: Date.now(),
          runtimeTemplates: templates,
        };
      const marker = JSON.parse(document.metadata.annotations[tlsAnnotation]);
      return {
        accepted: true,
        proven: false,
        failureCode: 'TLS_CORRELATED_FAILURE',
        tlsFailure: {
          transitionIdentity: marker.identity,
          documentSha256: hash(document),
          revision: rev,
          observedAt: Date.now(),
          bindings: sha,
          hosts: [
            {
              host: document.spec.values.ingress.host,
              expectedLeafSha256: 'c'.repeat(64),
              servedLeafSha256: sha,
              code: 'TLS_CERTIFICATE',
              observedAt: Date.now(),
            },
          ],
        },
      };
    },
    casTls: async (old, next) => {
      assert.equal(old.revision, snapshot.revision);
      assert.equal(hash(old.document), hash(snapshot.document));
      publications++;
      snapshot = {
        revision: String(publications).repeat(40),
        document: structuredClone(next),
      };
      return { revision: snapshot.revision };
    },
  };
}
test('TLS rotation resumes through exact native acknowledgement and preserves retained rollback identities', async () => {
  const a = adapterFixture();
  assert.equal((await applyTlsRotation({}, a, a.p)).status, 'pending');
  assert.equal((await applyTlsRotation({}, a, a.p)).status, 'complete');
  assert.equal((await applyTlsRotation({}, a, a.p)).complete, true);
  assert.equal(a.publications, 2);
  a.healthy = false;
  assert.equal((await rollbackTlsRotation({}, a, a.p)).status, 'rolling-back');
  assert.equal(a.snapshot.document.spec.values.ingress.tlsSecretName, 'tls-v1');
  a.healthy = true;
  assert.equal((await rollbackTlsRotation({}, a, a.p)).status, 'rolled-back');
  assert.equal((await rollbackTlsRotation({}, a, a.p)).complete, true);
});
test('TLS preflight consumes only fresh healthy exact predecessor observations before publication', async () => {
  for (const mutate of [
    (p) => (p.accepted = false),
    (p) => (p.observedAt -= 31000),
    (p) => (p.revision = 'e'.repeat(40)),
    (p) => (p.documentSha256 = 'e'.repeat(64)),
  ]) {
    const a = adapterFixture(),
      native = a.observeTls;
    a.observeTls = async (...args) => {
      const p = await native(...args);
      mutate(p);
      return p;
    };
    await assert.rejects(applyTlsRotation({}, a, a.p), /predecessor/);
    assert.equal(a.publications, 0);
  }
  const a = adapterFixture(),
    native = a.observeTls;
  let observations = 0;
  a.observeTls = async (...args) => {
    const p = await native(...args);
    if (++observations === 2) p.observedAt -= 31000;
    return p;
  };
  await assert.rejects(applyTlsRotation({}, a, a.p), /during preflight/);
  assert.equal(observations, 2);
  assert.equal(a.publications, 0);
});
test('rollback refuses healthy endpoints, unrelated failures and stale/cross-transition evidence', async () => {
  const a = adapterFixture();
  await applyTlsRotation({}, a, a.p);
  await assert.rejects(rollbackTlsRotation({}, a, a.p), /correlated/);
  a.unrelated = true;
  await assert.rejects(rollbackTlsRotation({}, a, a.p), /unrelated/);
  assert.equal(a.publications, 1);
  a.unrelated = false;
  a.healthy = false;
  const native = a.observeTls;
  for (const mutate of [
    (p) => (p.tlsFailure.observedAt -= 31000),
    (p) => (p.tlsFailure.revision = 'e'.repeat(40)),
    (p) => (p.tlsFailure.documentSha256 = 'e'.repeat(64)),
    (p) => (p.tlsFailure.transitionIdentity = 'e'.repeat(64)),
    (p) => (p.failureCode = 'HTTP_STATUS'),
    (p) => (p.tlsFailure.hosts[0].observedAt -= 31000),
    (p) => (p.tlsFailure.hosts[0].host = 'unrelated.test'),
    (p) => (p.tlsFailure.hosts[0].code = 'HTTP_STATUS'),
    (p) => (p.tlsFailure.hosts[0].extra = true),
  ]) {
    a.observeTls = async (...args) => {
      const proof = await native(...args);
      mutate(proof);
      return proof;
    };
    await assert.rejects(rollbackTlsRotation({}, a, a.p), /correlated/);
    assert.equal(a.publications, 1);
  }
});
function certificates() {
  const dir = mkdtempSync(join(tmpdir(), 'smrt-tls-test-'));
  const run = (...args) =>
    execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-days',
    '2',
    '-subj',
    '/CN=Test CA',
  );
  run(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-subj',
    '/CN=app.test',
  );
  writeFileSync(
    join(dir, 'ext'),
    'subjectAltName=DNS:app.test\nextendedKeyUsage=serverAuth\n',
  );
  run(
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'server.crt',
    '-days',
    '1',
    '-extfile',
    'ext',
  );
  const cert = readFileSync(join(dir, 'server.crt'), 'utf8'),
    key = readFileSync(join(dir, 'server.key'), 'utf8'),
    ca = readFileSync(join(dir, 'ca.crt'), 'utf8');
  return {
    dir,
    cert,
    key,
    ca,
    secret: {
      kind: 'Secret',
      type: 'kubernetes.io/tls',
      immutable: true,
      metadata: { name: 'tls-v1', uid: 'uid', resourceVersion: '1' },
      data: {
        'tls.crt': Buffer.from(cert).toString('base64'),
        'tls.key': Buffer.from(key).toString('base64'),
      },
    },
  };
}
test('native TLS validates immutable key/chain/SAN/time and actual served peer certificate', async () => {
  const c = certificates();
  let server;
  try {
    const binding = await inspectTlsSecret(c.secret, ['app.test'], {
      trustedCa: [c.ca],
      minimumValiditySeconds: 3600,
    });
    assert.match(binding.leafSha256, /^[a-f0-9]{64}$/);
    for (const [secret, hosts, options] of [
      [{ ...c.secret, immutable: false }, ['app.test'], { trustedCa: [c.ca] }],
      [c.secret, ['wrong.test'], { trustedCa: [c.ca] }],
      [
        c.secret,
        ['app.test'],
        { trustedCa: [c.ca], now: Date.now() + 3 * 86400000 },
      ],
      [
        {
          ...c.secret,
          data: {
            ...c.secret.data,
            'tls.key': Buffer.from(
              readFileSync(join(c.dir, 'ca.key')),
            ).toString('base64'),
          },
        },
        ['app.test'],
        { trustedCa: [c.ca] },
      ],
      [c.secret, ['app.test'], { trustedCa: [c.cert] }],
    ])
      await assert.rejects(
        inspectTlsSecret(secret, hosts, options),
        (e) => e.code === 'TLS_BINDING' && !e.message.includes('PRIVATE KEY'),
      );
    server = createServer({ key: c.key, cert: c.cert }, (socket) =>
      socket.end(),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const endpoint = async (host, p) => {
      assert.equal(host, 'app.test');
      assert.equal(p, 443);
      return { host: '127.0.0.1', port };
    };
    assert.equal(
      (
        await servedTlsIdentity('app.test', 443, binding.leafSha256, {
          trustedCa: [c.ca],
          endpoint,
        })
      ).code,
      null,
    );
    assert.equal(
      (
        await servedTlsIdentity('wrong.test', 443, binding.leafSha256, {
          trustedCa: [c.ca],
          endpoint: async () => ({ host: '127.0.0.1', port }),
        })
      ).code,
      'TLS_HOSTNAME',
    );
    assert.equal(
      (
        await servedTlsIdentity('app.test', 443, 'f'.repeat(64), {
          trustedCa: [c.ca],
          endpoint,
        })
      ).code,
      'TLS_CERTIFICATE',
    );
    assert.equal(
      (
        await servedTlsIdentity('app.test', 443, binding.leafSha256, {
          trustedCa: [],
          endpoint,
        })
      ).code,
      'TLS_TRUST',
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(c.dir, { recursive: true, force: true });
  }
});

import { createLiveAdapter } from './deployment/live.mjs';
test('live TLS correlation preserves source/runtime/binding/HTTP gates and never waives unrelated failures', async () => {
  const c = certificates();
  let server;
  try {
    const run = (...args) =>
      execFileSync('openssl', args, { cwd: c.dir, stdio: 'pipe' });
    run(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'new.key',
      '-out',
      'new.csr',
      '-subj',
      '/CN=app.test',
    );
    run(
      'x509',
      '-req',
      '-in',
      'new.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'new.crt',
      '-days',
      '1',
      '-extfile',
      'ext',
    );
    const nextSecret = {
      ...c.secret,
      metadata: { name: 'tls-v2', uid: 'new', resourceVersion: '2' },
      data: {
        'tls.crt': readFileSync(join(c.dir, 'new.crt')).toString('base64'),
        'tls.key': readFileSync(join(c.dir, 'new.key')).toString('base64'),
      },
    };
    const oldSecret = {
      ...c.secret,
      metadata: { name: 'tls-v1', uid: 'old', resourceVersion: '1' },
    };
    const bindings = [
      await inspectTlsSecret(oldSecret, ['app.test'], { trustedCa: [c.ca] }),
      await inspectTlsSecret(nextSecret, ['app.test'], { trustedCa: [c.ca] }),
    ];
    const image = `registry/app@sha256:${sha}`;
    const runtime = {
      workloads: {
        web: {
          role: 'web',
          image,
          command: ['node', 'server'],
          env: [],
          replicas: 1,
          service: { port: 80 },
        },
      },
      migration: { image, command: ['node', 'migration'], env: [] },
    };
    const original = {
      kind: 'HelmRelease',
      metadata: { name: 'example', annotations: {} },
      spec: {
        releaseName: 'example',
        chartRef: { kind: 'OCIRepository', name: 'chart' },
        install: { strategy: { name: 'RetryOnFailure' } },
        upgrade: { strategy: { name: 'RetryOnFailure' } },
        driftDetection: { mode: 'enabled' },
        values: {
          app: { name: 'example', environment: 'test' },
          release: {
            id: 'release-1',
            phase: 'active',
            sequence: 1,
            attempt: 1,
          },
          current: runtime,
          target: structuredClone(runtime),
          bindings: {},
          ingress: { host: 'app.test', tlsSecretName: 'tls-v1' },
        },
      },
    };
    const labels = {
      'app.kubernetes.io/instance': 'example',
      'smrt.happyvertical.com/release': 'release-1',
      'smrt.happyvertical.com/phase': 'active',
      'smrt.happyvertical.com/sequence': '1',
    };
    const deployment = {
      kind: 'Deployment',
      metadata: { name: 'example-web', uid: 'deploy', generation: 1, labels },
      spec: {
        selector: {
          matchLabels: {
            'app.kubernetes.io/instance': 'example',
            'smrt.happyvertical.com/workload': 'web',
          },
        },
        template: {
          spec: {
            automountServiceAccountToken: false,
            containers: [{ image }],
          },
        },
      },
      status: {
        observedGeneration: 1,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
      },
    };
    const templates = [
      {
        kind: 'Deployment',
        name: 'example-web',
        uid: 'deploy',
        templateSha256: hash(deployment.spec.template),
      },
    ];
    const p = planTlsRotation(
      { document: original, revision },
      [{ name: 'example', tlsSecretName: 'tls-v2' }],
      'rotate-1',
    );
    const document = tlsDocument(p, bindings, 'pending', null, templates);
    document.metadata.annotations['smrt.happyvertical.com/binding-versions'] =
      hash(
        [
          ['tls-v2', 'new', '2'],
          ['tls-v1', 'old', '1'],
        ].sort(),
      );
    const all = [
      deployment,
      {
        kind: 'ReplicaSet',
        metadata: {
          name: 'rs',
          uid: 'rs',
          labels,
          ownerReferences: [{ uid: 'deploy' }],
        },
      },
      {
        kind: 'Pod',
        metadata: {
          name: 'pod',
          uid: 'pod',
          labels,
          ownerReferences: [{ uid: 'rs' }],
        },
        spec: structuredClone(deployment.spec.template.spec),
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [{ imageID: image }],
        },
      },
      {
        kind: 'EndpointSlice',
        metadata: {
          name: 'endpoints',
          labels: { 'kubernetes.io/service-name': 'example-web' },
        },
        endpoints: [{ conditions: { ready: true }, targetRef: { uid: 'pod' } }],
      },
      {
        kind: 'Ingress',
        metadata: { name: 'example', labels },
        spec: {
          rules: [
            {
              host: 'app.test',
              http: {
                paths: [{ backend: { service: { name: 'example-web' } } }],
              },
            },
          ],
        },
      },
    ];
    const source = {
      metadata: { generation: 1 },
      status: {
        conditions: [{ type: 'Ready', status: 'True', observedGeneration: 1 }],
        artifact: { revision: `main@sha1:${revision}` },
        lastAppliedRevision: `main@sha1:${revision}`,
      },
    };
    let failure;
    const command = async (name, args) => {
      if (name === 'helm')
        return args.includes('template')
          ? 'rendered'
          : JSON.stringify(document.spec.values);
      if (args.includes('create'))
        return JSON.stringify({
          items: all.filter((o) => o.kind === 'Ingress'),
        });
      if (args.includes('ocirepository'))
        return JSON.stringify({
          ...source,
          spec: { ref: { digest: `sha256:${sha}` } },
        });
      if (args.includes('gitrepository') || args.includes('kustomization'))
        return JSON.stringify(
          failure === 'source'
            ? {
                ...source,
                status: { ...source.status, artifact: { revision: 'wrong' } },
              }
            : source,
        );
      if (args.includes('helmrelease'))
        return JSON.stringify({
          ...document,
          metadata: { ...document.metadata, generation: 1 },
          status: source.status,
        });
      if (args.includes('secret'))
        return JSON.stringify(
          args.includes('tls-v2')
            ? {
                ...nextSecret,
                metadata: {
                  ...nextSecret.metadata,
                  uid: failure === 'binding' ? 'changed' : 'new',
                },
              }
            : oldSecret,
        );
      return JSON.stringify({ items: all });
    };
    server = createServer({ key: c.key, cert: c.cert }, (s) => s.end());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const config = {
      repository: '.',
      branch: 'main',
      file: 'apps/release.json',
      namespace: 'test',
      source: { name: 'source' },
      kustomization: { name: 'app' },
      chart: 'chart',
      chartSource: { name: 'chart', digest: `sha256:${sha}` },
      publicAssertions: [{ url: 'https://app.test/', status: 200 }],
      privateAssertions: [
        { url: 'http://example-web.test.svc.cluster.local/', status: 200 },
      ],
    };
    const adapter = createLiveAdapter(
      config,
      command,
      async () =>
        new Response('healthy', { status: failure === 'http' ? 500 : 200 }),
      {
        tls: {
          trustedCa: [c.ca],
          endpoint: async () => ({
            host: '127.0.0.1',
            port: server.address().port,
          }),
        },
      },
    );
    const proof = await adapter.observeTls(document, revision);
    assert.equal(proof.failureCode, 'TLS_CORRELATED_FAILURE');
    assert.equal(proof.tlsFailure.documentSha256, hash(document));
    for (failure of ['source', 'binding', 'http', 'runtime']) {
      if (failure === 'runtime') deployment.status.readyReplicas = 0;
      await assert.rejects(adapter.observeTls(document, revision));
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(c.dir, { recursive: true, force: true });
  }
});

import { main as tlsCli } from './deployment/cli.mjs';
import { planRelease } from './deployment/release.mjs';
test('public CLI dispatches bounded TLS workflow and interlocks ordinary runtime operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'smrt-tls-cli-'));
  try {
    const config = join(dir, 'config.json'),
      refs = join(dir, 'refs.json'),
      reviewed = join(dir, 'plan.json');
    writeFileSync(config, '{}');
    writeFileSync(
      refs,
      JSON.stringify([{ name: 'example', tlsSecretName: 'tls-v2' }]),
    );
    const a = adapterFixture();
    const p = await tlsCli(['tls-plan', config, refs, 'rotate-1'], () => a);
    writeFileSync(reviewed, JSON.stringify(p));
    assert.equal(
      (await tlsCli(['tls-apply-or-resume', config, reviewed], () => a)).status,
      'pending',
    );
    await assert.rejects(
      tlsCli(['apply-or-resume', config], () => a),
      /Pending TLS/,
    );
    assert.throws(
      () =>
        planRelease(
          a.snapshot.document,
          a.snapshot.document.spec.values.target,
          'runtime-2',
        ),
      /Pending TLS/,
    );
    assert.equal(
      (await tlsCli(['tls-apply-or-resume', config, reviewed], () => a)).status,
      'complete',
    );
    const next = planRelease(
      a.snapshot.document,
      a.snapshot.document.spec.values.target,
      'runtime-2',
    );
    assert.equal(
      next.metadata.annotations[tlsAnnotation],
      undefined,
      'a new ordinary runtime release closes the bounded TLS rollback window',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { run as nativeRun } from './deployment/live.mjs';
test('TLS publication uses actual private-index Git CAS and rejects even unrelated predecessor revision drift', async () => {
  const execute = promisify(execFile),
    scratch = await mkdtemp(join(tmpdir(), 'smrt-tls-cas-'));
  try {
    const remote = join(scratch, 'remote.git'),
      repository = join(scratch, 'publisher');
    await execute('git', ['init', '--bare', '--initial-branch=main', remote]);
    await execute('git', ['clone', remote, repository]);
    const git = async (...args) =>
      (await execute('git', ['-C', repository, ...args])).stdout.trim();
    await git('config', 'user.name', 'SMRT fixture');
    await git('config', 'user.email', 'fixture@example.invalid');
    await mkdir(join(repository, 'apps'));
    await writeFile(
      join(repository, 'apps/release.json'),
      JSON.stringify(predecessor()),
    );
    await git('add', '.');
    await git('commit', '-m', 'predecessor');
    await git('push', 'origin', 'main');
    const live = createLiveAdapter(
      {
        repository,
        branch: 'main',
        file: 'apps/release.json',
        namespace: 'test',
        source: { name: 'source' },
        kustomization: { name: 'app' },
        chart: 'unused',
      },
      nativeRun,
    );
    const snapshot = await live.read();
    const p = planTlsRotation(
      snapshot,
      [{ name: 'example', tlsSecretName: 'tls-v2' }],
      'tls-cas',
    );
    const next = tlsDocument(p, retained, 'pending', null, templates);
    const published = await live.casTls(snapshot, next);
    assert.equal(
      JSON.parse(await git('show', `${published.revision}:apps/release.json`))
        .spec.values.ingress.tlsSecretName,
      'tls-v2',
    );
    await git('pull', '--ff-only', 'origin', 'main');
    const stale = await live.read();
    await writeFile(join(repository, 'unrelated.txt'), 'source drift');
    await git('add', '.');
    await git('commit', '-m', 'unrelated');
    await git('push', 'origin', 'main');
    const settled = structuredClone(stale.document);
    const marker = JSON.parse(settled.metadata.annotations[tlsAnnotation]);
    marker.status = 'complete';
    settled.metadata.annotations[tlsAnnotation] = JSON.stringify(marker);
    await assert.rejects(
      live.casTls(stale, settled),
      /predecessor CAS changed/,
    );
    assert.equal(
      JSON.parse(
        JSON.parse(await git('show', 'origin/main:apps/release.json')).metadata
          .annotations[tlsAnnotation],
      ).status,
      'pending',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
