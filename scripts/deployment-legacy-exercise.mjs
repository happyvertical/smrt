/** Real disposable legacy Git/Flux adoption exercise. No simulated adapter proofs.
 * Authoring imports are inert. Execution requires explicit isolated Kind opt-in.
 * See docs/deployment-legacy-exercise.md for provenance and remaining limitations.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main as releaseCli } from './deployment/cli.mjs';
import { adoptOrResume, planAdoption } from './deployment/adopt.mjs';
import { createLiveAdapter, run } from './deployment/live.mjs';
import { hash } from './deployment/release.mjs';

export const legacyArtifacts = Object.freeze({
  node: 'kindest/node:v1.34.3@sha256:08497ee19eace7b4b5348db5c6a1591d7752b164530a36f855cb0f2bdcbadd48',
  flux: {
    url: 'https://github.com/fluxcd/flux2/releases/download/v2.8.8/install.yaml',
    sha256: 'cc23846dc86bec37c060d860c1188447e896a93fa1d9e1e3aca4e25726c1ae61',
  },
  unsupportedFlux: {
    url: 'https://github.com/fluxcd/flux2/releases/download/v2.6.4/install.yaml',
    sha256: '7cd043a823666727b4b9de408346148b28741b47eb0b3e4237ab7259d4ad3ab8',
  },
  kubectl: {
    url: 'https://dl.k8s.io/release/v1.34.3/bin/linux/amd64/kubectl',
    sha256: 'ab60ca5f0fd60c1eb81b52909e67060e3ba0bd27e55a8ac147cbc2172ff14212',
  },
  cilium: {
    url: 'https://helm.cilium.io/cilium-1.20.4.tgz',
    sha256: '505abff8385811df1a949776fc42e9f10697989a332acc86d6e8933efcb855ed',
  },
  ingress: {
    url: 'https://github.com/kubernetes/ingress-nginx/releases/download/helm-chart-4.11.3/ingress-nginx-4.11.3.tgz',
    sha256: 'a9f371489a6c18042508c0b5c2ea669deaad7ccc08f37efc4522e336edda1c20',
  },
});
export const legacyImages = Object.freeze({
  node: 'docker.io/library/node@sha256:5feabe6cffeab0160ea9c8a29dd9f0bbf26b1028bbe40ed6dd80dbdfb5d99aa4',
  nginx:
    'docker.io/library/nginx@sha256:09ab424a8c788f8d0fe3a64429f6d19dfa526885c8609b748d0943a75dcb9f8c',
  postgres:
    'docker.io/library/postgres@sha256:0ae695e3d11c7cc82cbed8f3e506233f18cdd40e3fc7622893f6a4d0772a5a09',
  registry:
    'docker.io/library/registry@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278',
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const hasStaticCredentialName = (name) =>
  /^(PG[A-Z0-9_]*|AWS_[A-Z0-9_]*|DATABASE[A-Z0-9_]*|DB_(PASSWORD|TOKEN|URL)|KUBECONFIG|KUBE(RNETES)?_TOKEN)$/.test(
    name,
  );
export function requireLegacyOptIn(env) {
  assert.equal(
    env.SMRT_LEGACY_DEPLOYMENT_EXERCISE,
    '1',
    'explicit legacy exercise opt-in required',
  );
  assert.ok(
    env.KUBECONFIG &&
      !env.KUBECONFIG.includes(':') &&
      env.KUBECONFIG.startsWith('/'),
    'one absolute isolated kubeconfig required',
  );
  assert.ok(
    env.RUNNER_TEMP &&
      resolve(env.KUBECONFIG).startsWith(`${resolve(env.RUNNER_TEMP)}/`),
    'kubeconfig must be inside disposable RUNNER_TEMP',
  );
}
// git http-backend speaks smart upload-pack, not a directory/file approximation.
export const smartGitServer = `const http=require('node:http'),{spawn}=require('node:child_process');
http.createServer((req,res)=>{const url=new URL(req.url,'http://fixture');
if(!/^\\/repo.git(?:\\/|$)/.test(url.pathname)||req.method!=='GET'&&req.method!=='POST'){res.writeHead(404);res.end();return;}
const child=spawn('git',['-c','safe.directory=*','http-backend'],{env:{...process.env,GIT_PROJECT_ROOT:process.env.SMRT_GIT_PROJECT_ROOT||'/git',GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,REQUEST_METHOD:req.method,QUERY_STRING:url.search.slice(1),CONTENT_TYPE:req.headers['content-type']||'',CONTENT_LENGTH:req.headers['content-length']||'',REMOTE_ADDR:'127.0.0.1'},stdio:['pipe','pipe','pipe']});
let pending=Buffer.alloc(0),started=false;child.stdout.on('data',chunk=>{if(started){res.write(chunk);return;}pending=Buffer.concat([pending,chunk]);let at=pending.indexOf('\\r\\n\\r\\n'),sep=4;if(at<0){at=pending.indexOf('\\n\\n');sep=2;}if(at<0)return;
let status=200;const headers={};for(const line of pending.subarray(0,at).toString().split(/\\r?\\n/)){const i=line.indexOf(':');if(i<0)continue;const k=line.slice(0,i),v=line.slice(i+1).trim();if(k.toLowerCase()==='status')status=Number(v.split(' ')[0]);else headers[k]=v;}res.writeHead(status,headers);started=true;res.write(pending.subarray(at+sep));});child.on('close',code=>{if(!started)res.writeHead(code?500:200);res.end();});child.on('error',()=>{res.writeHead(500);res.end();});child.stderr.resume();req.pipe(child.stdin);}).listen(Number(process.env.SMRT_GIT_PORT||8080),'0.0.0.0',function(){console.log('smart-git-port:'+this.address().port)});`;

export const fixtureMigration = `set -eu
printf '%s' "$PGSSLROOTCERT_PEM" > /tmp/pg-ca.crt
export PGSSLROOTCERT=/tmp/pg-ca.crt
psql -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_advisory_lock(4481);
DO $guard$ BEGIN
IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='legacy' AND rolcanlogin) THEN RAISE EXCEPTION 'legacy credential fence absent'; END IF;
IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename IN ('legacy','runtime','migration') AND pid <> pg_backend_pid()) THEN RAISE EXCEPTION 'legacy session remains'; END IF;
END $guard$;
BEGIN;
CREATE TABLE IF NOT EXISTS fixture_phases (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS fixture_effects (id text PRIMARY KEY);
INSERT INTO fixture_phases VALUES ('legacy-adoption') ON CONFLICT DO NOTHING;
INSERT INTO fixture_effects VALUES ('exactly-once') ON CONFLICT DO NOTHING;
COMMIT;
SQL`;
const resources = {
  requests: { cpu: '10m', memory: '24Mi' },
  limits: { cpu: '200m', memory: '192Mi' },
};
const hardening = {
  podSecurityContext: {
    runAsNonRoot: true,
    runAsUser: 10001,
    runAsGroup: 10001,
    fsGroup: 10001,
    seccompProfile: { type: 'RuntimeDefault' },
  },
  securityContext: {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  },
  scratch: [{ name: 'tmp', mountPath: '/tmp', sizeLimit: '16Mi' }],
  nodeSelector: { 'kubernetes.io/arch': 'amd64' },
};
export function legacyRuntime(configHash, fixtureNamespace) {
  const ref = (name, secret) => ({
    name,
    valueFrom: { secretKeyRef: { name: secret, key: name.toLowerCase() } },
  });
  const common = {
    image: legacyImages.postgres,
    command: [
      'sh',
      '-c',
      `set -eu; printf '%s' "$PGSSLROOTCERT_PEM" > /tmp/pg-ca.crt; export PGSSLROOTCERT=/tmp/pg-ca.crt; trap "exit 0" TERM INT; while :; do psql -v ON_ERROR_STOP=1 -c "INSERT INTO writer_ticks DEFAULT VALUES"; sleep 1 & wait $!; done`,
    ],
    env: [],
    replicas: 1,
    resources,
    readinessProbe: { exec: { command: ['sh', '-c', 'test -d /tmp'] } },
    terminationGracePeriodSeconds: 5,
    ...structuredClone(hardening),
  };
  const web = {
    ...structuredClone(common),
    role: 'web',
    writer: true,
    image: legacyImages.nginx,
    port: 8080,
    service: { port: 8080 },
    selectorLabels: { app: 'legacy-web' },
    command: [
      'sh',
      '-c',
      `printf 'pid /tmp/nginx.pid; error_log stderr; events {} http { access_log off; client_body_temp_path /tmp/client; proxy_temp_path /tmp/proxy; fastcgi_temp_path /tmp/fastcgi; uwsgi_temp_path /tmp/uwsgi; scgi_temp_path /tmp/scgi; server { listen 8080; location / { return 200 "application-ready"; } } }' >/tmp/nginx.conf; exec nginx -p /tmp -c /tmp/nginx.conf -g 'daemon off;'`,
    ],
    readinessProbe: { httpGet: { path: '/', port: 8080 } },
  };
  const site = {
    ...structuredClone(web),
    role: 'service',
    writer: false,
    selectorLabels: { app: 'legacy-site' },
    continuousStatic: true,
    automountServiceAccountToken: false,
    command: [
      'sh',
      '-c',
      `printf 'pid /tmp/nginx.pid; error_log stderr; events {} http { access_log off; client_body_temp_path /tmp/client; server { listen 8080; root /srv/site; location / { try_files $uri /index.html; } } }' >/tmp/nginx.conf; exec nginx -p /tmp -c /tmp/nginx.conf -g 'daemon off;'`,
    ],
    readOnlyConfigMaps: [
      {
        volumeName: 'public-content',
        configMapName: 'public-v1',
        hash: configHash,
        mountPath: '/srv/site',
        items: [
          { key: 'index.html', path: 'index.html' },
          { key: 'legal.html', path: 'legal.html' },
        ],
      },
    ],
  };
  const workloads = {
    web,
    task: {
      ...structuredClone(common),
      role: 'task',
      writer: true,
      selectorLabels: { app: 'legacy-task' },
    },
    schedule: {
      ...structuredClone(common),
      role: 'schedule',
      writer: true,
      selectorLabels: { app: 'legacy-schedule' },
    },
    background: {
      ...structuredClone(common),
      role: 'background',
      writer: true,
      selectorLabels: { app: 'legacy-background' },
    },
    extractor: {
      ...structuredClone(common),
      role: 'task',
      writer: true,
      selectorLabels: { app: 'legacy-extractor' },
    },
    monitor: {
      ...structuredClone(common),
      role: 'service',
      writer: false,
      command: ['sh', '-c', 'test -d /tmp'],
      schedule: '0 0 1 1 *',
      startingDeadlineSeconds: 600,
      activeDeadlineSeconds: 3300,
      ttlSecondsAfterFinished: 86400,
      successfulJobsHistoryLimit: 2,
      failedJobsHistoryLimit: 3,
    },
    site,
  };
  // Ordinary writer pods use rotated named credentials; static has none.
  for (const w of Object.values(workloads).filter((w) => w.writer))
    w.env = [
      'PGHOST',
      'PGUSER',
      'PGDATABASE',
      'PGPASSWORD',
      'PGSSLMODE',
      'PGSSLROOTCERT_PEM',
    ].map((name) => ref(name, 'runtime-v2'));
  const migration = {
    ...structuredClone(hardening),
    image: legacyImages.postgres,
    command: ['sh', '-c', fixtureMigration],
    env: [
      'PGHOST',
      'PGUSER',
      'PGDATABASE',
      'PGPASSWORD',
      'PGSSLMODE',
      'PGSSLROOTCERT_PEM',
    ].map((name) => ref(name, 'migration-v1')),
    guard: 'smrt-release-v1',
    resources,
    terminationGracePeriodSeconds: 10,
  };
  return { workloads, migration };
}

export function assertRetryOnFailureSupport(documents) {
  const crd = documents.find(
    (o) =>
      o?.kind === 'CustomResourceDefinition' &&
      o.metadata.name === 'helmreleases.helm.toolkit.fluxcd.io',
  );
  const schema = crd?.spec.versions.find((v) => v.name === 'v2')?.schema
    .openAPIV3Schema.properties.spec.properties;
  for (const action of ['install', 'upgrade'])
    assert.ok(
      schema?.[action]?.properties?.strategy?.properties?.name?.enum?.includes(
        'RetryOnFailure',
      ),
      `${action}.strategy RetryOnFailure unsupported: platform controller upgrade required`,
    );
}

export function legacyAdmissionPolicy(namespace, allowedNames, commands) {
  const controllerActors = [
    'system:serviceaccount:kube-system:replicaset-controller',
    'system:serviceaccount:kube-system:job-controller',
    'system:kube-controller-manager',
  ];
  const reconciler = `system:serviceaccount:${namespace}:reconciler`;
  const actor = `(${JSON.stringify(controllerActors)}.exists(a,a == request.userInfo.username))`;
  const podSpec =
    "(request.resource.resource == 'pods' ? object.spec : (request.resource.resource == 'cronjobs' ? object.spec.jobTemplate.spec.template.spec : object.spec.template.spec))";
  const literalEnv = {
    SMRT_RELEASE_ID: 'adopt-4481',
    SMRT_RELEASE_ATTEMPT: '1',
    SMRT_APP_NAME: 'legacy',
    SMRT_APP_ENVIRONMENT: 'isolated',
  };
  const envCondition = Object.entries(literalEnv)
    .map(
      ([name, value]) =>
        `(e.name == ${JSON.stringify(name)} && has(e.value) && e.value == ${JSON.stringify(value)})`,
    )
    .join(' || ');
  const envelope = `[${podSpec}].all(s,s.containers.size() == 1 && (!has(s.initContainers) || s.initContainers.size() == 0) && has(s.automountServiceAccountToken) && s.automountServiceAccountToken == false && (!has(s.hostNetwork) || s.hostNetwork == false) && (!has(s.hostPID) || s.hostPID == false) && (!has(s.hostIPC) || s.hostIPC == false) && (!has(s.volumes) || s.volumes.all(v,(!has(v.secret) && !has(v.projected) && !has(v.hostPath)) && ((v.name == 'tmp' && has(v.emptyDir)) || (v.name == 'public-content' && has(v.configMap) && v.configMap.name == 'public-v1') || (v.name == 'config' && has(v.configMap) && v.configMap.name == 'legacy-maintenance')))) && s.containers.all(c,${JSON.stringify([legacyImages.nginx, legacyImages.postgres])}.exists(i,i == c.image) && ${JSON.stringify(commands)}.exists(command,command == c.command) && (!has(c.args) || c.args.size() == 0) && !has(c.envFrom) && (!has(c.env) || c.env.all(e,(${envCondition}) || (has(e.valueFrom) && has(e.valueFrom.secretKeyRef) && ['runtime-v2','migration-v1'].exists(n,n == e.valueFrom.secretKeyRef.name) && ['pghost','pguser','pgdatabase','pgpassword','pgsslmode','pgsslrootcert_pem'].exists(key,key == e.valueFrom.secretKeyRef.key))))))`;
  return {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: { name: 'smrt-legacy-fence' },
    spec: {
      failurePolicy: 'Fail',
      matchConstraints: {
        resourceRules: [
          {
            apiGroups: ['', 'apps', 'batch'],
            apiVersions: ['*'],
            operations: ['CREATE', 'UPDATE'],
            resources: ['pods', 'deployments', 'cronjobs', 'jobs'],
          },
        ],
      },
      validations: [
        {
          expression: `request.namespace != '${namespace}' || (request.resource.resource == 'pods' ? ((request.dryRun && request.userInfo.username == '${reconciler}') || (${actor} && has(object.metadata.ownerReferences) && object.metadata.ownerReferences.size() == 1)) : (request.userInfo.username == '${reconciler}' && (${JSON.stringify(allowedNames)}.exists(n,n == object.metadata.name) || (request.resource.resource == 'jobs' && object.metadata.name.startsWith('legacy-migration-')))))`,
          message: 'finite fixture workload/controller identities required',
        },
        {
          expression: `request.namespace != '${namespace}' || ${envelope}`,
          message:
            'exact fixture commands, bounded volumes and rotated named credentials required',
        },
      ],
    },
  };
}

export async function legacyMain(env = process.env) {
  requireLegacyOptIn(env);
  assert.equal(
    process.platform,
    'linux',
    'native fixture profile supports Linux x64 only',
  );
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v26.12.1');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const scratch = mkdtempSync(join(resolve(env.RUNNER_TEMP), 'smrt-legacy-'));
  const evidence = join(resolve(env.RUNNER_TEMP), 'smrt-legacy-evidence');
  mkdirSync(evidence, { recursive: true });
  const namespace = 'smrt-legacy-app',
    fixtures = 'smrt-legacy-platform',
    cluster = 'smrt-legacy-ci';
  const kubeconfig = resolve(env.KUBECONFIG),
    children = [];
  let created = false;
  const note = (message) => console.log(`[legacy-exercise] ${message}`);
  const sanitize = (output) => {
    let text = String(output ?? '').replace(
      /fixture-[a-z-]+-password/g,
      '[redacted]',
    );
    try {
      const o = JSON.parse(text);
      const scrub = (v) => {
        if (!v || typeof v !== 'object') return;
        if (v.kind === 'Secret') {
          v.data = '[redacted]';
          delete v.stringData;
        }
        if (Array.isArray(v.items)) v.items.forEach(scrub);
      };
      scrub(o);
      text = JSON.stringify(o);
    } catch {}
    return text;
  };
  const record = (binary, args, status, output) =>
    appendFileSync(
      join(evidence, 'tools.log'),
      `${JSON.stringify({ binary, args: sanitize(JSON.stringify(args)), status, output: sanitize(output) })}\n`,
    );
  const exec = (binary, args, input) => {
    const result = spawnSync(binary, args, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 240000,
      env: { ...env, KUBECONFIG: kubeconfig },
      maxBuffer: 16 * 1024 * 1024,
    });
    record(
      binary,
      args,
      result.status,
      `${sanitize(result.stdout)}\n${sanitize(result.stderr)}`,
    );
    if (result.error || result.status !== 0) {
      const error = new Error(
        `${binary} failed (${result.status ?? result.signal}): ${sanitize(result.stderr ?? result.error?.message).slice(0, 2000)}`,
      );
      error.status = result.status;
      error.stderr = result.stderr;
      error.stdout = result.stdout;
      throw error;
    }
    return result.stdout;
  };
  const nativeCommand = async (binary, args, input) => {
    try {
      const output = await run(binary, args, input);
      record(binary, args, 0, output);
      return output;
    } catch (error) {
      record(binary, args, 'failed', error.message);
      throw error;
    }
  };
  const k = (args, value) =>
    exec(
      'kubectl',
      ['--kubeconfig', kubeconfig, ...args],
      value === undefined ? undefined : JSON.stringify(value),
    );
  const get = (kind, name, ns = namespace) =>
    JSON.parse(k(['-n', ns, 'get', kind, name, '-o', 'json']));
  const apply = (items) =>
    k(['apply', '-f', '-'], { apiVersion: 'v1', kind: 'List', items });
  const r = (apiVersion, kind, name, spec = {}, ns = fixtures) => ({
    apiVersion,
    kind,
    metadata: { name, namespace: ns },
    ...spec,
  });
  const service = (name, port) =>
    r('v1', 'Service', name, {
      spec: {
        selector: { fixture: name },
        ports: [{ port, targetPort: port }],
      },
    });
  const deployment = (name, image, command, extra = {}) =>
    r('apps/v1', 'Deployment', name, {
      spec: {
        replicas: 1,
        selector: { matchLabels: { fixture: name } },
        template: {
          metadata: { labels: { fixture: name } },
          spec: { containers: [{ name, image, command, ...extra }] },
        },
      },
    });
  const gitRoot = join(scratch, 'git'),
    bare = join(gitRoot, 'repo.git'),
    repository = join(scratch, 'publisher');
  mkdirSync(gitRoot);
  const git = (...args) => exec('git', ['-C', repository, ...args]).trim();
  const write = (path, value) => {
    const full = join(repository, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(
      full,
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  };
  const commit = (message) => {
    git('add', '.');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const until = async (description, fn, ms = 240000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      try {
        if (await fn()) return;
      } catch (error) {
        last = error.message?.slice(0, 220);
      }
      await delay(1000);
    }
    throw new Error(`Timeout ${description}${last ? `: ${last}` : ''}`);
  };
  const forward = async (name, port, ns = fixtures) => {
    const child = spawn(
      'kubectl',
      [
        '--kubeconfig',
        kubeconfig,
        '-n',
        ns,
        'port-forward',
        `service/${name}`,
        `:${port}`,
        '--address=127.0.0.1',
      ],
      {
        env: { ...env, KUBECONFIG: kubeconfig },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    await until(
      `forward ${name}`,
      () => {
        assert.equal(child.exitCode, null);
        return /127\.0\.0\.1:(\d+)/.test(output);
      },
      30000,
    );
    return Number(output.match(/127\.0\.0\.1:(\d+)/)[1]);
  };
  const download = async (artifact, name) => {
    const response = await fetch(artifact.url);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      digest(bytes),
      artifact.sha256,
      `official artifact identity ${name}`,
    );
    const path = join(scratch, name);
    writeFileSync(path, bytes);
    return path;
  };
  const require = createRequire(
    new URL('../packages/core/package.json', import.meta.url),
  );
  const { parseAllDocuments } = require('yaml');
  const chart = join(root, 'charts/smrt-app');
  const render = (v) =>
    parseAllDocuments(
      exec(
        'helm',
        ['template', 'legacy', chart, '--namespace', namespace, '-f', '-'],
        JSON.stringify(v),
      ),
    )
      .map((d) => {
        assert.equal(d.errors.length, 0);
        return d.toJSON();
      })
      .filter(Boolean);
  const sql = (statement) =>
    k([
      '-n',
      fixtures,
      'exec',
      'deployment/postgres',
      '--',
      'psql',
      '-U',
      'fixture',
      '-d',
      'fixture',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      statement,
    ]).trim();
  const secret = (name, data) =>
    r(
      'v1',
      'Secret',
      name,
      {
        immutable: true,
        type: 'Opaque',
        data: Object.fromEntries(
          Object.entries(data).map(([key, value]) => [
            key,
            Buffer.from(value).toString('base64'),
          ]),
        ),
      },
      namespace,
    );
  const ready = (o) =>
    o.status?.conditions?.some(
      (c) =>
        c.type === 'Ready' &&
        c.status === 'True' &&
        c.observedGeneration === o.metadata.generation,
    );
  const acknowledgeGit = (source, ks, revision) =>
    until(`Git ${source}/${revision}`, () => {
      const s = get('gitrepository', source, 'flux-system'),
        kustomization = get('kustomization', ks, 'flux-system');
      return (
        ready(s) &&
        ready(kustomization) &&
        s.status.artifact?.revision.endsWith(`sha1:${revision}`) &&
        kustomization.status.lastAppliedRevision.endsWith(`sha1:${revision}`)
      );
    });
  let sampleStop = false,
    sampler,
    sampleFailure,
    samples = [];
  try {
    assert.equal(
      existsSync(kubeconfig),
      false,
      'fresh explicit kubeconfig required',
    );
    const kubectlPath = env.PATH.split(':')
      .map((directory) => join(directory, 'kubectl'))
      .find(existsSync);
    assert.ok(kubectlPath, 'verified compatible kubectl must be installed');
    assert.equal(
      digest(readFileSync(kubectlPath)),
      legacyArtifacts.kubectl.sha256,
      'exact production-profile kubectl required',
    );
    const kindConfig = join(scratch, 'kind.json');
    writeFileSync(
      kindConfig,
      JSON.stringify({
        kind: 'Cluster',
        apiVersion: 'kind.x-k8s.io/v1alpha4',
        networking: { disableDefaultCNI: true, podSubnet: '10.244.0.0/16' },
        nodes: [
          {
            role: 'control-plane',
            extraMounts: [
              {
                hostPath: gitRoot,
                containerPath: '/smrt-fixture-git',
                readOnly: true,
              },
            ],
          },
        ],
      }),
    );
    exec('kind', [
      'create',
      'cluster',
      '--name',
      cluster,
      '--config',
      kindConfig,
      '--image',
      legacyArtifacts.node,
      '--kubeconfig',
      kubeconfig,
      '--wait',
      '0s',
    ]);
    created = true;
    assert.equal(k(['config', 'current-context']).trim(), `kind-${cluster}`);
    const [cilium, ingress, flux, unsupportedFlux] = await Promise.all([
      download(legacyArtifacts.cilium, 'cilium.tgz'),
      download(legacyArtifacts.ingress, 'ingress.tgz'),
      download(legacyArtifacts.flux, 'flux.yaml'),
      download(legacyArtifacts.unsupportedFlux, 'unsupported-flux.yaml'),
    ]);
    assert.throws(() =>
      assertRetryOnFailureSupport(
        parseAllDocuments(readFileSync(unsupportedFlux, 'utf8')).map((d) =>
          d.toJSON(),
        ),
      ),
    );
    assertRetryOnFailureSupport(
      parseAllDocuments(readFileSync(flux, 'utf8')).map((d) => d.toJSON()),
    );
    exec('helm', [
      'install',
      'cilium',
      cilium,
      '-n',
      'kube-system',
      '--set',
      'ipam.mode=kubernetes',
      '--set',
      'kubeProxyReplacement=false',
      '--set',
      'operator.replicas=1',
      '--set',
      'envoy.enabled=false',
      '--wait',
      '--timeout',
      '5m',
    ]);
    k([
      '-n',
      'kube-system',
      'rollout',
      'status',
      'daemonset/cilium',
      '--timeout=240s',
    ]);
    exec('kubectl', ['--kubeconfig', kubeconfig, 'apply', '-f', flux]);
    for (const controller of ['source', 'kustomize', 'helm'])
      k([
        '-n',
        'flux-system',
        'rollout',
        'status',
        `deployment/${controller}-controller`,
        '--timeout=240s',
      ]);
    exec('helm', [
      'install',
      'legacy-ingress',
      ingress,
      '-n',
      'ingress-nginx',
      '--create-namespace',
      '--set',
      'controller.ingressClass=smrt-legacy',
      '--set',
      'controller.ingressClassResource.name=smrt-legacy',
      '--set',
      'controller.ingressClassResource.controllerValue=smrt.happyvertical.com/legacy-nginx',
      '--set',
      'controller.watchIngressWithoutClass=false',
      '--set',
      'controller.admissionWebhooks.enabled=false',
      '--set',
      'controller.service.type=ClusterIP',
      '--wait',
      '--timeout',
      '5m',
    ]);
    for (const [name, version] of Object.entries({
      'source-controller': 'v1.8.5',
      'kustomize-controller': 'v1.8.5',
      'helm-controller': 'v1.5.5',
    })) {
      assert.equal(
        get('deployment', name, 'flux-system').spec.template.spec.containers[0]
          .image,
        `ghcr.io/fluxcd/${name}:${version}`,
      );
    }
    // Exact historical ingress version under a newer Kubernetes is an explicit
    // compatibility experiment, not a supported production version claim.
    note(
      'installed verified Cilium and real Flux/ingress-nginx; historical NGINX support-matrix limitation retained',
    );
    for (const name of [fixtures, namespace]) k(['create', 'namespace', name]);
    exec('git', ['init', '--bare', '--initial-branch=main', bare]);
    exec('git', ['clone', bare, repository]);
    git('config', 'user.email', 'smrt-legacy@example.invalid');
    git('config', 'user.name', 'SMRT isolated exercise');
    write('README.md', 'Synthetic disposable Git/Flux fixture only.\n');
    const initial = commit('fixture repository');
    git('push', 'origin', 'HEAD:main');
    const tlsDir = join(scratch, 'tls');
    mkdirSync(tlsDir);
    const pgHost = `postgres.${fixtures}.svc.cluster.local`;
    exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(tlsDir, 'ca.key'),
      '-out',
      join(tlsDir, 'ca.crt'),
      '-days',
      '2',
      '-subj',
      '/CN=SMRT disposable PostgreSQL CA',
    ]);
    exec('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(tlsDir, 'server.key'),
      '-out',
      join(tlsDir, 'server.csr'),
      '-subj',
      `/CN=${pgHost}`,
    ]);
    writeFileSync(
      join(tlsDir, 'server.ext'),
      `subjectAltName=DNS:${pgHost}\nextendedKeyUsage=serverAuth\n`,
    );
    exec('openssl', [
      'x509',
      '-req',
      '-in',
      join(tlsDir, 'server.csr'),
      '-CA',
      join(tlsDir, 'ca.crt'),
      '-CAkey',
      join(tlsDir, 'ca.key'),
      '-CAcreateserial',
      '-out',
      join(tlsDir, 'server.crt'),
      '-days',
      '2',
      '-extfile',
      join(tlsDir, 'server.ext'),
    ]);
    exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(tlsDir, 'wrong.key'),
      '-out',
      join(tlsDir, 'wrong-ca.crt'),
      '-days',
      '2',
      '-subj',
      '/CN=Untrusted disposable CA',
    ]);
    const tlsSecret = r('v1', 'Secret', 'postgres-tls-v1', {
      immutable: true,
      type: 'Opaque',
      data: Object.fromEntries(
        ['ca.crt', 'server.crt', 'server.key', 'wrong-ca.crt']
          .map((n) => [n, readFileSync(join(tlsDir, n)).toString('base64')])
          .concat([
            [
              'pg_hba.conf',
              Buffer.from(
                'local all all trust\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\nhostssl all all 0.0.0.0/0 scram-sha-256\nhostssl all all ::/0 scram-sha-256\n',
              ).toString('base64'),
            ],
          ]),
      ),
    });
    const pg = deployment(
      'postgres',
      legacyImages.postgres,
      [
        'sh',
        '-ec',
        'cp /tls/server.key /tmp/server.key; chmod 600 /tmp/server.key; chown postgres:postgres /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tmp/server.key -c hba_file=/tls/pg_hba.conf',
      ],
      {
        volumeMounts: [{ name: 'tls', mountPath: '/tls', readOnly: true }],
        env: [
          { name: 'POSTGRES_USER', value: 'fixture' },
          { name: 'POSTGRES_PASSWORD', value: 'fixture-only-password' },
          { name: 'POSTGRES_DB', value: 'fixture' },
        ],
      },
    );
    pg.spec.template.spec.volumes = [
      { name: 'tls', secret: { secretName: 'postgres-tls-v1' } },
    ];
    const server = deployment(
      'git',
      legacyImages.node,
      ['node', '-e', smartGitServer],
      { volumeMounts: [{ name: 'git', mountPath: '/git', readOnly: true }] },
    );
    server.spec.template.spec.volumes = [
      {
        name: 'git',
        hostPath: { path: '/smrt-fixture-git', type: 'Directory' },
      },
    ];
    apply([
      tlsSecret,
      pg,
      service('postgres', 5432),
      server,
      service('git', 8080),
      deployment('registry', legacyImages.registry, [
        '/entrypoint.sh',
        '/etc/docker/registry/config.yml',
      ]),
      service('registry', 5000),
      deployment('probe', legacyImages.node, [
        'node',
        '-e',
        'setInterval(()=>{},100000)',
      ]),
    ]);
    for (const name of ['postgres', 'git', 'registry', 'probe'])
      k([
        '-n',
        fixtures,
        'rollout',
        'status',
        `deployment/${name}`,
        '--timeout=240s',
      ]);
    const gitPort = await forward('git', 8080);
    assert.match(
      exec('git', [
        'ls-remote',
        `http://127.0.0.1:${gitPort}/repo.git`,
        'main',
      ]),
      new RegExp(initial),
    );
    exec('git', [
      'clone',
      `http://127.0.0.1:${gitPort}/repo.git`,
      join(scratch, 'transport-check'),
    ]);
    await until('PostgreSQL native ready', () => sql('SELECT 1') === '1');
    sql(
      "CREATE ROLE legacy LOGIN PASSWORD 'fixture-old-password'; CREATE ROLE runtime LOGIN PASSWORD 'fixture-rotated-password'; CREATE ROLE migration LOGIN PASSWORD 'fixture-migration-password'; GRANT ALL ON SCHEMA public TO migration; CREATE ROLE fence_observer LOGIN PASSWORD 'fixture-observer-password'; GRANT pg_monitor TO fence_observer; CREATE TABLE writer_ticks (at timestamptz DEFAULT now()); GRANT INSERT ON writer_ticks TO legacy,runtime;",
    );
    const credentials = {
      pghost: pgHost,
      pgdatabase: 'fixture',
      pgsslmode: 'verify-full',
      pgsslrootcert_pem: readFileSync(join(tlsDir, 'ca.crt'), 'utf8'),
    };
    const tlsSql = (statement, extra = []) =>
      k([
        '-n',
        fixtures,
        'exec',
        'deployment/postgres',
        '--',
        'env',
        'PGPASSWORD=fixture-observer-password',
        'PGSSLMODE=verify-full',
        'PGSSLROOTCERT=/tls/ca.crt',
        ...extra,
        'psql',
        '-h',
        pgHost,
        '-U',
        'fence_observer',
        '-d',
        'fixture',
        '-v',
        'ON_ERROR_STOP=1',
        '-Atc',
        statement,
      ]).trim();
    assert.equal(
      tlsSql("SELECT current_setting('server_version_num')::int / 10000"),
      '17',
    );
    assert.equal(
      tlsSql('SELECT ssl::text FROM pg_stat_ssl WHERE pid=pg_backend_pid()'),
      'true',
    );
    const databaseTLSIdentity = hash({
      postgresUid: get('deployment', 'postgres', fixtures).metadata.uid,
      tlsSecretUid: get('secret', 'postgres-tls-v1', fixtures).metadata.uid,
      ca: digest(readFileSync(join(tlsDir, 'ca.crt'))),
    });
    for (const extra of [
      ['PGSSLMODE=disable'],
      ['PGSSLROOTCERT=/tls/wrong-ca.crt'],
    ]) {
      assert.throws(() => tlsSql('SELECT 1', extra));
    }
    const pgIPForSAN = get('service', 'postgres', fixtures).spec.clusterIP;
    assert.throws(() =>
      k([
        '-n',
        fixtures,
        'exec',
        'deployment/postgres',
        '--',
        'env',
        'PGPASSWORD=fixture-observer-password',
        'PGSSLMODE=verify-full',
        'PGSSLROOTCERT=/tls/ca.crt',
        `PGHOSTADDR=${pgIPForSAN}`,
        'psql',
        '-h',
        'wrong-san.invalid',
        '-U',
        'fence_observer',
        '-d',
        'fixture',
        '-Atc',
        'SELECT 1',
      ]),
    );
    const publicData = {
      'index.html': 'static-ready',
      'legal.html': 'legal-ready',
    };
    apply([
      secret('runtime-v1', {
        ...credentials,
        pguser: 'legacy',
        pgpassword: 'fixture-old-password',
      }),
      secret('runtime-v2', {
        ...credentials,
        pguser: 'runtime',
        pgpassword: 'fixture-rotated-password',
      }),
      secret('migration-v1', {
        ...credentials,
        pguser: 'migration',
        pgpassword: 'fixture-migration-password',
      }),
      r(
        'v1',
        'ConfigMap',
        'public-original',
        { immutable: true, data: publicData },
        namespace,
      ),
      r(
        'v1',
        'ConfigMap',
        'public-v1',
        { immutable: true, data: publicData },
        namespace,
      ),
      r('v1', 'ServiceAccount', 'reconciler', {}, namespace),
      r(
        'rbac.authorization.k8s.io/v1',
        'Role',
        'reconciler',
        {
          rules: [
            {
              apiGroups: ['', 'apps', 'batch', 'networking.k8s.io'],
              resources: [
                'pods',
                'secrets',
                'configmaps',
                'services',
                'serviceaccounts',
                'deployments',
                'replicasets',
                'cronjobs',
                'jobs',
                'ingresses',
              ],
              verbs: [
                'get',
                'list',
                'watch',
                'create',
                'update',
                'patch',
                'delete',
              ],
            },
          ],
        },
        namespace,
      ),
      r(
        'rbac.authorization.k8s.io/v1',
        'RoleBinding',
        'reconciler',
        {
          subjects: [{ kind: 'ServiceAccount', name: 'reconciler', namespace }],
          roleRef: {
            apiGroup: 'rbac.authorization.k8s.io',
            kind: 'Role',
            name: 'reconciler',
          },
        },
        namespace,
      ),
    ]);
    const current = legacyRuntime(
        hash({ data: publicData, binaryData: {} }),
        fixtures,
      ),
      target = structuredClone(current);
    const values = {
      app: { name: 'legacy', environment: 'isolated' },
      release: { id: 'adopt-4481', sequence: 1, attempt: 1, phase: 'stopped' },
      current,
      target,
      maintenance: {
        image: legacyImages.nginx,
        command: ['nginx', '-g', 'daemon off;'],
        port: 8080,
        http: { path: '/', status: 503, body: 'Maintenance' },
      },
      bindings: {
        database: { secretName: 'runtime-v2', secretKey: 'pghost' },
        privateBuckets: [],
      },
      ingress: {
        name: 'legacy-web',
        host: 'app.legacy.invalid',
        className: 'smrt-legacy',
        annotations: {
          'nginx.ingress.kubernetes.io/proxy-body-size': '11m',
          'nginx.ingress.kubernetes.io/proxy-buffer-size': '64k',
        },
        additionalRoutes: [
          { name: 'legacy-site', host: 'www.legacy.invalid', workload: 'site' },
        ],
      },
    };
    const ownership = {
      'meta.helm.sh/release-name': 'legacy',
      'meta.helm.sh/release-namespace': namespace,
      'kustomize.toolkit.fluxcd.io/prune': 'disabled',
    };
    const legacyManifests = (phase) =>
      render({ ...values, release: { ...values.release, phase } })
        .filter(
          (o) =>
            !['Job'].includes(o.kind) && o.metadata.name !== 'legacy-inventory',
        )
        .map((o) => {
          if (
            phase !== 'stopped' &&
            o.kind === 'Deployment' &&
            current.workloads[o.metadata.name.slice('legacy-'.length)]?.writer
          ) {
            o.spec.template.spec.containers[0].env =
              o.spec.template.spec.containers[0].env.map((entry) => ({
                ...entry,
                valueFrom: {
                  secretKeyRef: {
                    ...entry.valueFrom.secretKeyRef,
                    name: 'runtime-v1',
                  },
                },
              }));
          }
          if (o.kind === 'Deployment' && o.metadata.name === 'legacy-site') {
            o.spec.template.metadata.labels = { app: 'legacy-site' };
            if (phase !== 'stopped')
              o.spec.template.spec.volumes.find(
                (v) => v.name === 'public-content',
              ).configMap.name = 'public-original';
          }
          return {
            ...o,
            metadata: {
              ...o.metadata,
              namespace,
              annotations: { ...o.metadata.annotations, ...ownership },
              labels: {
                ...o.metadata.labels,
                'app.kubernetes.io/managed-by': 'Helm',
              },
            },
          };
        });
    write('legacy/resources.json', {
      apiVersion: 'v1',
      kind: 'List',
      items: legacyManifests('active'),
    });
    const originalRevision = commit('legacy application active');
    git('push', 'origin', 'HEAD:legacy');
    const repoUrl = `http://git.${fixtures}.svc.cluster.local:8080/repo.git`;
    const gitSource = (name, branch) =>
      r(
        'source.toolkit.fluxcd.io/v1',
        'GitRepository',
        name,
        { spec: { interval: '5s', url: repoUrl, ref: { branch } } },
        'flux-system',
      );
    const ks = (name, source, path, prune) =>
      r(
        'kustomize.toolkit.fluxcd.io/v1',
        'Kustomization',
        name,
        {
          spec: {
            interval: '5s',
            path,
            sourceRef: { kind: 'GitRepository', name: source },
            prune,
            wait: false,
            timeout: '3m',
          },
        },
        'flux-system',
      );
    apply([
      gitSource('legacy-source', 'legacy'),
      ks('legacy-app', 'legacy-source', './legacy', false),
    ]);
    await acknowledgeGit('legacy-source', 'legacy-app', originalRevision);
    for (const name of Object.keys(current.workloads).filter(
      (name) => !current.workloads[name].schedule,
    ))
      k([
        '-n',
        namespace,
        'rollout',
        'status',
        `deployment/legacy-${name}`,
        '--timeout=240s',
      ]);
    const ingressPort = await forward(
      'legacy-ingress-ingress-nginx-controller',
      80,
      'ingress-nginx',
    );
    const publicRequest = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname.endsWith('.svc.cluster.local')) {
        const output = k([
          '-n',
          fixtures,
          'exec',
          'deployment/probe',
          '--',
          'node',
          '-e',
          `fetch(${JSON.stringify(url)},{redirect:'manual',signal:AbortSignal.timeout(10000)}).then(async r=>console.log(JSON.stringify({status:r.status,headers:[...r.headers],body:await r.text()}))).catch(()=>process.exit(1))`,
        ]);
        const actual = JSON.parse(output);
        return new Response(actual.body, {
          status: actual.status,
          headers: actual.headers,
        });
      }
      return fetch(`http://127.0.0.1:${ingressPort}${parsed.pathname}`, {
        ...options,
        headers: { host: parsed.hostname },
      });
    };
    const assertHTTP = async (status) => {
      assert.equal(
        (await publicRequest('http://app.legacy.invalid/')).status,
        status,
      );
      for (const path of ['/', '/legal.html'])
        assert.equal(
          (await publicRequest(`http://www.legacy.invalid${path}`)).status,
          200,
        );
    };
    await until('initial public HTTP', async () => {
      await assertHTTP(200);
      return true;
    });
    sampler = (async () => {
      while (!sampleStop) {
        try {
          const app = await publicRequest('http://app.legacy.invalid/'),
            site = await publicRequest('http://www.legacy.invalid/legal.html');
          samples.push({
            at: Date.now(),
            app: app.status,
            site: site.status,
            release: app.headers.get('x-smrt-release'),
            sequence: app.headers.get('x-smrt-sequence'),
          });
          assert.ok([200, 503].includes(app.status));
          assert.equal(site.status, 200);
          if (app.status === 503) {
            assert.equal(app.headers.get('x-smrt-release'), 'adopt-4481');
            assert.ok(Number(app.headers.get('x-smrt-sequence')) >= 1);
          }
        } catch (error) {
          sampleFailure = error;
          return;
        }
        await delay(200);
      }
    })();
    const nginxConfig = k([
      '-n',
      'ingress-nginx',
      'exec',
      'deployment/legacy-ingress-ingress-nginx-controller',
      '--',
      'nginx',
      '-T',
    ]);
    assert.match(nginxConfig, /client_max_body_size\s+11m;/);
    assert.match(nginxConfig, /proxy_buffer_size\s+64k;/);
    const oversized = await fetch(`http://127.0.0.1:${ingressPort}/`, {
      method: 'POST',
      headers: { host: 'app.legacy.invalid' },
      body: Buffer.alloc(12 * 1024 * 1024),
    });
    assert.equal(oversized.status, 413);
    const original = legacyManifests('active').map((o) =>
      get(o.kind, o.metadata.name),
    );
    write('legacy/resources.json', {
      apiVersion: 'v1',
      kind: 'List',
      items: legacyManifests('maintenance'),
    });
    const maintenanceRevision = commit('reviewed legacy maintenance');
    git('push', 'origin', 'HEAD:legacy');
    await acknowledgeGit('legacy-source', 'legacy-app', maintenanceRevision);
    await until('maintenance response', async () => {
      await assertHTTP(503);
      return true;
    });
    write('legacy/resources.json', {
      apiVersion: 'v1',
      kind: 'List',
      items: legacyManifests('stopped'),
    });
    const stopRevision = commit('reviewed legacy writer stop');
    git('push', 'origin', 'HEAD:legacy');
    await acknowledgeGit('legacy-source', 'legacy-app', stopRevision);
    await until('legacy drained and static rollout steady', () => {
      const pods = JSON.parse(
        k(['-n', namespace, 'get', 'pods', '-o', 'json']),
      ).items;
      return (
        pods.length === 2 &&
        pods.every(
          (p) =>
            ['legacy-site', 'legacy-maintenance'].some((n) =>
              p.metadata.name.startsWith(`${n}-`),
            ) &&
            !p.metadata.deletionTimestamp &&
            p.status?.conditions?.some(
              (c) => c.type === 'Ready' && c.status === 'True',
            ),
        )
      );
    });
    assert.ok(
      Number(sql('SELECT count(*) FROM writer_ticks')) > 0,
      'actual legacy writes occurred',
    );
    sql(
      "ALTER ROLE legacy NOLOGIN; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='legacy';",
    );
    const stopped = original.map((o) => get(o.kind, o.metadata.name));
    write('legacy/resources.json', {
      apiVersion: 'v1',
      kind: 'List',
      items: [],
    });
    const relinquishRevision = commit(
      'reviewed legacy inventory relinquish with pruning disabled',
    );
    git('branch', 'relinquished', relinquishRevision);
    // Rewind only the local fixture publisher checkout, never remote history.
    git('switch', '-C', 'main', initial);
    mkdirSync(join(repository, 'deploy/adoption/flux'), { recursive: true });
    const packageVersion = parseAllDocuments(
      readFileSync(join(chart, 'Chart.yaml'), 'utf8'),
    )[0].toJSON().version;
    exec('helm', ['package', chart, '--destination', scratch]);
    const chartPackage = join(scratch, `smrt-app-${packageVersion}.tgz`),
      chartArtifactSha256 = digest(readFileSync(chartPackage));
    const registryPort = await forward('registry', 5000);
    exec('helm', [
      'push',
      chartPackage,
      `oci://127.0.0.1:${registryPort}/charts`,
      '--plain-http',
    ]);
    const receipt = await fetch(
      `http://127.0.0.1:${registryPort}/v2/charts/smrt-app/manifests/${packageVersion}`,
      { headers: { Accept: 'application/vnd.oci.image.manifest.v1+json' } },
    );
    assert.equal(receipt.status, 200);
    const chartOciDigest = receipt.headers.get('docker-content-digest');
    assert.match(chartOciDigest, /^sha256:[a-f0-9]{64}$/);
    const oci = r(
      'source.toolkit.fluxcd.io/v1',
      'OCIRepository',
      'legacy-chart',
      {
        spec: {
          interval: '5s',
          url: `oci://registry.${fixtures}.svc.cluster.local:5000/charts/smrt-app`,
          insecure: true,
          ref: { digest: chartOciDigest },
          layerSelector: {
            mediaType: 'application/vnd.cncf.helm.chart.content.v1.tar+gzip',
            operation: 'copy',
          },
        },
      },
      namespace,
    );
    apply([oci]);
    await until('OCI source ready', () =>
      ready(get('ocirepository', 'legacy-chart')),
    );
    const candidate = r(
      'helm.toolkit.fluxcd.io/v2',
      'HelmRelease',
      'legacy',
      {
        spec: {
          interval: '5s',
          releaseName: 'legacy',
          serviceAccountName: 'reconciler',
          chartRef: { kind: 'OCIRepository', name: 'legacy-chart' },
          install: { strategy: { name: 'RetryOnFailure' } },
          upgrade: { strategy: { name: 'RetryOnFailure' } },
          driftDetection: { mode: 'enabled' },
          values,
        },
      },
      namespace,
    );
    // Empty auto-generated target directory does not exist in Git until staging;
    // a non-Ready empty target KS is allowed before first HR publication.
    apply([
      gitSource('target-source', 'main'),
      ks('target-app', 'target-source', './deploy/adoption/flux', true),
    ]);
    const legacySource = get('gitrepository', 'legacy-source', 'flux-system'),
      legacyKS = get('kustomization', 'legacy-app', 'flux-system'),
      targetSource = get('gitrepository', 'target-source', 'flux-system'),
      targetKS = get('kustomization', 'target-app', 'flux-system');
    const legacy = {
      repository: repoUrl,
      revision: originalRevision,
      maintenanceRevision,
      stopRevision,
      relinquishRevision,
      source: {
        namespace: 'flux-system',
        name: 'legacy-source',
        uid: legacySource.metadata.uid,
      },
      kustomization: {
        namespace: 'flux-system',
        name: 'legacy-app',
        uid: legacyKS.metadata.uid,
      },
    };
    const snapshot = {
      apiVersion: 'smrt.happyvertical.com/legacy-snapshot-v1',
      adoptionId: 'fixture-4481',
      legacy,
      normalization: {
        normalizedCurrentIdentity: hash(current),
        explanation:
          'Actual original pod specifications retained; reviewed stopped revision scales only nonstatic Deployments and suspends CronJobs; exact immutable selectors and external configuration preserved.',
      },
      resources: original.map((o, i) => ({
        apiVersion: o.apiVersion,
        kind: o.kind,
        namespace,
        name: o.metadata.name,
        uid: o.metadata.uid,
        spec: o.spec ?? o.data ?? {},
        specIdentity: hash(o.spec ?? o.data ?? {}),
        normalizedSpecIdentity: hash(stopped[i].spec ?? stopped[i].data ?? {}),
        selector: o.spec?.selector ?? {},
        legacyManager: 'kustomize-controller',
        fluxInventoryId: legacyKS.status.inventory.entries.find((e) =>
          e.id.includes(`_${o.metadata.name}_`),
        )?.id,
        ...(['Deployment', 'CronJob'].includes(o.kind)
          ? {
              podSpec:
                o.kind === 'CronJob'
                  ? o.spec.jobTemplate.spec.template.spec
                  : o.spec.template.spec,
              oldImages: (o.kind === 'CronJob'
                ? o.spec.jobTemplate.spec.template.spec
                : o.spec.template.spec
              ).containers.map((c) => c.image),
            }
          : {}),
      })),
    };
    assert.ok(
      snapshot.resources.every((o) => o.fluxInventoryId),
      'actual legacy Flux inventory IDs required',
    );
    const snapshotBytes = `${JSON.stringify(snapshot, null, 2)}\n`,
      snapshotSha256 = digest(snapshotBytes);
    // Real qualification producer executes the exact application fixture wrapper,
    // including a deliberate native database fence failure. It emits no row data.
    const qualificationJob = (name) =>
      r(
        'batch/v1',
        'Job',
        name,
        {
          spec: {
            backoffLimit: 0,
            template: {
              spec: {
                restartPolicy: 'Never',
                automountServiceAccountToken: false,
                containers: [
                  {
                    name: 'qualify',
                    image: target.migration.image,
                    command: target.migration.command,
                    env: target.migration.env,
                  },
                ],
                ...{
                  securityContext: target.migration.podSecurityContext,
                  volumes: [{ name: 'tmp', emptyDir: {} }],
                },
              },
            },
          },
        },
        namespace,
      );
    const runQualification = async (name, success) => {
      const job = qualificationJob(name);
      job.spec.template.spec.containers[0].securityContext =
        target.migration.securityContext;
      job.spec.template.spec.containers[0].volumeMounts = [
        { name: 'tmp', mountPath: '/tmp' },
      ];
      apply([job]);
      await until(`qualification ${name}`, () => {
        const j = get('job', name);
        return success ? j.status?.succeeded === 1 : j.status?.failed === 1;
      });
      const result = get('job', name);
      const logs = k(['-n', namespace, 'logs', `job/${name}`, '--tail=30']);
      if (!success) assert.match(logs, /legacy credential fence absent/);
      k(['-n', namespace, 'delete', 'job', name, '--wait=true']);
      return {
        uid: result.metadata.uid,
        specIdentity: hash(result.spec),
        executionLogIdentity: digest(logs),
        succeeded: result.status.succeeded ?? 0,
        failed: result.status.failed ?? 0,
      };
    };
    sql('ALTER ROLE legacy LOGIN');
    const negativeQualification = await runQualification(
      'guard-negative',
      false,
    );
    sql('ALTER ROLE legacy NOLOGIN');
    const positiveQualification = await runQualification(
      'guard-positive',
      true,
    );
    assert.equal(sql('SELECT count(*) FROM fixture_effects'), '1');
    sql('TRUNCATE fixture_phases,fixture_effects');
    writeFileSync(
      join(evidence, 'qualification-execution.json'),
      JSON.stringify({ negativeQualification, positiveQualification }, null, 2),
    );
    const fenceContract = {
      id: 'fixture-native-fence-v1',
      identity: hash({
        fixture:
          'finite admission policy + Cilium static egress + PG17 oldrole NOLOGIN/session proof',
        version: 1,
      }),
    };
    const qualification = {
      apiVersion: 'smrt.happyvertical.com/legacy-adoption-qualification-v1',
      adoptionId: 'fixture-4481',
      snapshotSha256,
      normalizedCurrentIdentity: hash(current),
      targetIdentity: hash(target),
      configurationIdentity: hash({
        maintenance: values.maintenance,
        bindings: values.bindings,
        ingress: values.ingress,
      }),
      chartArtifactSha256,
      chartOciDigest,
      fenceContractIdentity: fenceContract.identity,
      source: exec('git', ['-C', root, 'rev-parse', 'HEAD']).trim(),
      tree: hash({ fixtureMigration, current, target }),
      lock: digest(readFileSync(join(root, 'pnpm-lock.yaml'))),
      toolchain: process.version,
      validation: {
        passed:
          positiveQualification.succeeded === 1 &&
          negativeQualification.failed === 1,
        executionIdentity: hash({
          positiveQualification,
          negativeQualification,
        }),
      },
    };
    const qualificationBytes = `${JSON.stringify(qualification, null, 2)}\n`,
      qualificationSha256 = digest(qualificationBytes);
    write('proof/snapshot.json', snapshotBytes);
    writeFileSync(join(evidence, 'legacy-snapshot.json'), snapshotBytes);
    writeFileSync(join(evidence, 'qualification.json'), qualificationBytes);
    write('proof/qualification.json', qualificationBytes);
    const artifactsRevision = commit(
      'trusted fixture qualification and actual snapshot',
    );
    git('push', 'origin', 'HEAD:main');
    const plan = {
      apiVersion: 'smrt.happyvertical.com/legacy-adoption-v1',
      adoptionId: 'fixture-4481',
      releaseId: values.release.id,
      namespace,
      releaseName: 'legacy',
      canonicalFile: 'deploy/adoption/flux/release.json',
      stagingFile: 'deploy/adoption/flux/staging.json',
      stateFile: 'proof/state.json',
      legacy,
      snapshot: { file: 'proof/snapshot.json', sha256: snapshotSha256 },
      qualification: {
        file: 'proof/qualification.json',
        sha256: qualificationSha256,
      },
      normalizedCurrentIdentity: hash(current),
      targetIdentity: hash(target),
      configurationIdentity: qualification.configurationIdentity,
      chartArtifactSha256,
      chartOciDigest,
      fenceContract,
      candidate,
    };
    // Native policy is intentionally finite to this fixture, including actor checks
    // so a forged ownerReference submitted by this administrator cannot pass.
    const allowedNames = stopped
      .filter((o) => ['Deployment', 'CronJob'].includes(o.kind))
      .map((o) => o.metadata.name);
    const allowedCommands = [
      ...Object.values(current.workloads).map((w) => w.command),
      target.migration.command,
      ...render({ ...values, release: { ...values.release, phase: 'stopped' } })
        .filter(
          (o) =>
            o.kind === 'Deployment' && o.metadata.name === 'legacy-maintenance',
        )
        .map((o) => o.spec.template.spec.containers[0].command),
    ];
    const policy = legacyAdmissionPolicy(
      namespace,
      allowedNames,
      allowedCommands,
    );
    const binding = {
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicyBinding',
      metadata: { name: 'smrt-legacy-fence' },
      spec: { policyName: 'smrt-legacy-fence', validationActions: ['Deny'] },
    };
    const sitePodBefore = JSON.parse(
      k([
        '-n',
        namespace,
        'get',
        'pods',
        '-l',
        'app=legacy-site',
        '-o',
        'json',
      ]),
    ).items.find((p) => p.status?.phase === 'Running');
    const pgProbeIP = get('service', 'postgres', fixtures).spec.clusterIP,
      apiProbeIP = get('service', 'kubernetes', 'default').spec.clusterIP;
    for (const address of [pgProbeIP + ':5432', apiProbeIP + ':443']) {
      const [host, port] = address.split(':');
      k([
        '-n',
        namespace,
        'exec',
        sitePodBefore.metadata.name,
        '--',
        'timeout',
        '3',
        'bash',
        '-c',
        `exec 3<>/dev/tcp/${host}/${port}`,
      ]);
    }
    const network = r(
      'networking.k8s.io/v1',
      'NetworkPolicy',
      'static-deny-egress',
      {
        spec: {
          podSelector: { matchLabels: { app: 'legacy-site' } },
          policyTypes: ['Egress'],
          egress: [],
        },
      },
      namespace,
    );
    apply([policy, binding, network]);
    await until('VAP accepted', () => {
      const p = JSON.parse(
        k([
          'get',
          'validatingadmissionpolicy',
          policy.metadata.name,
          '-o',
          'json',
        ]),
      );
      return (
        p.status?.observedGeneration === p.metadata.generation &&
        !p.status?.typeChecking?.expressionWarnings?.length
      );
    });
    const denial = (object) => {
      let denied = false;
      try {
        k(['create', '-f', '-'], object);
      } catch {
        denied = true;
      }
      assert.ok(denied, 'actual unsafe fixture request must be denied');
    };
    denial(
      r(
        'v1',
        'Pod',
        'unknown',
        {
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'x',
                image: legacyImages.postgres,
                command: ['sleep', '60'],
              },
            ],
          },
        },
        namespace,
      ),
    );
    const forged = r(
      'v1',
      'Pod',
      'forged-owner',
      {
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'x',
              image: legacyImages.postgres,
              command: ['sleep', '60'],
            },
          ],
        },
      },
      namespace,
    );
    forged.metadata.ownerReferences = [
      {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        name: 'forged',
        uid: randomUUID(),
        controller: true,
      },
    ];
    denial(forged);
    const unknownController = deployment(
      'unknown-controller',
      legacyImages.postgres,
      ['sleep', '60'],
    );
    unknownController.metadata.namespace = namespace;
    denial(unknownController);
    const wrongSecret = r(
      'v1',
      'Pod',
      'wrong-secret',
      {
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          containers: [
            {
              name: 'runtime',
              image: legacyImages.postgres,
              command: current.workloads.task.command,
              env: [
                {
                  name: 'PGPASSWORD',
                  valueFrom: {
                    secretKeyRef: { name: 'runtime-v1', key: 'pgpassword' },
                  },
                },
              ],
            },
          ],
        },
      },
      namespace,
    );
    assert.throws(
      () =>
        k(
          [
            `--as=system:serviceaccount:${namespace}:reconciler`,
            'create',
            '--dry-run=server',
            '-f',
            '-',
          ],
          wrongSecret,
        ),
      (error) => String(error.stderr).includes('rotated named credentials'),
    );
    await until(
      'Cilium denies static DB/API before any adoption publication',
      () => {
        for (const [host, port] of [
          [pgProbeIP, 5432],
          [apiProbeIP, 443],
        ]) {
          let timedOut = false;
          try {
            k([
              '-n',
              namespace,
              'exec',
              sitePodBefore.metadata.name,
              '--',
              'timeout',
              '3',
              'bash',
              '-c',
              `exec 3<>/dev/tcp/${host}/${port}`,
            ]);
          } catch (error) {
            timedOut = String(error.stderr).includes('exit code 124');
          }
          if (!timedOut) return false;
        }
        return true;
      },
    );
    const namespaceUid = get('namespace', namespace).metadata.uid;
    const ciliumUid = get('daemonset', 'cilium', 'kube-system').metadata.uid;
    const nativePolicyIdentity = (p, b, n) =>
      hash({
        namespaceUid,
        policy: { uid: p.metadata.uid, spec: p.spec },
        binding: { uid: b.metadata.uid, spec: b.spec },
        network: { uid: n.metadata.uid, spec: n.spec },
      });
    const namespacePolicyIdentity = nativePolicyIdentity(
      JSON.parse(
        k([
          'get',
          'validatingadmissionpolicy',
          'smrt-legacy-fence',
          '-o',
          'json',
        ]),
      ),
      JSON.parse(
        k([
          'get',
          'validatingadmissionpolicybinding',
          'smrt-legacy-fence',
          '-o',
          'json',
        ]),
      ),
      get('networkpolicy', 'static-deny-egress'),
    );
    let fenceCalls = 0;
    const observeWriterFence = async (request) => {
      const bound=request.plan;
      const ordinary=request.operation==='release';
      fenceCalls++;
      const at = Date.now();
      assert.equal(get('namespace', namespace).metadata.uid, namespaceUid);
      const cni = get('daemonset', 'cilium', 'kube-system');
      assert.equal(cni.metadata.uid, ciliumUid);
      assert.equal(cni.status.observedGeneration, cni.metadata.generation);
      assert.ok(cni.status.numberReady > 0);
      const actualPolicy = JSON.parse(
          k([
            'get',
            'validatingadmissionpolicy',
            'smrt-legacy-fence',
            '-o',
            'json',
          ]),
        ),
        actualBinding = JSON.parse(
          k([
            'get',
            'validatingadmissionpolicybinding',
            'smrt-legacy-fence',
            '-o',
            'json',
          ]),
        ),
        actualNetwork = get('networkpolicy', 'static-deny-egress');
      assert.equal(
        nativePolicyIdentity(actualPolicy, actualBinding, actualNetwork),
        namespacePolicyIdentity,
        'native namespace fence drift',
      );
      const role = tlsSql(
        "SELECT rolcanlogin::text FROM pg_roles WHERE rolname='legacy'",
      );
      assert.equal(role, 'false');
      const sessions = Number(
        tlsSql(
          "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type='client backend' AND usename <> 'fence_observer' AND (usename IN ('legacy','runtime','migration') OR client_addr IS NOT NULL)",
        ),
      );
      assert.equal(sessions, 0);
      const all = JSON.parse(
        k([
          '-n',
          namespace,
          'get',
          'deployments,cronjobs,jobs,pods',
          '-o',
          'json',
        ]),
      ).items;
      assert.ok(
        all
          .filter(
            (o) =>
              o.kind === 'Deployment' &&
              !['legacy-site', 'legacy-maintenance'].includes(o.metadata.name),
          )
          .every((o) => o.spec.replicas === 0),
      );
      assert.ok(
        all
          .filter((o) => o.kind === 'CronJob')
          .every((o) => o.spec.suspend === true),
      );
      assert.ok(
        all.filter((o) => o.kind === 'Job').every((o) => !o.status?.active),
      );
      assert.equal(
        tlsSql('SELECT ssl::text FROM pg_stat_ssl WHERE pid=pg_backend_pid()'),
        'true',
      );
      assert.equal(
        hash({
          postgresUid: get('deployment', 'postgres', fixtures).metadata.uid,
          tlsSecretUid: get('secret', 'postgres-tls-v1', fixtures).metadata.uid,
          ca: digest(readFileSync(join(tlsDir, 'ca.crt'))),
        }),
        databaseTLSIdentity,
      );
      const databasePolicyIdentity = hash({
        role: 'legacy',
        login: role,
        activeSessions: sessions,
        rotated: get('secret', 'runtime-v2').metadata.uid,
        databaseTLSIdentity,
      });
      return {
        apiVersion: 'smrt.happyvertical.com/writer-fence-v1',
        contractId: ordinary ? request.contractId : bound.fenceContract.id,
        contractIdentity: ordinary ? request.contractIdentity : bound.fenceContract.identity,
        ...(ordinary ? {context:structuredClone(request.context)} : {adoptionId:bound.adoptionId,planIdentity:hash(bound)}),
        namespace,
        epoch: hash({ namespacePolicyIdentity, databasePolicyIdentity }),
        observedAt: at,
        expiresAt: at + 25000,
        namespacePolicyIdentity,
        databasePolicyIdentity,
        observations: [
          {
            scope: 'namespace',
            identity: hash(
              all.map((o) => ({
                uid: o.metadata.uid,
                spec: o.spec,
                status: o.status,
              })),
            ),
            observedAt: at,
            activeWriters: 0,
          },
          {
            scope: 'database',
            identity: databasePolicyIdentity,
            observedAt: at,
            activeWriters: sessions,
          },
        ],
      };
    };
    const validation = {
      source: qualification.source,
      tree: qualification.tree,
      lock: qualification.lock,
      toolchain: qualification.toolchain,
      runtimeIdentity: hash(target),
      migrationImage: target.migration.image,
      migrationCommandIdentity: hash(target.migration.command),
      migrationProtocol: 'smrt-release-v1',
      validation: qualification.validation,
      chartArtifactSha256,
      chartReferenceIdentity: hash(candidate.spec.chartRef),
      chartOciDigest,
      chartSourceIdentity: hash(get('ocirepository', 'legacy-chart').spec),
      configurationIdentity: qualification.configurationIdentity,
    };
    const validationFile = join(scratch, 'app-validation.json');
    writeFileSync(validationFile, JSON.stringify(validation));
    const config = {
      repository,
      branch: 'main',
      file: plan.canonicalFile,
      namespace,
      helmReleaseName: 'legacy',
      chart: chartPackage,
      chartSource: { name: 'legacy-chart', namespace, digest: chartOciDigest },
      source: { name: 'target-source', namespace: 'flux-system' },
      kustomization: { name: 'target-app', namespace: 'flux-system' },
      validationEvidence: {
        file: validationFile,
        sha256: digest(readFileSync(validationFile)),
      },
      maintenanceAssertions: [
        { url: 'http://app.legacy.invalid/', status: 503 },
      ],
      staticAssertions: [
        {
          url: 'http://www.legacy.invalid/legal.html',
          status: 200,
          bodyIncludes: 'legal-ready',
        },
      ],
      privateAssertions: [
        {
          url: `http://legacy-web.${namespace}.svc.cluster.local:8080/`,
          status: 200,
          bodyIncludes: 'application-ready',
        },
      ],
      publicAssertions: [{ url: 'http://app.legacy.invalid/', status: 200 }],
      writerFence:{...fenceContract},
      adoption: {
        stateFile: plan.stateFile,
        stagingFile: plan.stagingFile,
        fluxPath: 'deploy/adoption/flux',
        sourceUid: targetSource.metadata.uid,
        kustomizationUid: targetKS.metadata.uid,
        snapshotSha256,
        qualificationSha256,
      },
    };
    const adapter = () =>
      createLiveAdapter(config, nativeCommand, publicRequest, {
        adoptionFenceObserver: observeWriterFence,
      });
    const configFile = join(scratch, 'config.json'),
      planFile = join(scratch, 'plan.json');
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(planFile, JSON.stringify(plan));
    await releaseCli(['adopt-plan', configFile, planFile], () => adapter());
    const wrongUidConfig = structuredClone(config);
    wrongUidConfig.adoption.sourceUid = randomUUID();
    await assert.rejects(
      planAdoption(
        wrongUidConfig,
        createLiveAdapter(wrongUidConfig, nativeCommand, publicRequest, {
          adoptionFenceObserver: observeWriterFence,
        }),
        plan,
      ),
      /identity/i,
    );
    // Fail-closed missing/stale callbacks use real native observers for all other
    // work; no fabricated native acknowledgement is injected.
    await assert.rejects(
      adoptOrResume(
        config,
        createLiveAdapter(config, nativeCommand, publicRequest),
        plan,
      ),
    );
    const stale = async (ctx) => ({
      ...(await observeWriterFence(ctx)),
      observedAt: Date.now() - 60000,
    });
    await assert.rejects(
      adoptOrResume(
        config,
        createLiveAdapter(config, nativeCommand, publicRequest, {
          adoptionFenceObserver: stale,
        }),
        plan,
      ),
    );
    for (const expected of ['planned', 'legacy-stopped']) {
      const result = await adoptOrResume(config, adapter(), plan);
      assert.equal(result.stage, expected);
    }
    await assert.rejects(
      releaseCli(['apply-or-resume', configFile], () => adapter()),
      /adoption/i,
    );
    git('push', 'origin', `${relinquishRevision}:refs/heads/legacy`);
    await acknowledgeGit('legacy-source', 'legacy-app', relinquishRevision);
    assert.equal(
      get('kustomization', 'legacy-app', 'flux-system').spec.prune,
      false,
    );
    await assert.rejects(
      adapter().observeLegacy(
        plan,
        await adapter().readAdoption(plan),
        'planned',
      ),
      /revision/i,
    );
    const relinquished = await adoptOrResume(config, adapter(), plan);
    assert.equal(relinquished.stage, 'relinquished');
    const conflictObject = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: 'legacy-web',
        namespace,
        labels: { 'smrt-exercise-conflict': 'held' },
      },
    };
    k(
      [
        'apply',
        '--server-side',
        '--field-manager=smrt-exercise-conflict',
        '-f',
        '-',
      ],
      conflictObject,
    );
    await assert.rejects(adoptOrResume(config, adapter(), plan), /manager/i);
    delete conflictObject.metadata.labels;
    k(
      [
        'apply',
        '--server-side',
        '--field-manager=smrt-exercise-conflict',
        '-f',
        '-',
      ],
      conflictObject,
    );
    assert.ok(
      !get('service', 'legacy-web').metadata.managedFields.some(
        (f) => f.manager === 'smrt-exercise-conflict',
      ),
    );
    const staged = await adoptOrResume(config, adapter(), plan);
    assert.equal(staged.stage, 'helm-staged');
    await until('staging HR acknowledged', async () => {
      try {
        await adapter().observeAdopted(
          plan,
          await adapter().readAdoption(plan),
          'helm-established',
        );
        return true;
      } catch {
        return false;
      }
    });
    const stagedUid = get('helmrelease', 'legacy').metadata.uid;
    assert.equal(
      get('deployment', 'legacy-site').spec.template.metadata.labels[
        'smrt.happyvertical.com/workload'
      ],
      'site',
    );
    const adoptedSitePod = JSON.parse(
      k([
        '-n',
        namespace,
        'get',
        'pods',
        '-l',
        'app=legacy-site',
        '-o',
        'json',
      ]),
    ).items[0];
    assert.ok(adoptedSitePod.metadata.labels['smrt.happyvertical.com/runtime']);
    await assert.rejects(
      releaseCli(['apply-or-resume', configFile], () => adapter()),
      /adoption/i,
    );
    // A new adapter/process-equivalent reads Git journal afresh after staging.
    const rejectHook = join(bare, 'hooks/pre-receive');
    for (const stage of ['helm-established', 'finalized']) {
      writeFileSync(rejectHook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const beforeCalls = fenceCalls;
      await assert.rejects(adoptOrResume(config, adapter(), plan));
      assert.ok(fenceCalls > beforeCalls);
      const held = await adapter().readAdoption(plan);
      assert.equal(
        held.state.stage,
        stage === 'helm-established' ? 'helm-staged' : 'helm-established',
      );
      rmSync(rejectHook);
      const retryBefore = fenceCalls;
      assert.equal((await adoptOrResume(config, adapter(), plan)).stage, stage);
      assert.ok(
        fenceCalls > retryBefore,
        'restart must reobserve native fence after actual rejected Git push',
      );
    }
    assert.equal(get('helmrelease', 'legacy').metadata.uid, stagedUid);
    assert.equal(
      (await adoptOrResume(config, adapter(), plan)).stage,
      'finalized',
    );
    for (const old of original) {
      const actual = get(old.kind, old.metadata.name);
      assert.equal(actual.metadata.uid, old.metadata.uid);
      assert.equal(
        hash(actual.spec?.selector ?? {}),
        hash(old.spec?.selector ?? {}),
      );
    }
    writeFileSync(
      join(evidence, 'final-adoption-state.json'),
      JSON.stringify((await adapter().readAdoption(plan)).state, null, 2),
    );
    note(
      'real Git CAS, Flux handover, immutable UIDs/selectors and staging→canonical same HR UID verified',
    );
    // Real Cilium egress enforcement must be tested in the static pod itself.
    const sitePod = JSON.parse(
      k([
        '-n',
        namespace,
        'get',
        'pods',
        '-l',
        'app=legacy-site',
        '-o',
        'json',
      ]),
    ).items[0];
    k([
      '-n',
      namespace,
      'exec',
      sitePod.metadata.name,
      '--',
      'sh',
      '-c',
      'test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token',
    ]);
    const staticEnvironmentNames = k([
      '-n',
      namespace,
      'exec',
      sitePod.metadata.name,
      '--',
      'sh',
      '-c',
      'env | cut -d= -f1',
    ])
      .trim()
      .split('\n');
    assert.ok(
      !staticEnvironmentNames.some(hasStaticCredentialName),
      'static pod cannot contain credential environment names',
    );
    const pgIP = get('service', 'postgres', fixtures).spec.clusterIP,
      apiIP = get('service', 'kubernetes', 'default').spec.clusterIP;
    for (const [host, port] of [
      [pgIP, 5432],
      [apiIP, 443],
    ]) {
      let timedOut = false;
      try {
        k([
          '-n',
          namespace,
          'exec',
          sitePod.metadata.name,
          '--',
          'timeout',
          '3',
          'bash',
          '-c',
          `exec 3<>/dev/tcp/${host}/${port}`,
        ]);
      } catch (error) {
        timedOut = String(error.stderr).includes('exit code 124');
      }
      assert.ok(
        timedOut,
        'previously reachable static TCP probe must time out under Cilium',
      );
    }
    for (const phase of ['migrate', 'verify', 'active']) {
      await releaseCli(['apply-or-resume', configFile], () => adapter());
      const saved = await adapter().read();
      assert.equal(saved.document.spec.values.release.phase, phase);
      await until(`ordinary ${phase} acknowledgement`, async () => {
        try {
          await adapter().observe(saved.document, saved.revision);
          return true;
        } catch {
          return false;
        }
      });
    }
    await until('reactivated HTTP', async () => {
      await assertHTTP(200);
      return true;
    });
    assert.equal(sql('SELECT count(*) FROM fixture_effects'), '1');
    writeFileSync(
      join(evidence, 'active-release.json'),
      JSON.stringify((await adapter().read()).document, null, 2),
    );
    sampleStop = true;
    await sampler;
    assert.ifError(sampleFailure);
    assert.ok(
      samples.some((s) => s.app === 200) && samples.some((s) => s.app === 503),
    );
    assert.ok(samples.every((s) => s.site === 200));
    writeFileSync(
      join(evidence, 'continuity.json'),
      JSON.stringify(samples, null, 2),
    );
    writeFileSync(
      join(evidence, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          originalUidIdentity: hash(original.map((o) => o.metadata.uid)),
          stagedHelmReleaseUid: stagedUid,
          finalHelmReleaseUid: get('helmrelease', 'legacy').metadata.uid,
          chartArtifactSha256,
          chartOciDigest,
          artifactsRevision,
          toolchain: {
            node: process.version,
            nodeBinarySha256: digest(readFileSync(process.execPath)),
            kubectlBinarySha256: digest(readFileSync(kubectlPath)),
            kubectl: JSON.parse(k(['version', '--client', '-o', 'json']))
              .clientVersion.gitVersion,
            artifacts: legacyArtifacts,
          },
          controllers: JSON.parse(
            k(['-n', 'flux-system', 'get', 'pods', '-o', 'json']),
          ).items.map((o) => ({
            name: o.metadata.name,
            images: o.spec.containers.map((c) => c.image),
            imageIDs: o.status.containerStatuses?.map((c) => c.imageID),
          })),
          crdIdentity: hash(
            JSON.parse(
              k([
                'get',
                'crd',
                'helmreleases.helm.toolkit.fluxcd.io',
                '-o',
                'json',
              ]),
            ).spec,
          ),
          databaseTLS: {
            sslmode: 'verify-full',
            serverSAN: pgHost,
            postgresMajor: 17,
            plaintextRejected: true,
            wrongCARejected: true,
            wrongSANRejected: true,
          },
          limitations: [
            'Historical ingress-nginx4.11.3 outside documented Kubernetes support matrix',
            'TLS SAN and versioned certificate rotation not exercised',
            'Finite fixture policy is not general production platform fencing qualification',
          ],
        },
        null,
        2,
      ),
    );
    note(
      'ordinary migration→verify→active acknowledged real Git/Flux, static HTTP continuity and Cilium deny probes passed',
    );
  } finally {
    sampleStop = true;
    if (sampler) await sampler.catch(() => {});
    for (const child of children) child.kill('SIGTERM');
    if (created) {
      try {
        exec('kind', ['delete', 'cluster', '--name', cluster]);
      } finally {
        rmSync(kubeconfig, { force: true });
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  legacyMain().catch((error) => {
    console.error(
      `[legacy-exercise] FAILED ${error.name}: ${String(error.message)
        .replace(
          /fixture-(?:only|old|rotated|migration|observer)-password/g,
          '[redacted]',
        )
        .slice(0, 1800)}`,
    );
    process.exitCode = 1;
  });
}
