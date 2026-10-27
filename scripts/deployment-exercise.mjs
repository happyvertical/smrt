/** Disposable Kubernetes/Flux chart exercise. Never targets a downstream app.
 * Requires an explicitly supplied kind kubeconfig and opt-in. The caller owns
 * installing the pinned tools/controllers and capturing stdout/stderr evidence.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyRuntime, isCorrelatedMigrationFailure } from './deployment/live.mjs';
import { transition, repairRelease, validateRepairEvidence, identity, hash as releaseHash } from './deployment/release.mjs';

const namespace = 'smrt-deployment-exercise';
const fixtures = 'smrt-deployment-fixtures';
const clusterName = 'smrt-deployment-exercise';
const kubeconfig = process.env.KUBECONFIG;
if (process.env.SMRT_DEPLOYMENT_EXERCISE !== '1' || !kubeconfig || kubeconfig.includes(':')) {
  throw new Error('Require SMRT_DEPLOYMENT_EXERCISE=1 and one explicit isolated kind KUBECONFIG');
}
const helm = process.env.SMRT_HELM || 'helm';
const kubectl = process.env.SMRT_KUBECTL || 'kubectl';
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'smrt-deployment-exercise-'));
const images = Object.freeze({
  nginxOld: 'docker.io/library/nginx@sha256:09ab424a8c788f8d0fe3a64429f6d19dfa526885c8609b748d0943a75dcb9f8c',
  nginxNew: 'docker.io/library/nginx@sha256:845b5424415de5f77dd5753cbb7c1be8bd8e44cc81f20f9705783a02f8848317',
  postgres: 'docker.io/library/postgres@sha256:0ae695e3d11c7cc82cbed8f3e506233f18cdd40e3fc7622893f6a4d0772a5a09',
  registry: 'docker.io/library/registry@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278',
  traefik: 'docker.io/library/traefik@sha256:06b2f92ba6cb9fdc2de99d41c22b862f196871ad55c26269083eaef39dd4fa99',
  minio: 'docker.io/bitnamilegacy/minio@sha256:b3d51900e846b92f7503ca6be07d2e8c56ebb6a13a60bc71b8777c716c074bcf',
});
const children = [];
const ownedNamespaces = [];
const ownedClusterResources = [];
const note = (message) => console.log(`[exercise] ${message}`);
function redactFixtureMessage(message) {
  let safe = String(message ?? '').slice(0, 6000);
  for (const secret of ['isolated-fixture-password', 'isolated-runtime-password', 'isolated-migration-password', 'isolated-bucket-password', 'fixture-access']) safe = safe.replaceAll(secret, '[redacted]');
  return safe.replace(/postgres(?:ql)?:\/\/[^\s]+/g, 'postgresql://[redacted]');
}

function k(args, input) {
  return execFileSync(kubectl, ['--kubeconfig', resolve(kubeconfig), ...args], {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000,
  });
}
const get = (kind, name, ns = namespace) => JSON.parse(k(['-n', ns, 'get', kind, name, '-o', 'json']));
function apply(resources) {
  k(['apply', '-f', '-'], { apiVersion: 'v1', kind: 'List', items: resources });
}
async function until(description, check, timeout = 180000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error.message; }
    await delay(1000);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last})` : ''}`);
}
const resource = (apiVersion, kind, name, spec, ns = fixtures) => ({ apiVersion, kind, metadata: { name, namespace: ns }, ...spec });
function externalDeployment(name, image, command, env = [], extra = {}) {
  return resource('apps/v1', 'Deployment', name, { spec: {
    replicas: 1, selector: { matchLabels: { fixture: name } },
    template: { metadata: { labels: { fixture: name } }, spec: {
      containers: [{ name, image, command, env, ...extra }],
    } },
  } });
}
const service = (name, port) => resource('v1', 'Service', name, { spec: { selector: { fixture: name }, ports: [{ port, targetPort: port }] } });
const envRef = (name, secret = 'runtime-v1', key = name.toLowerCase()) => ({ name, valueFrom: { secretKeyRef: { name: secret, key } } });
const credentials = {
  pghost: `postgres.${fixtures}.svc.cluster.local`, pguser: 'runtime', pgdatabase: 'fixture', pgpassword: 'isolated-runtime-password',
};
function secret(name, data, ns = namespace) {
  return resource('v1', 'Secret', name, { immutable: true, type: 'Opaque', data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')])) }, ns);
}
function sql(statement) {
  return k(['-n', fixtures, 'exec', 'deployment/postgres', '--', 'psql', '-U', 'fixture', '-d', 'fixture', '-v', 'ON_ERROR_STOP=1', '-Atc', statement]).trim();
}
async function forward(name, port, targetNamespace = fixtures) {
  const child = spawn(kubectl, ['--kubeconfig', resolve(kubeconfig), '-n', targetNamespace, 'port-forward', `service/${name}`, `:${port}`, '--address=127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await until(`port-forward ${name}`, () => {
    if (child.exitCode !== null) throw new Error(`port-forward exited ${child.exitCode}`);
    return /127\.0\.0\.1:(\d+)/.test(output);
  }, 30000);
  return `http://127.0.0.1:${output.match(/127\.0\.0\.1:(\d+)/)[1]}`;
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
async function s3(endpoint, method, path, body = '') {
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const host = new URL(endpoint).host;
  const payload = hash(body);
  const headers = `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${now}\n`;
  const signed = 'host;x-amz-content-sha256;x-amz-date';
  const request = `${method}\n${path}\n\n${headers}\n${signed}\n${payload}`;
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac('AWS4isolated-bucket-password', date), 'us-east-1'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n${now}\n${scope}\n${hash(request)}`).digest('hex');
  return fetch(`${endpoint}${path}`, { method, body: ['GET', 'HEAD'].includes(method) ? undefined : body, headers: {
    'x-amz-content-sha256': payload, 'x-amz-date': now,
    Authorization: `AWS4-HMAC-SHA256 Credential=fixture-access/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  }, signal: AbortSignal.timeout(10000) });
}
const resources = { requests: { cpu: '25m', memory: '32Mi' }, limits: { cpu: '500m', memory: '256Mi' } };
const observerProbe = `set -eu
observer=/var/run/secrets/kubernetes.io/serviceaccount
for file in token ca.crt namespace pod-name pod-uid; do test -s "$observer/$file"; done
test "$(id -u)" = 10001
test "$(cat "$observer/namespace")" = '${namespace}'
printf 'observer-pod-name:%s\\nobserver-pod-uid:%s\\n' "$(cat "$observer/pod-name")" "$(cat "$observer/pod-uid")"
echo scratch > /tmp/observer-scratch
rm /tmp/observer-scratch
if touch /smrt-root-probe 2>/dev/null; then echo root-write-unexpected; exit 81; fi
`;
function runtime(version, broken = false) {
  const web = { role: 'web', writer: true, image: version === 'old' ? images.nginxOld : images.nginxNew,
    command: ['sh', '-c', `printf 'pid /tmp/nginx.pid; error_log stderr; events {} http { access_log off; client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; server { listen 8080; location = /health { return 200 "ready"; } location / { return ${broken ? 500 : 200} "${version}-release"; } } }' > /tmp/nginx.conf; exec nginx -p /tmp -c /tmp/nginx.conf -e stderr -g 'daemon off;'`],
    env: [], replicas: 1, port: 8080, service: { port: 8080 }, readinessProbe: { httpGet: { path: '/health', port: 8080 } }, resources, terminationGracePeriodSeconds: 10 };
  const writer = { role: 'task', writer: true, image: images.postgres,
    command: ['sh', '-c', 'trap "exit 0" TERM INT; while :; do psql -v ON_ERROR_STOP=1 -c "INSERT INTO writer_ticks DEFAULT VALUES"; sleep 1 & wait $!; done'],
    env: ['PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD'].map((name) => envRef(name)), replicas: 1,
    readinessProbe: { exec: { command: ['sh', '-c', 'pg_isready -h "$PGHOST" -U "$PGUSER"'] } }, resources, terminationGracePeriodSeconds: 10 };
  // Kubelet collapses double-dollar command escapes before shell execution;
  // tagged PostgreSQL dollar quoting survives that independent expansion layer.
  const migration = { image: images.postgres, command: ['sh', '-c', `set -eu
psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_advisory_lock(4305);
DO $smrt$ BEGIN IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename='runtime' AND pid <> pg_backend_pid() AND client_addr IS NOT NULL) THEN RAISE EXCEPTION 'runtime connection remains'; END IF; END $smrt$;
BEGIN;
INSERT INTO phase_ledger(id) VALUES ('committed-step') ON CONFLICT DO NOTHING;
INSERT INTO effects(id) SELECT 'once' WHERE NOT EXISTS (SELECT 1 FROM effects WHERE id='once');
COMMIT;
SQL
if [ "$SMRT_RELEASE_ATTEMPT" = 1 ]; then echo intentional-failure-after-commit; exit 23; fi
psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_advisory_lock(4305);
DO $smrt$ BEGIN IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename='runtime' AND pid <> pg_backend_pid() AND client_addr IS NOT NULL) THEN RAISE EXCEPTION 'runtime connection remains'; END IF; END $smrt$;
BEGIN;
INSERT INTO phase_ledger(id) VALUES ('repair-step') ON CONFLICT DO NOTHING;
COMMIT;
SQL`], env: ['PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD'].map((name) => envRef(name, 'migration-v1')), guard: 'smrt-release-v1', resources, terminationGracePeriodSeconds: 30 };
  const envelope = {
    podSecurityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
    scratch: [{ name: 'tmp', mountPath: '/tmp', sizeLimit: '16Mi' }],
  };
  Object.assign(web, structuredClone(envelope));
  Object.assign(writer, structuredClone(envelope));
  Object.assign(migration, structuredClone(envelope), { serviceAccountName: 'exercise-observer', observerAccess: true });
  migration.command[2] = observerProbe + migration.command[2];
  return { workloads: { web, writer }, migration };
}
let sequence = 0;
const bootstrapRuntime = runtime('old');
bootstrapRuntime.migration.command = ['sh', '-c', observerProbe + 'psql -v ON_ERROR_STOP=1 -c "SELECT 1"'];
let values = { release: { id: 'bootstrap-001', phase: 'maintenance', sequence, attempt: 1 }, app: { name: 'fixture', environment: 'isolated' }, current: false, target: bootstrapRuntime,
  maintenance: { image: images.nginxOld, command: ['nginx', '-g', 'daemon off;'], port: 8080, http: { path: '/', status: 503, body: 'Maintenance' } },
  bindings: { database: { secretName: 'runtime-v1', secretKey: 'pghost' }, privateBuckets: [{ name: 'assets', secretName: 'bucket-v1', secretKey: 'endpoint' }] },
  ingress: { host: 'exercise.example.invalid', className: 'smrt-exercise' } };
async function reconcile(phase, extra = {}, { expectedMigrationFailure = false, annotations = {} } = {}) {
  assert.ok(!expectedMigrationFailure || phase === 'migrate', 'only an explicitly expected migration failure permits a non-Ready reconciliation');
  values = { ...values, ...extra, release: { ...values.release, phase, sequence: ++sequence, ...(extra.release || {}) } };
  k(['-n', namespace, 'patch', 'helmrelease', 'exercise', '--type=merge', '-p', JSON.stringify({ spec: { values }, metadata: { annotations: { ...annotations, 'reconcile.fluxcd.io/requestedAt': String(Date.now()) } } })]);
  await until(`Flux acknowledges ${phase} sequence ${sequence}`, () => {
    const hr = get('helmrelease', 'exercise');
    const currentGeneration = hr.status?.observedGeneration === hr.metadata.generation && isDeepStrictEqual(hr.spec.values, values);
    const ready = hr.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True' && c.observedGeneration === hr.metadata.generation);
    const sameIngress = get('ingress', 'exercise').metadata.labels['smrt.happyvertical.com/sequence'] === String(sequence);
    if (!currentGeneration || !sameIngress) return false;
    if (!expectedMigrationFailure) return ready;
    const failed = hr.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'False' && c.reason === 'UpgradeFailed' && c.observedGeneration === hr.metadata.generation);
    if (!failed) return false;
    assert.ok(isCorrelatedMigrationFailure(hr, { ...hr, spec: { ...hr.spec, values } }, { allowFailedMigration: true }), `actual current-generation Flux migration failure does not match the shared correlation predicate: ${redactFixtureMessage(hr.status.conditions.find((condition) => condition.type === 'Ready')?.message)}`);
    const job = get('job', `exercise-migration-${values.release.id}-${values.release.attempt}`);
    if (job.status?.failed !== 1 || job.metadata.labels['smrt.happyvertical.com/sequence'] !== String(sequence)) return false;
    const maintenance = get('deployment', 'exercise-maintenance');
    if (maintenance.metadata.labels['smrt.happyvertical.com/sequence'] !== String(sequence)
      || maintenance.status?.observedGeneration !== maintenance.metadata.generation
      || maintenance.status?.readyReplicas !== 1 || maintenance.status?.updatedReplicas !== 1) return false;
    return Object.keys(values.current.workloads).every((name) => {
      const workload = values.current.workloads[name];
      if (workload.schedule) return get('cronjob', `exercise-${name}`).spec.suspend === true;
      const deployment = get('deployment', `exercise-${name}`);
      return deployment.metadata.labels['smrt.happyvertical.com/sequence'] === String(sequence) && deployment.spec.replicas === 0;
    });
  });
  if (expectedMigrationFailure) {
    const hr = get('helmrelease', 'exercise');
    const job = get('job', `exercise-migration-${values.release.id}-${values.release.attempt}`);
    const redact = redactFixtureMessage;
    assert.ok(isCorrelatedMigrationFailure(hr, hr, { allowFailedMigration: true }), 'shared readiness waiver recognizes actual ReadyFalse failed migration');
    note(`expected failed migration HR conditions: ${JSON.stringify(hr.status.conditions.filter((condition) => ['Ready', 'Released'].includes(condition.type)).map(({ type, status, reason, message, observedGeneration }) => ({ type, status, reason, message: redact(message), observedGeneration })))}`);
    note(`expected failed migration Job: ${JSON.stringify({ name: job.metadata.name, uid: job.metadata.uid, conditions: job.status.conditions?.map(({ type, status, reason, message }) => ({ type, status, reason, message: redact(message) })) })}`);
  }
  note(expectedMigrationFailure ? `Flux applied migrate sequence ${sequence}; failed Job requires explicit repair and no phase advance` : `Flux accepted ${phase} sequence ${sequence}`);
}
function routeRequest(endpoint) {
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(endpoint, { headers: { Host: values.ingress.host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16384) request.destroy(new Error('HTTP assertion response exceeds fixture bound'));
      });
      response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('HTTP assertion timed out')));
    request.on('error', reject);
    request.end();
  });
}
const safeHeader = (value) => String(value ?? 'absent').replace(/[^a-zA-Z0-9 ._-]/g, '?').slice(0, 100);
async function http(endpoint, status, text, identity = false) {
  await until(`Ingress HTTP ${status} ${text}`, async () => {
    const response = await routeRequest(endpoint);
    const bodyMatches = response.body.includes(text);
    const release = response.headers['x-smrt-release'];
    const observedSequence = response.headers['x-smrt-sequence'];
    if (response.status !== status || !bodyMatches || identity && (release !== values.release.id || observedSequence !== String(sequence))) {
      throw new Error(`HTTP status=${response.status} expected=${status} bodyMatches=${bodyMatches} release=${safeHeader(release)} expectedRelease=${values.release.id} sequence=${safeHeader(observedSequence)} expectedSequence=${sequence}`);
    }
    return true;
  }, 60000);
}
function migrationLogs(name) {
  try {
    let logs = k(['-n', namespace, 'logs', `job/${name}`, '--all-containers=true', '--tail=80', '--limit-bytes=16384']);
    for (const secret of ['isolated-fixture-password', 'isolated-runtime-password', 'isolated-migration-password', 'isolated-bucket-password', 'fixture-access']) logs = logs.replaceAll(secret, '[redacted]');
    return logs.replace(/postgres(?:ql)?:\/\/[^\s]+/g, 'postgresql://[redacted]').slice(-16384);
  } catch { return 'migration log unavailable'; }
}
function diagnose() {
  if (!ownedNamespaces.includes(namespace)) return;
  for (const kind of ['ingress', 'service', 'endpointslice', 'pod', 'deployment', 'job', 'helmrelease']) {
    try {
      const objects = JSON.parse(k(['-n', namespace, 'get', kind, '-o', 'json'])).items;
      const summary = objects.map((object) => ({
        kind: object.kind, name: object.metadata.name, generation: object.metadata.generation,
        observedGeneration: object.status?.observedGeneration,
        conditions: object.status?.conditions?.map(({ type, status, reason, message }) => ({ type, status, reason, ...(object.kind === 'HelmRelease' ? { message: redactFixtureMessage(message) } : {}) })),
        replicas: object.status?.replicas, readyReplicas: object.status?.readyReplicas,
        failed: object.status?.failed, succeeded: object.status?.succeeded,
        ingressClassName: object.spec?.ingressClassName, ingressRules: object.spec?.rules,
        serviceSelector: object.kind === 'Service' ? object.spec?.selector : undefined,
        servicePorts: object.kind === 'Service' ? object.spec?.ports : undefined,
        endpoints: object.endpoints?.map(({ conditions, targetRef, addresses }) => ({ conditions, targetRef, addresses })),
      }));
      note(`failure snapshot ${kind}: ${JSON.stringify(summary)}`);
    } catch { note(`failure snapshot ${kind}: unavailable`); }
  }
  try {
    const jobs = JSON.parse(k(['-n', namespace, 'get', 'jobs', '-o', 'json'])).items;
    for (const job of jobs.filter((item) => item.metadata.name.startsWith('exercise-migration-'))) {
      note(`migration ${job.metadata.name} bounded log:\n${migrationLogs(job.metadata.name)}`);
    }
  } catch { note('migration job logs unavailable'); }
  try {
    const errors = k(['-n', fixtures, 'logs', 'deployment/traefik', '--tail=80']).split('\n').filter((line) => /error|ERR|forbidden|failed/i.test(line));
    note(`Traefik errors: ${errors.length ? errors.join('\n') : 'none in last 80 log lines'}`);
  } catch { note('Traefik error log unavailable'); }
}
function existingOwnedResource(desired, serviceAccount = 'exercise-reconciler') {
  const output = k(['-n', namespace, '--as', `system:serviceaccount:${namespace}:${serviceAccount}`, 'get', desired.kind, desired.metadata.name, '--ignore-not-found', '--show-managed-fields=true', '-o', 'json']);
  if (!output.trim()) return null;
  const existing = JSON.parse(output);
  assert.ok(existing.metadata.annotations?.['meta.helm.sh/release-name'] === 'exercise'
    && existing.metadata.annotations?.['meta.helm.sh/release-namespace'] === namespace
    && existing.metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm', `Helm release ownership mismatch: ${desired.kind}/${desired.metadata.name}`);
  assert.ok(existing.metadata.managedFields?.some((entry) => entry.manager === 'helm-controller'
    && ['Apply', 'Update'].includes(entry.operation) && entry.fieldsType === 'FieldsV1'
    && entry.fieldsV1 && Object.keys(entry.fieldsV1).length > 0), `Missing actual helm-controller ownership: ${desired.kind}/${desired.metadata.name}`);
  return existing;
}
function snapshot(existing) {
  if (!existing) return null;
  return JSON.stringify({ spec: existing.spec, data: existing.data, binaryData: existing.binaryData,
    labels: existing.metadata.labels, annotations: existing.metadata.annotations, managedFields: existing.metadata.managedFields });
}
function preflightObjects(objects, serviceAccount = 'exercise-reconciler') {
  const before = objects.map((object) => snapshot(existingOwnedResource(object, serviceAccount)));
  try {
    for (const object of objects) {
      const template = object.kind === 'CronJob' ? object.spec?.jobTemplate?.spec?.template : object.spec?.template;
      if (template) {
        k(['-n', namespace, '--as', `system:serviceaccount:${namespace}:${serviceAccount}`, 'create', '--dry-run=server', '-f', '-'], { apiVersion: 'v1', kind: 'Pod', metadata: { ...template.metadata, name: `smrt-preflight-${randomUUID()}`, namespace }, spec: template.spec });
      }
    }
    k(['-n', namespace, '--as', `system:serviceaccount:${namespace}:${serviceAccount}`, 'apply', '--server-side', '--dry-run=server', '--field-manager=helm-controller', '-f', '-'], { apiVersion: 'v1', kind: 'List', items: objects });
  } finally {
    for (let i = 0; i < objects.length; i++) {
      assert.equal(snapshot(existingOwnedResource(objects[i], serviceAccount)), before[i], `Dry-run must preserve live spec/data/metadata/managedFields: ${objects[i].kind}/${objects[i].metadata.name}`);
    }
  }
}
async function dryRunAllPhases(candidate) {
  const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
  const { parseAllDocuments } = require('yaml');
  for (const phase of ['maintenance', 'stopped', 'migrate', 'verify', 'active']) {
    const phaseValues = structuredClone(candidate);
    phaseValues.release.phase = phase;
    const path = join(scratch, `dry-run-${phase}.json`);
    writeFileSync(path, JSON.stringify(phaseValues));
    const rendered = execFileSync(helm, ['template', 'exercise', join(root, 'charts/smrt-app'), '--namespace', namespace, '-f', path], { encoding: 'utf8' });
    const objects = parseAllDocuments(rendered).map((document) => {
      assert.deepEqual(document.errors, []);
      return document.toJSON();
    }).filter(Boolean);
    if (phase === 'maintenance') {
      assert.throws(() => preflightObjects(objects, 'denied-reconciler'), (error) => /forbidden/i.test(String(error.stderr || error.message)), 'insufficient reconciler permissions fail before maintenance');
      note('denied reconciler server dry-run rejected before maintenance; live objects unchanged');
    }
    try { preflightObjects(objects); } catch (error) {
      note(`server dry-run ${phase} rejected: ${String(error.stderr || error.message).slice(0, 12000)}`);
      throw error;
    }
    note(`server dry-run ${phase} accepted under declared reconciler identity; live spec and managedFields unchanged`);
  }
}
async function stopped() {
  await until('all application writer Pods terminated', () => {
    const pods = JSON.parse(k(['-n', namespace, 'get', 'pods', '-l', 'app.kubernetes.io/instance=exercise', '-o', 'json'])).items;
    return !pods.some((pod) => pod.metadata.labels['smrt.happyvertical.com/writer'] === 'true');
  });
  const before = sql('SELECT count(*) FROM writer_ticks');
  await delay(2500);
  assert.equal(sql('SELECT count(*) FROM writer_ticks'), before, 'writers actually stopped');
}

try {
  const context = k(['config', 'current-context']).trim();
  assert.match(context, /^kind-/, 'only an explicitly supplied kind context is allowed');
  assert.ok(JSON.parse(k(['get', 'nodes', '-o', 'json'])).items.every((node) => node.status.nodeInfo.architecture === 'amd64'), 'fixture pins Linux amd64 manifests');
  for (const ns of [namespace, fixtures]) {
    const existing = k(['get', 'namespace', ns, '--ignore-not-found']);
    assert.equal(existing.trim(), '', `refusing pre-existing namespace ${ns}`);
  }
  for (const kind of ['clusterrole', 'clusterrolebinding', 'ingressclass']) {
    assert.equal(k(['get', kind, clusterName, '--ignore-not-found']).trim(), '', `refusing pre-existing ${kind}`);
  }
  assert.ok(JSON.parse(k(['-n', 'flux-system', 'get', 'deployments', '-o', 'json'])).items.some((d) => d.metadata.name === 'helm-controller' && d.status.availableReplicas > 0), 'ready Flux helm-controller required');
  for (const ns of [fixtures, namespace]) {
    ownedNamespaces.push(ns); k(['create', 'namespace', ns]);
  }
  note(`isolated context ${context}; exact images ${JSON.stringify(images)}`);
  execFileSync(helm, ['package', join(root, 'charts/smrt-app'), '--destination', scratch], { stdio: 'pipe' });
  const pg = externalDeployment('postgres', images.postgres, ['docker-entrypoint.sh', 'postgres'], [
    { name: 'POSTGRES_USER', value: 'fixture' }, { name: 'POSTGRES_DB', value: 'fixture' }, envRef('POSTGRES_PASSWORD', 'fixture-creds', 'pgpassword'),
  ], { readinessProbe: { exec: { command: ['pg_isready', '-U', 'fixture'] } } });
  pg.spec.template.spec.containers[0].volumeMounts = [{ name: 'data', mountPath: '/var/lib/postgresql/data' }];
  pg.spec.template.spec.volumes = [{ name: 'data', emptyDir: {} }];
  const bucket = externalDeployment('bucket', images.minio, ['/opt/bitnami/minio/bin/minio', 'server', '/data', '--address', ':9000'], [envRef('MINIO_ROOT_USER', 'fixture-creds', 'access'), envRef('MINIO_ROOT_PASSWORD', 'fixture-creds', 'password')], { readinessProbe: { httpGet: { path: '/minio/health/ready', port: 9000 } } });
  bucket.spec.template.spec.securityContext = { runAsUser: 0 };
  bucket.spec.template.spec.containers[0].volumeMounts = [{ name: 'data', mountPath: '/data' }];
  bucket.spec.template.spec.volumes = [{ name: 'data', emptyDir: {} }];
  const registry = externalDeployment('registry', images.registry, ['/entrypoint.sh', '/etc/docker/registry/config.yml']);
  const traefik = externalDeployment('traefik', images.traefik, ['/entrypoint.sh', '--providers.kubernetesingress=true', `--providers.kubernetesingress.namespaces=${namespace}`, '--providers.kubernetesingress.ingressclass=smrt-exercise', '--entrypoints.web.address=:8080']);
  traefik.spec.template.spec.serviceAccountName = 'traefik';
  apply([
    secret('fixture-creds', { pgpassword: 'isolated-fixture-password', access: 'fixture-access', password: 'isolated-bucket-password' }, fixtures),
    pg, service('postgres', 5432), bucket, service('bucket', 9000), registry, service('registry', 5000),
    resource('v1', 'ServiceAccount', 'traefik', {}),
    resource('v1', 'ServiceAccount', 'exercise-reconciler', {}, namespace),
    resource('v1', 'ServiceAccount', 'exercise-observer', { automountServiceAccountToken: false }, namespace),
    resource('rbac.authorization.k8s.io/v1', 'Role', 'exercise-observer', { rules: [
      { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
      { apiGroups: [''], resources: ['configmaps'], resourceNames: ['exercise-maintenance'], verbs: ['get'] },
      { apiGroups: ['apps'], resources: ['deployments', 'replicasets', 'statefulsets', 'daemonsets'], verbs: ['get', 'list'] },
      { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: ['get', 'list'] },
      { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: ['get', 'list'] },
    ] }, namespace),
    resource('rbac.authorization.k8s.io/v1', 'RoleBinding', 'exercise-observer', { roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'exercise-observer' }, subjects: [{ kind: 'ServiceAccount', name: 'exercise-observer', namespace }] }, namespace),
    resource('v1', 'ServiceAccount', 'denied-reconciler', {}, namespace),
    resource('rbac.authorization.k8s.io/v1', 'Role', 'denied-reconciler', { rules: [
      { apiGroups: [''], resources: ['secrets', 'configmaps', 'services'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list', 'watch'] },
    ] }, namespace),
    resource('rbac.authorization.k8s.io/v1', 'RoleBinding', 'denied-reconciler', { roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'denied-reconciler' }, subjects: [{ kind: 'ServiceAccount', name: 'denied-reconciler', namespace }] }, namespace),
    resource('rbac.authorization.k8s.io/v1', 'Role', 'exercise-reconciler', { rules: [
      { apiGroups: [''], resources: ['secrets', 'configmaps', 'services'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: [''], resources: ['pods'], verbs: ['create'] },
      { apiGroups: [''], resources: ['pods', 'endpoints', 'serviceaccounts'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['apps'], resources: ['replicasets'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'] },
      { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list', 'watch'] },
    ] }, namespace),
    resource('rbac.authorization.k8s.io/v1', 'RoleBinding', 'exercise-reconciler', { roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'exercise-reconciler' }, subjects: [{ kind: 'ServiceAccount', name: 'exercise-reconciler', namespace }] }, namespace),
    resource('rbac.authorization.k8s.io/v1', 'Role', 'traefik', { rules: [
      { apiGroups: [''], resources: ['services', 'endpoints', 'secrets'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list', 'watch'] },
      { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['get', 'list', 'watch'] },
    ] }, namespace),
    resource('rbac.authorization.k8s.io/v1', 'RoleBinding', 'traefik', { roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'traefik' }, subjects: [{ kind: 'ServiceAccount', name: 'traefik', namespace: fixtures }] }, namespace),
    traefik, service('traefik', 8080),
    secret('runtime-v1', credentials), secret('migration-v1', { ...credentials, pguser: 'migrator', pgpassword: 'isolated-migration-password' }),
    secret('bucket-v1', { endpoint: `http://bucket.${fixtures}.svc.cluster.local:9000`, access: 'fixture-access', password: 'isolated-bucket-password' }),
  ]);
  for (const [kind, body] of [
    ['ClusterRole', { rules: [{ apiGroups: ['networking.k8s.io'], resources: ['ingressclasses'], verbs: ['get', 'list', 'watch'] }, { apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list', 'watch'] }] }],
    ['ClusterRoleBinding', { roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: clusterName }, subjects: [{ kind: 'ServiceAccount', name: 'traefik', namespace: fixtures }] }],
    ['IngressClass', { spec: { controller: 'traefik.io/ingress-controller' } }],
  ]) {
    ownedClusterResources.push(kind.toLowerCase());
    apply([{ apiVersion: kind === 'IngressClass' ? 'networking.k8s.io/v1' : 'rbac.authorization.k8s.io/v1', kind, metadata: { name: clusterName }, ...body }]);
  }
  // The values class equals the actual IngressClass, avoiding implicit defaults.
  values.ingress.className = clusterName;
  // Match the explicit class in the fixture controller too.
  k(['-n', fixtures, 'patch', 'deployment', 'traefik', '--type=json', '-p', JSON.stringify([{ op: 'replace', path: '/spec/template/spec/containers/0/command/3', value: `--providers.kubernetesingress.ingressclass=${clusterName}` }])]);
  for (const name of ['postgres', 'bucket', 'registry', 'traefik']) k(['-n', fixtures, 'rollout', 'status', `deployment/${name}`, '--timeout=180s']);
  sql("CREATE TABLE sentinel(value text PRIMARY KEY); INSERT INTO sentinel VALUES ('preserve'); CREATE TABLE writer_ticks(created_at timestamptz DEFAULT now()); CREATE TABLE phase_ledger(id text PRIMARY KEY); CREATE TABLE effects(id text PRIMARY KEY); CREATE ROLE runtime LOGIN PASSWORD 'isolated-runtime-password'; GRANT CONNECT ON DATABASE fixture TO runtime; GRANT USAGE ON SCHEMA public TO runtime; GRANT INSERT ON writer_ticks TO runtime; GRANT SELECT ON sentinel TO runtime; CREATE ROLE migrator LOGIN PASSWORD 'isolated-migration-password'; GRANT pg_read_all_stats TO migrator; GRANT CONNECT ON DATABASE fixture TO migrator; GRANT USAGE ON SCHEMA public TO migrator; GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO migrator;");
  assert.equal(sql("SELECT NOT rolsuper FROM pg_roles WHERE rolname='runtime'"), 't', 'runtime role is not an administrator');
  assert.equal(sql("SELECT has_table_privilege('runtime','writer_ticks','INSERT') AND has_table_privilege('runtime','sentinel','SELECT') AND NOT has_schema_privilege('runtime','public','CREATE') AND NOT has_table_privilege('runtime','phase_ledger','INSERT')"), 't', 'runtime grants are limited to runtime data operations');
  for (const forbidden of ["CREATE TABLE forbidden_runtime_ddl(id text)", "INSERT INTO phase_ledger VALUES ('forbidden-runtime-marker')"]) {
    assert.throws(() => k(['-n', fixtures, 'exec', 'deployment/postgres', '--', 'psql', '-U', 'runtime', '-d', 'fixture', '-v', 'ON_ERROR_STOP=1', '-Atc', forbidden]), (error) => /permission denied/i.test(String(error.stderr || error.message)), 'actual runtime role cannot execute migration operations');
  }
  note('actual runtime PostgreSQL role is non-admin and denied schema/phase-ledger writes');
  const bucketEndpoint = await forward('bucket', 9000);
  assert.equal((await s3(bucketEndpoint, 'PUT', '/assets')).status, 200);
  assert.equal((await s3(bucketEndpoint, 'PUT', '/assets/sentinel', 'preserve-object')).status, 200);
  const endpoint = await forward('traefik', 8080);
  const registryEndpoint = await forward('registry', 5000);
  execFileSync(helm, ['push', join(scratch, 'smrt-app-0.2.1.tgz'), `oci://${new URL(registryEndpoint).host}/charts`, '--plain-http'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // Helm may write the receipt to stderr; inspect the registry manifest itself
  // to bind the OCIRepository to the exact published artifact digest.
  const receipt = await fetch(`${registryEndpoint}/v2/charts/smrt-app/manifests/0.2.1`, { headers: { Accept: 'application/vnd.oci.image.manifest.v1+json' } });
  assert.equal(receipt.status, 200, 'published chart manifest exists');
  const chartDigest = receipt.headers.get('docker-content-digest');
  assert.match(chartDigest, /^sha256:[a-f0-9]{64}$/);
  note(`published isolated chart ${chartDigest}`);
  const collision = resource('v1', 'ConfigMap', 'exercise-inventory', { data: { fixture: 'foreign-release' } }, namespace);
  apply([collision]);
  assert.throws(() => existingOwnedResource(collision), /Helm release ownership mismatch/, 'foreign non-workload collision fails before initial maintenance');
  assert.equal(k(['-n', namespace, 'get', 'deployment', 'exercise-maintenance', '--ignore-not-found']).trim(), '');
  k(['-n', namespace, 'delete', 'configmap', 'exercise-inventory', '--wait=true']);
  note('foreign ConfigMap ownership collision rejected before initial maintenance');
  apply([
    resource('source.toolkit.fluxcd.io/v1', 'OCIRepository', 'exercise', { spec: { interval: '10s', url: `oci://registry.${fixtures}.svc.cluster.local:5000/charts/smrt-app`, insecure: true, ref: { digest: chartDigest }, layerSelector: { mediaType: 'application/vnd.cncf.helm.chart.content.v1.tar+gzip', operation: 'copy' } } }, namespace),
    resource('helm.toolkit.fluxcd.io/v2', 'HelmRelease', 'exercise', { spec: { interval: '10s', releaseName: 'exercise', timeout: '120s', serviceAccountName: 'exercise-reconciler', driftDetection: { mode: 'enabled' },
      chartRef: { kind: 'OCIRepository', name: 'exercise' },
      install: { strategy: { name: 'RetryOnFailure', retryInterval: '5s' }, disableWaitForJobs: false },
      upgrade: { strategy: { name: 'RetryOnFailure', retryInterval: '5s' }, disableWaitForJobs: false }, values,
    } }, namespace),
  ]);
  await until('Flux acknowledges bootstrap maintenance sequence zero', () => {
    const hr = get('helmrelease', 'exercise');
    return hr.status?.observedGeneration === hr.metadata.generation && hr.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True' && c.observedGeneration === hr.metadata.generation)
      && get('ingress', 'exercise').metadata.labels['smrt.happyvertical.com/sequence'] === '0';
  });
  await http(endpoint, 503, 'Maintenance', true);
  assert.equal(k(['-n', namespace, 'get', 'deployment', 'exercise-web', '--ignore-not-found']).trim(), '');
  await reconcile('stopped'); await stopped();
  await reconcile('migrate');
  await until('bootstrap validation Job completes', () => get('job', 'exercise-migration-bootstrap-001-1').status?.succeeded === 1);
  const bootstrapPods = JSON.parse(k(['-n', namespace, 'get', 'pods', '-l', 'job-name=exercise-migration-bootstrap-001-1', '-o', 'json'])).items;
  assert.equal(bootstrapPods.length, 1);
  const observerPod = bootstrapPods[0];
  const observerLog = migrationLogs('exercise-migration-bootstrap-001-1');
  assert.ok(observerLog.includes(`observer-pod-name:${observerPod.metadata.name}`));
  assert.ok(observerLog.includes(`observer-pod-uid:${observerPod.metadata.uid}`), 'actual projected Pod UID matches Kubernetes identity');
  assert.equal(observerPod.spec.serviceAccountName, 'exercise-observer');
  assert.equal(observerPod.spec.automountServiceAccountToken, false);
  assert.equal(k(['-n', namespace, '--as', `system:serviceaccount:${namespace}:exercise-observer`, 'auth', 'can-i', 'list', 'pods']).trim(), 'yes');
  assert.throws(() => k(['-n', namespace, '--as', `system:serviceaccount:${namespace}:denied-reconciler`, 'auth', 'can-i', 'list', 'pods']), (error) => String(error.stdout).trim() === 'no', 'observer without Pod-list RBAC fails closed');
  assert.throws(() => get('serviceaccount', 'missing-observer'), 'absent observer SA is not silently accepted');
  await reconcile('verify');
  await http(endpoint, 503, 'Maintenance', true);
  await reconcile('active');
  await http(endpoint, 200, 'old-release');
  await until('old writer inserts data', () => Number(sql('SELECT count(*) FROM writer_ticks')) > 0);
  for (const name of ['web', 'writer']) {
    const spec = get('deployment', `exercise-${name}`).spec.template.spec;
    assert.equal(spec.automountServiceAccountToken, false);
    assert.equal(spec.volumes.some((volume) => volume.projected), false, 'runtime does not receive API credentials');
    const runtimePods = JSON.parse(k(['-n', namespace, 'get', 'pods', '-l', `app.kubernetes.io/instance=exercise,smrt.happyvertical.com/workload=${name}`, '-o', 'json'])).items;
    assert.equal(runtimePods.length, 1);
    for (const pod of runtimePods) assert.equal(pod.spec.volumes.some((volume) => volume.projected), false);
  }
  note('old runtime serving, database and S3 sentinel objects present');
  const oldRuntime = structuredClone(bootstrapRuntime);
  await dryRunAllPhases({ ...values, current: oldRuntime, target: runtime('new', true), release: { ...values.release, id: 'exercise-001', attempt: 1, sequence: sequence + 1 } });
  await reconcile('maintenance', { release: { id: 'exercise-001', attempt: 1 }, current: oldRuntime, target: runtime('new', true) });
  await http(endpoint, 503, 'Maintenance', true);
  assert.equal(get('deployment', 'exercise-web').spec.template.spec.containers[0].image, images.nginxOld);
  await reconcile('stopped');
  await http(endpoint, 503, 'Maintenance', true);
  await stopped();
  // Deliberate isolated fault injection, never used by the release runner.
  const drift = JSON.parse(k(['-n', namespace, 'patch', 'deployment', 'exercise-writer', '--type=merge', '--field-manager=exercise-drift-injection', '-p', JSON.stringify({ spec: { replicas: 1 } }), '-o', 'json']));
  assert.equal(drift.spec.replicas, 1, 'test-only writer replica drift was injected');
  await until('Flux corrects stopped writer replica drift', () => get('deployment', 'exercise-writer').spec.replicas === 0);
  await stopped();
  await http(endpoint, 503, 'Maintenance', true);
  note('Flux drift detection restored stopped replicas to zero; no active writer Pod persists before migration');
  assert.equal(sql("SELECT has_schema_privilege('migrator','public','USAGE') AND has_table_privilege('migrator','phase_ledger','INSERT,SELECT') AND has_table_privilege('migrator','effects','INSERT,SELECT') AND pg_has_role('migrator','pg_read_all_stats','MEMBER')"), 't', 'migration role has the explicit fixture guard/transaction privileges');
  await reconcile('migrate', {}, { expectedMigrationFailure: true });
  await stopped();
  await http(endpoint, 503, 'Maintenance', true);
  await until('migration attempt 1 fails visibly', () => get('job', 'exercise-migration-exercise-001-1').status?.failed === 1);
  const failedMigrationLog = migrationLogs('exercise-migration-exercise-001-1');
  assert.match(failedMigrationLog, /intentional-failure-after-commit/, `migration must reach the committed-step checkpoint before its intended failure; bounded sanitized log:\n${failedMigrationLog}`);
  const failedMigrationPods = JSON.parse(k(['-n', namespace, 'get', 'pods', '-l', 'job-name=exercise-migration-exercise-001-1', '-o', 'json'])).items;
  assert.ok(failedMigrationPods.some((pod) => pod.status.containerStatuses?.some((container) => container.state?.terminated?.exitCode === 23)), 'expected fixture failure exit code 23 after commit');
  assert.equal(sql('SELECT count(*) FROM effects'), '1', `committed effect must persist after intentional failure; bounded sanitized log:\n${failedMigrationLog}`);
  assert.equal(sql('SELECT count(*) FROM phase_ledger'), '1');
  await stopped();
  await http(endpoint, 503, 'Maintenance', true);
  assert.equal(get('deployment', 'exercise-web').spec.replicas, 0, 'no automatic rollback restores writer');
  note('failed migration retained after committed step; traffic/writers remain stopped');
  const failedDocument = get('helmrelease', 'exercise');
  const failedJob = get('job', 'exercise-migration-exercise-001-1');
  const failedPod = failedMigrationPods.find((pod) => pod.status.containerStatuses?.some((container) => container.state?.terminated?.exitCode === 23));
  assert.equal(failedPod.spec.containers[0].image, values.target.migration.image);
  const bindingIdentity = () => releaseHash(['runtime-v1', 'migration-v1', 'bucket-v1'].map((name) => {
    const binding = get('secret', name);
    return { name, uid: binding.metadata.uid, resourceVersion: binding.metadata.resourceVersion, immutable: binding.immutable };
  }));
  const stoppedProof = (document) => ({ identity: identity(document), accepted: true, proven: true,
    revision: `fixture-HelmRelease:${document.metadata.uid}:${document.metadata.resourceVersion}`, bindings: bindingIdentity() });
  // These facts were observed above against this isolated HR/Job/Pod. The pure
  // shared reducers run here; this is not Git/CI/Kustomization attestation.
  const failureProof = { ...stoppedProof(failedDocument), failedMigration: {
    name: failedJob.metadata.name, jobUid: failedJob.metadata.uid, jobSpecIdentity: releaseHash(failedJob.spec),
    podUid: failedPod.metadata.uid, releaseId: values.release.id, attempt: values.release.attempt,
    targetIdentity: releaseHash(values.target), image: values.target.migration.image,
  } };
  const publishReduced = async (document) => {
    assert.equal(document.spec.values.release.sequence, sequence + 1, 'shared reducer increments exactly one acknowledged phase');
    const annotations = Object.fromEntries(Object.entries(document.metadata.annotations ?? {}).filter(([key]) => key.startsWith('smrt.happyvertical.com/')));
    await reconcile(document.spec.values.release.phase, document.spec.values, { annotations });
    assert.equal(identity(get('helmrelease', 'exercise')), identity(document), 'Flux acknowledged exact reducer output');
  };
  await publishReduced(transition(failedDocument, failureProof, true));
  await stopped(); await http(endpoint, 503, 'Maintenance', true);
  const stoppedDocument = get('helmrelease', 'exercise');
  assert.equal(get('job', failedJob.metadata.name).metadata.uid, failedJob.metadata.uid, 'recovery retains exact failed Job');
  assert.equal(releaseHash(get('job', failedJob.metadata.name).spec), releaseHash(failedJob.spec), 'recovery preserves failed Job spec');
  assert.throws(() => transition(stoppedDocument, stoppedProof(stoppedDocument)), /explicit reviewed repair/, 'normal stopped transition cannot retry the failed attempt');
  const inspection = { markers: sql("SELECT string_agg(id, ',' ORDER BY id) FROM phase_ledger"), effects: Number(sql('SELECT count(*) FROM effects')), failedJobUid: failedJob.metadata.uid };
  assert.deepEqual(inspection, { markers: 'committed-step', effects: 1, failedJobUid: failedJob.metadata.uid });
  const repairedDocument = repairRelease(stoppedDocument, stoppedDocument.spec.values.target, stoppedProof(stoppedDocument));
  const fixtureRecoveryReceipt = { recovery: { predecessor: JSON.parse(repairedDocument.metadata.annotations['smrt.happyvertical.com/repair-predecessor']),
    targetIdentity: releaseHash(repairedDocument.spec.values.target), ledgerState: 'reconciled', ledgerEvidenceIdentity: releaseHash(inspection) } };
  validateRepairEvidence(repairedDocument, fixtureRecoveryReceipt);
  await publishReduced(repairedDocument);
  await stopped(); await http(endpoint, 503, 'Maintenance', true);
  assert.equal(k(['-n', namespace, 'get', 'job', 'exercise-migration-exercise-001-2', '--ignore-not-found']).trim(), '', 'acknowledged repair remains stopped before migration');
  note(`shared recover/repair reducers acknowledged separately; actual ledger inspection identity ${releaseHash(inspection)} (fixture receipt only)`);
  const repairedStopped = get('helmrelease', 'exercise');
  await publishReduced(transition(repairedStopped, stoppedProof(repairedStopped)));
  await until('explicit repair attempt completes', () => get('job', 'exercise-migration-exercise-001-2').status?.succeeded === 1);
  assert.equal(sql('SELECT count(*) FROM effects'), '1', 'committed effect not repeated');
  assert.equal(sql('SELECT count(*) FROM phase_ledger'), '2');
  await reconcile('verify');
  await http(endpoint, 503, 'Maintenance', true);
  const appForward = spawn(kubectl, ['--kubeconfig', resolve(kubeconfig), '-n', namespace, 'port-forward', 'service/exercise-web', ':8080', '--address=127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(appForward);
  let appOutput = ''; appForward.stdout.on('data', (chunk) => { appOutput += chunk; });
  await until('target service forward', () => /127\.0\.0\.1:(\d+)/.test(appOutput));
  const appEndpoint = `http://127.0.0.1:${appOutput.match(/127\.0\.0\.1:(\d+)/)[1]}`;
  assert.equal((await fetch(appEndpoint)).status, 500, 'alive and ready HTTP500 must fail application verification');
  assert.equal(values.release.phase, 'verify', 'HTTP500 does not promote active');
  const live = JSON.parse(k(['-n', namespace, 'get', 'deployments,replicasets,pods,cronjobs,endpointslices', '-o', 'json'])).items;
  const document = get('helmrelease', 'exercise');
  await verifyRuntime(document, live);
  const wrongIdentity = structuredClone(document);
  wrongIdentity.spec.values.target.workloads.web.image = images.nginxOld;
  await assert.rejects(() => verifyRuntime(wrongIdentity, live), /imageID mismatch/, 'real runtime verifier rejects wrong declared digest');
  note('target readiness passes but HTTP500 verification rejects activation');
  appForward.kill();
  const verificationFailure = { ...stoppedProof(document), proven: false, failureCode: 'HTTP_ASSERTION' };
  await publishReduced(transition(document, verificationFailure, true));
  await stopped(); await http(endpoint, 503, 'Maintenance', true);
  const runtimeStoppedDocument = get('helmrelease', 'exercise');
  assert.throws(() => transition(runtimeStoppedDocument, stoppedProof(runtimeStoppedDocument)), /explicit reviewed repair/, 'runtime verification failure requires explicit repair');
  const runtimeInspection = { markers: sql("SELECT string_agg(id, ',' ORDER BY id) FROM phase_ledger"), effects: Number(sql('SELECT count(*) FROM effects')), successfulJobUid: get('job', 'exercise-migration-exercise-001-2').metadata.uid };
  assert.equal(runtimeInspection.markers, 'committed-step,repair-step');
  assert.equal(runtimeInspection.effects, 1);
  const correctedDocument = repairRelease(runtimeStoppedDocument, runtime('new'), stoppedProof(runtimeStoppedDocument));
  validateRepairEvidence(correctedDocument, { recovery: {
    predecessor: JSON.parse(correctedDocument.metadata.annotations['smrt.happyvertical.com/repair-predecessor']),
    targetIdentity: releaseHash(correctedDocument.spec.values.target), ledgerState: 'reconciled', ledgerEvidenceIdentity: releaseHash(runtimeInspection),
  } });
  await publishReduced(correctedDocument);
  await stopped(); await http(endpoint, 503, 'Maintenance', true);
  assert.equal(values.release.attempt, 3);
  assert.equal(k(['-n', namespace, 'get', 'job', 'exercise-migration-exercise-001-3', '--ignore-not-found']).trim(), '', 'runtime repair is acknowledged stopped before migration attempt 3');
  const correctedStopped = get('helmrelease', 'exercise');
  await publishReduced(transition(correctedStopped, stoppedProof(correctedStopped)));
  await until('runtime repair migration attempt 3 completes', () => get('job', 'exercise-migration-exercise-001-3').status?.succeeded === 1);
  assert.equal(sql('SELECT count(*) FROM effects'), '1', 'runtime repair migration preserves committed effect');
  assert.equal(sql('SELECT count(*) FROM phase_ledger'), '2', 'runtime repair rechecks completed durable steps');
  const migratedThirdAttempt = get('helmrelease', 'exercise');
  await publishReduced(transition(migratedThirdAttempt, stoppedProof(migratedThirdAttempt)));
  await http(endpoint, 503, 'Maintenance', true);
  await verifyRuntime(get('helmrelease', 'exercise'), JSON.parse(k(['-n', namespace, 'get', 'deployments,replicasets,pods,cronjobs,endpointslices', '-o', 'json'])).items);
  const correctedPrivate = await forward('exercise-web', 8080, namespace);
  const correctedHttp = await fetch(correctedPrivate);
  assert.equal(correctedHttp.status, 200, 'corrected target private verification passes before activation');
  assert.equal(await correctedHttp.text(), 'new-release');
  const verifiedThirdAttempt = get('helmrelease', 'exercise');
  await publishReduced(transition(verifiedThirdAttempt, stoppedProof(verifiedThirdAttempt)));
  await http(endpoint, 200, 'new-release');
  note('HTTP500 recovery used shared stopped repair attempt 3, normal migrate/verify/active and reconciled ledger evidence');
  const newPods = JSON.parse(k(['-n', namespace, 'get', 'pods', '-l', 'smrt.happyvertical.com/workload=web', '-o', 'json'])).items;
  assert.ok(newPods.length > 0 && newPods.every((pod) => pod.status.containerStatuses?.every((c) => c.ready && c.imageID.includes('sha256:'))));
  assert.equal(sql("SELECT value FROM sentinel"), 'preserve');
  assert.equal(await (await s3(bucketEndpoint, 'GET', '/assets/sentinel')).text(), 'preserve-object');
  k(['-n', namespace, 'delete', 'helmrelease', 'exercise', '--wait=true', '--timeout=120s']);
  await until('Helm uninstall removed runtime', () => k(['-n', namespace, 'get', 'deployment', 'exercise-web', '--ignore-not-found']).trim() === '');
  assert.equal(sql('SELECT value FROM sentinel'), 'preserve');
  assert.equal(await (await s3(bucketEndpoint, 'GET', '/assets/sentinel')).text(), 'preserve-object');
  assert.equal(get('secret', 'runtime-v1').immutable, true);
  assert.equal(get('job', 'exercise-migration-exercise-001-1').status.failed, 1);
  assert.equal(get('job', 'exercise-migration-exercise-001-2').status.succeeded, 1);
  assert.equal(get('job', 'exercise-migration-exercise-001-3').status.succeeded, 1);
  note('PASS: Flux phases, actual Ingress503, stopped writers, retained failed/success Jobs, explicit resume, HTTP500 rejection, new serving image and external DB/S3 retention after uninstall');
  note('LIMITS: synthetic isolated applications; test-only HelmRelease patches do not prove protected Git/CAS orchestration, downstream wrappers, production fencing or downstream adoption');
} catch (error) {
  diagnose();
  throw error;
} finally {
  for (const child of children) child.kill();
  for (const ns of ownedNamespaces.reverse()) {
    try { k(['delete', 'namespace', ns, '--wait=true', '--timeout=120s']); } catch { process.exitCode = 1; console.error(`Cleanup required: namespace/${ns}`); }
  }
  for (const kind of ownedClusterResources.reverse()) {
    try { k(['delete', kind, clusterName, '--wait=true', '--timeout=30s']); } catch { process.exitCode = 1; console.error(`Cleanup required: ${kind}/${clusterName}`); }
  }
  rmSync(scratch, { recursive: true, force: true });
}
