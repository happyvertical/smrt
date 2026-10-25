import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('representative fixtures lint strictly and chart packages independently', () => {
  for (const app of ['iolaus', 'work']) {
    execFileSync(helm, ['lint', '--strict', chart, '-f', join(chart, 'fixtures', `${app}.json`)]);
  }
  execFileSync(helm, ['package', chart, '--destination', scratch]);
  assert.ok(readFileSync(join(scratch, 'smrt-app-0.1.0.tgz')).length > 0);
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
