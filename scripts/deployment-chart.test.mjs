import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chartArtifact } from './deployment-chart-artifact.mjs';

// The framework's existing YAML dependency parses actual Helm output; do not
// substitute a regex parser for Kubernetes manifests.
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parseAllDocuments } = require('yaml');
const root = fileURLToPath(new URL('../', import.meta.url));
const chart = join(root, 'charts/smrt-app');
const scratch = mkdtempSync(join(tmpdir(), 'smrt-chart-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let helm = 'helm';
if (spawnSync(helm, ['version', '--short']).status !== 0) {
  const { installDeploymentTool } = await import('./deployment-toolchain.mjs');
  helm = await installDeploymentTool('helm', scratch);
}
let counter = 0;
const fixture = (app = 'iolaus') => JSON.parse(readFileSync(join(chart, 'fixtures', `${app}.json`), 'utf8'));
function render(values) {
  const path = join(scratch, `values-${counter++}.json`);
  writeFileSync(path, JSON.stringify(values));
  return execFileSync(helm, ['template', 'fixture', chart, '-f', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function documents(values) {
  return parseAllDocuments(render(values)).map((document) => {
    assert.deepEqual(document.errors, []);
    return document.toJSON();
  }).filter(Boolean);
}
function resource(docs, kind, name) {
  const result = docs.find((doc) => doc.kind === kind && doc.metadata.name === name);
  assert.ok(result, `${kind}/${name} exists`);
  return result;
}
const phaseValues = (base, phase) => ({ ...structuredClone(base), release: { ...base.release, phase } });

test('legacy adoption capabilities ship as a new immutable feature-minor chart artifact', () => {
  const metadata = parseAllDocuments(readFileSync(join(chart, 'Chart.yaml'), 'utf8'))[0].toJSON();
  assert.equal(metadata.version, '0.3.0');
  assert.equal(metadata.appVersion, '1');
});

test('representative fixtures lint strictly and chart packages independently', () => {
  for (const app of ['iolaus', 'work']) {
    execFileSync(helm, ['lint', '--strict', chart, '-f', join(chart, 'fixtures', `${app}.json`)]);
  }
  execFileSync(helm, ['package', chart, '--destination', scratch]);
  const version = parseAllDocuments(readFileSync(join(chart, 'Chart.yaml'), 'utf8'))[0].toJSON().version;
  assert.ok(readFileSync(join(scratch, `smrt-app-${version}.tgz`)).length > 0);
});

test('current entire pod spec survives maintenance and target starts only after migration', () => {
  const base = fixture();
  base.target.workloads.web.image = `ghcr.io/example/new@sha256:${'c'.repeat(64)}`;
  base.target.workloads.web.command = ['node', 'new-build'];
  base.target.workloads.web.env[0].valueFrom.secretKeyRef.name = 'new-runtime-v2';
  for (const phase of ['maintenance', 'stopped', 'migrate', 'verify', 'active']) {
    const docs = documents(phaseValues(base, phase));
    const deployment = resource(docs, 'Deployment', 'fixture-web');
    const selected = ['verify', 'active'].includes(phase) ? base.target.workloads.web : base.current.workloads.web;
    const container = deployment.spec.template.spec.containers[0];
    assert.equal(container.image, selected.image);
    assert.deepEqual(container.command, selected.command);
    assert.deepEqual(container.env, selected.env);
    assert.equal(deployment.spec.replicas, ['stopped', 'migrate'].includes(phase) ? 0 : 2);
    const ingress = resource(docs, 'Ingress', 'fixture');
    assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.name, phase === 'active' ? 'fixture-web' : 'fixture-maintenance');
    const cron = resource(docs, 'CronJob', 'fixture-monitor');
    assert.equal(cron.spec.suspend, phase !== 'active');
    assert.equal(cron.spec.concurrencyPolicy, 'Forbid');
    assert.equal(resource(docs, 'Deployment', 'fixture-maintenance').spec.replicas, 1);
  }
  const old = resource(documents(phaseValues(base, 'maintenance')), 'Deployment', 'fixture-web');
  const stopped = resource(documents(phaseValues(base, 'stopped')), 'Deployment', 'fixture-web');
  assert.deepEqual(old.spec.template, stopped.spec.template, 'phase acknowledgement must not restart current runtime');
});

test('runtime probes, scheduling, scratch and drain settings are preserved', () => {
  const base = fixture();
  const workload = base.current.workloads.task;
  workload.startupProbe = { exec: { command: ['node', 'check.mjs'] }, failureThreshold: 40, timeoutSeconds: 3 };
  workload.scratch = [{ name: 'heartbeat', mountPath: '/tmp/heartbeat', sizeLimit: '16Mi', medium: 'Memory' }];
  workload.nodeSelector = { 'kubernetes.io/arch': 'amd64' };
  workload.tolerations = [{ key: 'dedicated', operator: 'Equal', value: 'worker', effect: 'NoSchedule' }];
  const pod = resource(documents(base), 'Deployment', 'fixture-task').spec.template.spec;
  assert.deepEqual(pod.containers[0].startupProbe, workload.startupProbe);
  assert.deepEqual(pod.nodeSelector, workload.nodeSelector);
  assert.deepEqual(pod.tolerations, workload.tolerations);
  assert.deepEqual(pod.volumes, [{ name: 'heartbeat', emptyDir: { sizeLimit: '16Mi', medium: 'Memory' } }]);
  assert.equal(pod.terminationGracePeriodSeconds, 270);
});

test('bootstrap leaves all runtime absent until verify', () => {
  const base = fixture('work');
  base.current = false;
  for (const phase of ['maintenance', 'stopped', 'migrate']) {
    const docs = documents(phaseValues(base, phase));
    assert.deepEqual(docs.filter((doc) => doc.kind === 'Deployment').map((doc) => doc.metadata.name), ['fixture-maintenance']);
    assert.equal(docs.some((doc) => ['Secret', 'PersistentVolumeClaim', 'StatefulSet'].includes(doc.kind)), false);
  }
  assert.ok(resource(documents(phaseValues(base, 'verify')), 'Deployment', 'fixture-runner'));
});

test('migration is ordinary retained single-attempt Job with separated credentials', () => {
  const base = fixture();
  const docs = documents(phaseValues(base, 'migrate'));
  const job = resource(docs, 'Job', 'fixture-migration-release-001-1');
  assert.equal(job.metadata.annotations['helm.sh/resource-policy'], 'keep');
  assert.equal(job.metadata.annotations['helm.sh/hook'], undefined);
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.ttlSecondsAfterFinished, undefined);
  assert.equal(job.spec.template.spec.restartPolicy, 'Never');
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(job.spec.template.spec.containers[0].command, base.target.migration.command);
  assert.equal(documents(phaseValues(base, 'verify')).some((doc) => doc.kind === 'Job'), false);
  const later = phaseValues(base, 'migrate');
  later.release.sequence = 99;
  const retained = resource(documents(later), 'Job', 'fixture-migration-release-001-1');
  assert.deepEqual(retained.spec, job.spec, 'retained Job spec is immutable across phase sequence changes');
  assert.ok(job.spec.template.spec.containers[0].env.some((entry) => entry.name === 'SMRT_RELEASE_ID' && entry.value === base.release.id));
  const next = phaseValues(base, 'migrate');
  next.release.attempt = 2;
  assert.ok(resource(documents(next), 'Job', 'fixture-migration-release-001-2'));
});

test('migration preserves application SMRT settings without overriding release identity', () => {
  const base = fixture();
  const settings = ['SMRT_RUNTIME_PROFILE', 'SMRT_APP_ID'].map((name) => ({
    name,
    valueFrom: { secretKeyRef: { name: 'migration-config-v1', key: name } },
  }));
  base.target.migration.env.push(...settings);
  for (const phase of ['maintenance', 'stopped', 'migrate', 'verify', 'active']) {
    const docs = documents(phaseValues(base, phase));
    if (phase !== 'migrate') continue;
    const env = resource(docs, 'Job', 'fixture-migration-release-001-1')
      .spec.template.spec.containers[0].env;
    assert.deepEqual(env.filter(({ name }) => settings.some((setting) => setting.name === name)), settings);
    assert.equal(new Set(env.map(({ name }) => name)).size, env.length);
    for (const [name, value] of Object.entries({
      SMRT_RELEASE_ID: base.release.id,
      SMRT_RELEASE_ATTEMPT: String(base.release.attempt),
      SMRT_APP_NAME: base.app.name,
      SMRT_APP_ENVIRONMENT: base.app.environment,
    })) assert.deepEqual(env.find((entry) => entry.name === name), { name, value });
  }
});

for (const name of ['SMRT_RELEASE_ID', 'SMRT_RELEASE_ATTEMPT', 'SMRT_APP_NAME',
  'SMRT_APP_ENVIRONMENT', 'SMRT_UNKNOWN', 'SMRT_APP_IDS', 'SMRT_RUNTIME_PROFILES']) {
  test(`migration rejects reserved or unrecognized SMRT setting: ${name}`, () => {
    const base = phaseValues(fixture(), 'migrate');
    base.target.migration.env.push({ name, valueFrom: {
      secretKeyRef: { name: 'migration-config-v1', key: name },
    } });
    assert.throws(() => render(base), /SMRT_ migration environment names are reserved for release identity/);
  });
}

test('entire future inventory and named secret bindings are visible before maintenance', () => {
  const base = fixture();
  base.target.workloads.extra = structuredClone(base.target.workloads.task);
  const docs = documents(base);
  const inventory = JSON.parse(resource(docs, 'ConfigMap', 'fixture-inventory').data['inventory.json']);
  assert.equal(inventory.version, 1);
  const declared = new Set(inventory.resources.map(({ kind, name }) => `${kind}/${name}`));
  for (const phase of ['maintenance', 'stopped', 'migrate', 'verify', 'active']) {
    for (const doc of documents(phaseValues(base, phase))) {
      assert.ok(declared.has(`${doc.kind}/${doc.metadata.name}`), `inventory includes ${doc.kind}/${doc.metadata.name}`);
      assert.equal(doc.metadata.labels['smrt.happyvertical.com/release'], base.release.id);
    }
  }
  assert.ok(declared.has('Deployment/fixture-extra'));
  assert.ok(inventory.secrets.every((secret) => secret.immutable === true));
  assert.ok(inventory.secrets.some((secret) => secret.usage === 'migration'));
  assert.ok(inventory.secrets.some((secret) => secret.usage === 'bucket'));
  assert.ok(inventory.requirements.rbac.some((rule) => rule.resource === 'jobs' && rule.verbs.includes('create')));
  assert.ok(inventory.requirements.admission.length >= 4);
});

test('static responder is independent, configured and identity bound', () => {
  const base = fixture();
  const docs = documents(base);
  const config = resource(docs, 'ConfigMap', 'fixture-maintenance').data['default.conf'];
  assert.match(config, /return 503 "Maintenance"/);
  assert.match(config, /X-Smrt-Release release-001 always/);
  assert.match(config, /X-Smrt-Sequence 0 always/);
  const pod = resource(docs, 'Deployment', 'fixture-maintenance').spec.template.spec;
  assert.equal(pod.containers[0].image, base.maintenance.image);
  assert.equal(pod.containers[0].volumeMounts[0].mountPath, '/etc/nginx/conf.d');
  const next = structuredClone(base);
  next.release.sequence++;
  const nextPod = resource(documents(next), 'Deployment', 'fixture-maintenance').spec.template;
  assert.notDeepEqual(nextPod, resource(docs, 'Deployment', 'fixture-maintenance').spec.template, 'new responder identity rolls pods to reload nginx config');
  assert.equal(nextPod.metadata.labels['smrt.happyvertical.com/sequence'], String(next.release.sequence));
});

for (const [name, change] of [
  ['missing current', (v) => { delete v.current; }],
  ['null current', (v) => { v.current = null; }],
  ['true current', (v) => { v.current = true; }],
  ['empty current', (v) => { v.current = {}; }],
  ['responder variable interpolation', (v) => { v.maintenance.http.body = '$hostname'; }],
  ['mutable images', (v) => { v.target.workloads.web.image = 'app:latest'; }],
  ['unknown top-level provisioning', (v) => { v.postgresql = { enabled: true }; }],
  ['unknown nested capabilities', (v) => { v.target.workloads.web.autoscaling = {}; }],
  ['plaintext environment secrets', (v) => { v.target.workloads.web.env = [{ name: 'PASSWORD', value: 'secret' }]; }],
  ['multi-replica scheduler', (v) => { v.target.workloads.schedule.replicas = 2; }],
  ['missing writer classification', (v) => { delete v.target.workloads.extractor.writer; }],
  ['shared migration credentials', (v) => { v.target.migration.env = v.target.workloads.web.env; }],
  ['absent migration credential', (v) => { v.target.migration.env = []; }],
  ['undeclared migration image', (v) => { v.target.migration.image = `other@sha256:${'d'.repeat(64)}`; }],
  ['unsupported lifecycle phase', (v) => { v.release.phase = 'rolling'; }],
  ['reserved migration environment', (v) => { v.target.migration.env[0].name = 'SMRT_RELEASE_ID'; }],
  ['unsupported migration guard', (v) => { v.target.migration.guard = 'shell'; }],
  ['multiple public web workloads', (v) => { v.target.workloads.other = structuredClone(v.target.workloads.web); }],
  ['responder config injection', (v) => { v.maintenance.http.body = 'oops"; return 200'; }],
]) {
  test(`fail closed: ${name}`, () => {
    const values = fixture();
    change(values);
    assert.throws(() => render(values));
  });
}

test('bounded security envelope and migration-only observer projection survive rendering', () => {
  const base = phaseValues(fixture(), 'migrate');
  const security = {
    podSecurityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
    serviceAccountName: 'app-runtime',
    scratch: [{ name: 'tmp', mountPath: '/tmp', sizeLimit: '16Mi' }],
  };
  Object.assign(base.current.workloads.web, security);
  Object.assign(base.target.migration, security, { serviceAccountName: 'app-observer', observerAccess: true });
  const docs = documents(base);
  const runtime = resource(docs, 'Deployment', 'fixture-web').spec.template.spec;
  const migration = resource(docs, 'Job', `fixture-migration-${base.release.id}-${base.release.attempt}`).spec.template.spec;
  for (const pod of [runtime, migration]) {
    assert.equal(pod.automountServiceAccountToken, false);
    assert.deepEqual(pod.securityContext, security.podSecurityContext);
    assert.deepEqual(pod.containers[0].securityContext, security.securityContext);
    assert.deepEqual(pod.volumes[0], { name: 'tmp', emptyDir: { sizeLimit: '16Mi' } });
  }
  assert.equal(runtime.serviceAccountName, 'app-runtime');
  assert.equal(runtime.volumes.some((v) => v.projected), false);
  assert.equal(migration.serviceAccountName, 'app-observer');
  const projection = migration.volumes.find((v) => v.name === 'smrt-observer').projected;
  assert.deepEqual(projection.sources[0], { serviceAccountToken: { path: 'token', expirationSeconds: 600 } });
  assert.deepEqual(projection.sources[1], { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } });
  assert.deepEqual(projection.sources[2].downwardAPI.items.map((v) => v.path), ['namespace', 'pod-name', 'pod-uid']);
  assert.deepEqual(migration.containers[0].volumeMounts[1], { name: 'smrt-observer', mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', readOnly: true });
  for (const mutate of [
    (v) => { delete v.target.migration.serviceAccountName; },
    (v) => { v.target.workloads.web.observerAccess = true; },
    (v) => { v.target.migration.podSecurityContext.runAsUser = 0; },
    (v) => { v.target.migration.podSecurityContext.seccompProfile.type = 'Unconfined'; },
    (v) => { v.target.migration.securityContext.privileged = true; },
    (v) => { v.target.migration.securityContext.allowPrivilegeEscalation = true; },
    (v) => { v.target.migration.securityContext.capabilities.add = ['SYS_ADMIN']; },
    (v) => { v.target.migration.scratch[0].mountPath = '/var/run'; },
    (v) => { v.target.migration.scratch[0].mountPath = '/tmp/../var'; },
    (v) => { v.target.migration.scratch[0].hostPath = '/'; },
    (v) => { v.target.migration.hostNetwork = true; },
  ]) {
    const invalid = structuredClone(base);
    mutate(invalid);
    assert.throws(() => render(invalid));
  }
  base.target.migration.observerAccess = false;
  assert.equal(resource(documents(base), 'Job', `fixture-migration-${base.release.id}-${base.release.attempt}`).spec.template.spec.volumes.some((v) => v.projected), false);
});

const legacyValues = () => {
  const values = fixture();
  for (const runtime of [values.current, values.target]) {
    runtime.workloads.web.selectorLabels = { app: 'jobgeni-web' };
    runtime.workloads.site = {
      ...structuredClone(runtime.workloads.web), role: 'service', writer: false,
      selectorLabels: { app: 'jobgeni-site' }, continuousStatic: true, env: [], replicas: 1,
      automountServiceAccountToken: false,
      podSecurityContext: { runAsNonRoot: true, runAsUser: 101, runAsGroup: 101, seccompProfile: { type: 'RuntimeDefault' } },
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
      readOnlyConfigMaps: [{ volumeName: 'site-content', configMapName: 'site-v1', hash: 'a'.repeat(64), mountPath: '/usr/share/nginx/html', items: [{ key: 'index.html', path: 'index.html' }] }],
    };
    runtime.workloads.monitor.startingDeadlineSeconds = 600;
    runtime.workloads.monitor.activeDeadlineSeconds = 3300;
    runtime.workloads.monitor.ttlSecondsAfterFinished = 86400;
    runtime.workloads.monitor.successfulJobsHistoryLimit = 2;
    runtime.workloads.monitor.failedJobsHistoryLimit = 3;
  }
  values.ingress.name = 'jobgeni-web';
  values.ingress.annotations = { 'nginx.ingress.kubernetes.io/proxy-body-size': '11m', 'nginx.ingress.kubernetes.io/proxy-buffer-size': '64k' };
  values.ingress.additionalRoutes = [{ name: 'jobgeni-site', host: 'www.jobgeni.test', workload: 'site', tlsSecretName: 'site-tls' }];
  return values;
};

test('legacy selectors, static services and independent ingress survive every maintenance phase', () => {
  for (const phase of ['maintenance', 'stopped', 'migrate', 'verify', 'active']) {
    const values = phaseValues(legacyValues(), phase);
    const docs = documents(values);
    const site = resource(docs, 'Deployment', 'fixture-site');
    assert.equal(site.spec.replicas, 1);
    assert.deepEqual(site.spec.strategy, { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } });
    assert.deepEqual(resource(docs, 'Deployment', 'fixture-web').spec.strategy, { type: 'Recreate' });
    assert.deepEqual(site.spec.selector.matchLabels, { app: 'jobgeni-site' });
    assert.equal(site.spec.template.metadata.labels.app, 'jobgeni-site');
    assert.equal(site.spec.template.metadata.labels['app.kubernetes.io/instance'], 'fixture');
    assert.deepEqual(resource(docs, 'Service', 'fixture-web').spec.selector, { app: 'jobgeni-web' });
    assert.equal(site.spec.template.spec.containers[0].volumeMounts[0].readOnly, true);
    assert.deepEqual(site.spec.template.spec.volumes, [{ name: 'site-content', configMap: { name: 'site-v1', items: [{ key: 'index.html', path: 'index.html' }] } }]);
    assert.equal(resource(docs, 'Ingress', 'jobgeni-web').spec.rules[0].http.paths[0].backend.service.name, phase === 'active' ? 'fixture-web' : 'fixture-maintenance');
    assert.equal(resource(docs, 'Ingress', 'jobgeni-site').spec.rules[0].http.paths[0].backend.service.name, 'fixture-site');
    const cron = resource(docs, 'CronJob', 'fixture-monitor');
    assert.equal(cron.spec.startingDeadlineSeconds, 600);
    assert.equal(cron.spec.jobTemplate.spec.activeDeadlineSeconds, 3300);
    assert.equal(cron.spec.jobTemplate.spec.ttlSecondsAfterFinished, 86400);
    assert.equal(cron.spec.successfulJobsHistoryLimit, 2);
    assert.equal(cron.spec.failedJobsHistoryLimit, 3);
    const inventory = JSON.parse(resource(docs, 'ConfigMap', 'fixture-inventory').data['inventory.json']);
    assert.ok(inventory.readOnlyConfigMaps.some((r) => r.name === 'site-v1' && r.external && r.immutable));
    assert.ok(inventory.secrets.some((r) => r.name === 'site-tls' && r.usage === 'tls'));
    assert.equal(inventory.resources.some((r) => r.name === 'site-v1'), false);
  }
});

test('bounded adoption fields reject selectors, unsafe static claims, routes and mount escapes', () => {
  const mutations = [
    (v) => { v.target.workloads.web.selectorLabels = { app: 'changed' }; },
    (v) => { v.current.workloads.site.selectorLabels = { 'smrt.happyvertical.com/writer': 'false' }; },
    (v) => { v.current.workloads.site.strategy = { type: 'Recreate' }; },
    (v) => { v.current.workloads.site.writer = true; },
    (v) => { v.current.workloads.site.env = v.current.workloads.web.env; },
    (v) => { delete v.current.workloads.site.securityContext; },
    (v) => { delete v.current.workloads.site.automountServiceAccountToken; },
    (v) => { v.current.workloads.site.automountServiceAccountToken = true; },
    (v) => { v.target.workloads.site.continuousStatic = false; },
    (v) => { v.target.workloads.site.service.port += 1; },
    (v) => { v.ingress.additionalRoutes[0].workload = 'task'; },
    (v) => { v.ingress.additionalRoutes[0].host = v.ingress.host; },
    (v) => { v.ingress.additionalRoutes[0].name = v.ingress.name; },
    (v) => { v.ingress.annotations['nginx.ingress.kubernetes.io/server-snippet'] = 'unsafe'; },
    (v) => { v.current.workloads.site.readOnlyConfigMaps[0].items[0].path = '../token'; },
    (v) => { v.current.workloads.site.readOnlyConfigMaps[0].mountPath = '/var/run/secrets'; },
    (v) => { v.current.workloads.site.scratch = [{ name: 'other', mountPath: '/usr/share' }]; },
    (v) => { v.target.workloads.site.readOnlyConfigMaps[0].hash = 'b'.repeat(64); },
    (v) => { v.target.workloads.monitor.activeDeadlineSeconds = 3301; },
  ];
  for (const mutate of mutations) { const v = legacyValues(); mutate(v); assert.throws(() => render(v), undefined, mutate.toString()); }
});

test('bootstrap never creates a fake legacy static runtime before verify', () => {
  const values = legacyValues(); values.current = false;
  for (const phase of ['maintenance', 'stopped', 'migrate']) {
    const docs = documents(phaseValues(values, phase));
    assert.equal(docs.some((d) => d.kind === 'Deployment' && d.metadata.name === 'fixture-site'), false);
  }
  assert.equal(resource(documents(phaseValues(values, 'verify')), 'Deployment', 'fixture-site').spec.replicas, 1);
});


test('native exercise package and OCI receipt follow arbitrary chart versions without replacing published artifacts', () => {
  for (const version of ['2.7.19', '1.8.0-rc.2+build.7']) {
    const directory = join(scratch, `version-${version}`);
    cpSync(chart, directory, { recursive: true });
    const metadata = parseAllDocuments(readFileSync(join(directory, 'Chart.yaml'), 'utf8'))[0];
    metadata.set('version', version);
    writeFileSync(join(directory, 'Chart.yaml'), metadata.toString());
    const artifact = chartArtifact(directory, scratch, 'http://registry.example.invalid:5000');
    assert.equal(artifact.version, version);
    assert.equal(artifact.packagePath, join(scratch, `smrt-app-${version}.tgz`));
    assert.equal(artifact.ociTag, version.replace('+', '_'));
    assert.equal(artifact.manifestUrl, `http://registry.example.invalid:5000/v2/charts/smrt-app/manifests/${version.replace('+', '_')}`);
    execFileSync(helm, ['package', directory, '--destination', scratch]);
    assert.ok(readFileSync(artifact.packagePath).length > 0);
    assert.throws(() => chartArtifact(directory, scratch, 'https://user:password@registry.example.invalid'), /credential-free/);
    metadata.set('version', '../0.2.1');
    writeFileSync(join(directory, 'Chart.yaml'), metadata.toString());
    assert.throws(() => chartArtifact(directory, scratch, 'http://registry.example.invalid'), /versioned/);
  }
});
