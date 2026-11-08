import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  assertRetryOnFailureSupport,
  legacyAdmissionPolicy,
  legacyArtifacts,
  legacyImages,
  hasStaticCredentialName,
  legacyRuntime,
  requireLegacyOptIn,
  smartGitServer,
  tcpProbe,
  supervisedForward,
} from './deployment-legacy-exercise.mjs';
import { isContinuousStatic, validateRuntime } from './deployment/release.mjs';
const execute = promisify(execFile);

test('legacy exercise requires explicit fresh isolated kubeconfig opt-in', () => {
  assert.throws(() => requireLegacyOptIn({}));
  assert.throws(() =>
    requireLegacyOptIn({
      SMRT_LEGACY_DEPLOYMENT_EXERCISE: '1',
      RUNNER_TEMP: '/tmp/fixture',
      KUBECONFIG: '/production/config',
    }),
  );
  assert.throws(() =>
    requireLegacyOptIn({
      SMRT_LEGACY_DEPLOYMENT_EXERCISE: '1',
      RUNNER_TEMP: '/tmp/fixture',
      KUBECONFIG: '/tmp/fixture/a:/tmp/fixture/b',
    }),
  );
  assert.doesNotThrow(() =>
    requireLegacyOptIn({
      SMRT_LEGACY_DEPLOYMENT_EXERCISE: '1',
      RUNNER_TEMP: '/tmp/fixture',
      KUBECONFIG: '/tmp/fixture/config',
    }),
  );
});

test('fixture has seven classified workloads with bounded real immutable configuration and TLS-only named credentials', () => {
  const runtime = legacyRuntime('a'.repeat(64), 'fixtures');
  validateRuntime(runtime);
  assert.equal(Object.keys(runtime.workloads).length, 7);
  assert.equal(isContinuousStatic(runtime.workloads.site), true);
  assert.equal(runtime.workloads.monitor.activeDeadlineSeconds, 3300);
  assert.ok(
    runtime.workloads.task.command[2].includes('INSERT INTO writer_ticks'),
  );
  for (const env of runtime.migration.env)
    assert.ok(env.valueFrom.secretKeyRef);
  assert.ok(runtime.migration.env.some((e) => e.name === 'PGSSLMODE'));
  assert.ok(
    runtime.migration.command[2].includes('legacy credential fence absent'),
  );
  assert.ok(runtime.migration.command[2].includes('pg_advisory_lock'));
  assert.ok(runtime.migration.command[2].includes('ON CONFLICT DO NOTHING'));
});

test('production HelmRelease CRD without RetryOnFailure fails before incompatible reconciliation', () => {
  const crd = (strategy) => {
    const action = {
      properties: strategy
        ? {
            strategy: {
              properties: {
                name: { enum: ['RemediateOnFailure', 'RetryOnFailure'] },
              },
            },
          }
        : {},
    };
    const schema = {
      properties: {
        spec: { properties: { install: action, upgrade: action } },
      },
    };
    return {
      kind: 'CustomResourceDefinition',
      metadata: { name: 'helmreleases.helm.toolkit.fluxcd.io' },
      spec: { versions: [{ name: 'v2', schema: { openAPIV3Schema: schema } }] },
    };
  };
  assert.throws(
    () => assertRetryOnFailureSupport([crd(false)]),
    /platform controller upgrade required/,
  );
  assert.doesNotThrow(() => assertRetryOnFailureSupport([crd(true)]));
  assert.notEqual(
    legacyArtifacts.flux.sha256,
    legacyArtifacts.unsupportedFlux.sha256,
  );
  for (const artifact of Object.values(legacyArtifacts).filter(
    (v) => typeof v === 'object',
  ))
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.match(legacyArtifacts.node, /v1\.34\.3@sha256:/);
});

test('finite admission policy binds actor, command, credential and volume envelope rather than owner labels alone', () => {
  const policy = legacyAdmissionPolicy(
    'fixture',
    ['legacy-web'],
    [['node', 'app.mjs']],
  );
  const expressions = policy.spec.validations
    .map((v) => v.expression)
    .join('\n');
  assert.ok(expressions.includes('request.userInfo.username'));
  assert.ok(expressions.includes('request.dryRun'));
  assert.ok(expressions.includes('command == c.command'));
  assert.ok(expressions.includes('!has(v.hostPath)'));
  assert.ok(expressions.includes('!has(v.projected)'));
  assert.ok(expressions.includes("['runtime-v2','migration-v1']"));
  assert.equal(policy.spec.failurePolicy, 'Fail');
  // The legacy Flux applier is admitted for drift dry-runs of reviewed names
  // only; it never gains a real write or a Job.
  const identity = policy.spec.validations[0].expression;
  const applier = "request.userInfo.username == 'system:serviceaccount:flux-system:kustomize-controller'";
  assert.equal(identity.split(applier).length, 2);
  assert.ok(
    identity.includes(
      `(request.dryRun && ${applier} && request.resource.resource != 'jobs' && ["legacy-web"].exists(n,n == object.metadata.name))`,
    ),
  );
});

test('smart HTTP fixture actually clones the same publisher bare Git object database', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'smrt-smart-git-'));
  let server;
  try {
    const bare = join(scratch, 'repo.git'),
      publisher = join(scratch, 'publisher');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], {
      stdio: 'pipe',
    });
    execFileSync('git', ['clone', bare, publisher], { stdio: 'pipe' });
    const git = (...args) =>
      execFileSync('git', ['-C', publisher, ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
    git('config', 'user.name', 'SMRT fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(publisher, 'real.txt'), 'actual Git object transport\n');
    git('add', '.');
    git('commit', '-m', 'fixture');
    git('push', 'origin', 'main');
    const revision = git('rev-parse', 'HEAD');
    server = spawn(process.execPath, ['-e', smartGitServer], {
      env: {
        ...process.env,
        SMRT_GIT_PROJECT_ROOT: scratch,
        SMRT_GIT_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await new Promise((resolve, reject) => {
      let text = '';
      const timeout = setTimeout(
        () => reject(new Error('smart Git startup timeout')),
        5000,
      );
      server.stdout.on('data', (chunk) => {
        text += chunk;
        const match = text.match(/smart-git-port:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      server.once('error', reject);
      server.once('exit', (code) => {
        if (code) reject(new Error(`smart Git exited ${code}`));
      });
    });
    const url = `http://127.0.0.1:${port}/repo.git`;
    const advertised = await fetch(`${url}/info/refs?service=git-upload-pack`);
    assert.equal(
      advertised.headers.get('content-type'),
      'application/x-git-upload-pack-advertisement',
    );
    assert.match(
      (await execute('git', ['ls-remote', url, 'main'])).stdout,
      new RegExp(revision),
    );
    const clone = join(scratch, 'clone');
    await execute('git', ['clone', url, clone]);
    assert.equal(
      (await execute('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim(),
      revision,
    );
    writeFileSync(join(publisher, 'second.txt'), 'fresh object\n');
    git('add', '.');
    git('commit', '-m', 'advance');
    git('push', 'origin', 'main');
    const next = git('rev-parse', 'HEAD');
    await execute('git', ['-C', clone, 'fetch', 'origin', 'main']);
    assert.equal(
      (
        await execute('git', ['-C', clone, 'rev-parse', 'origin/main'])
      ).stdout.trim(),
      next,
    );
  } finally {
    server?.kill('SIGTERM');
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('static credential probe accepts Kubernetes endpoint metadata but rejects credential names', () => {
  for (const name of [
    'KUBERNETES_SERVICE_HOST',
    'KUBERNETES_SERVICE_PORT',
    'KUBERNETES_PORT_443_TCP_ADDR',
    'NGINX_VERSION',
  ])
    assert.equal(hasStaticCredentialName(name), false);
  for (const name of [
    'PGPASSWORD',
    'PGHOST',
    'AWS_SECRET_ACCESS_KEY',
    'DATABASE_URL',
    'KUBECONFIG',
    'KUBE_TOKEN',
    'KUBERNETES_TOKEN',
  ])
    assert.equal(hasStaticCredentialName(name), true);
});

test('TCP probe uses busybox tools and maps busybox timeout to 124', async () => {
  const argv = tcpProbe('10.96.0.1', 443);
  // Host and port are positional arguments, never interpolated into the script.
  assert.deepEqual(argv.slice(0, 2), ['sh', '-c']);
  assert.deepEqual(argv.slice(3), ['10.96.0.1', '443']);
  assert.ok(!argv[2].includes('bash') && !argv[2].includes('/dev/tcp'));
  const run = (script, ...args) =>
    new Promise((resolve) => {
      const child = spawn('sh', ['-c', script, ...args], { stdio: 'ignore' });
      child.on('close', (code) => resolve(code));
    });
  // Stand-ins for busybox results: 143 (killed) must map to 124, others pass.
  for (const [status, expected] of [[0, 0], [1, 1], [143, 124]]) {
    const script = argv[2].replace('timeout 3 nc -z "$0" "$1"', `(exit ${status})`);
    assert.equal(await run(script, ...argv.slice(3)), expected);
  }
});

test('supervised port-forward keeps its local port, respawns on exit with the reason, and stops cleanly', async () => {
  const notes = [], spawns = [];
  const fake = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
    child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM'); };
    return child;
  };
  const start = (local) => { const c = fake(); spawns.push({ local, child: c }); return c; };
  const pending = supervisedForward(start, { name: 'ingress', note: (m) => notes.push(m), retryMs: 10 });
  spawns[0].child.stdout.write('Forwarding from 127.0.0.1:41234 -> 443\n');
  const handle = await pending;
  assert.equal(handle.port, 41234);
  assert.equal(spawns[0].local, 0);
  spawns[0].child.stderr.write('E1108 lost connection to pod\n');
  spawns[0].child.emit('exit', 1, null);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(spawns.length, 2, 'respawned once');
  assert.equal(spawns[1].local, 41234, 'same local port requested');
  assert.match(notes[0], /port-forward ingress exited \(1\): E1108 lost connection to pod; restarting on 127\.0\.0\.1:41234/);
  handle.kill('SIGTERM');
  assert.ok(spawns[1].child.killed);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(spawns.length, 2, 'no respawn after stop');
  assert.equal(notes.length, 1);
  const failing = supervisedForward((local) => { const c = fake(); setTimeout(() => { c.stderr.write('error: unable to listen\n'); c.emit('exit', 1, null); }, 5); return c; }, { name: 'git', note: () => {}, retryMs: 10 });
  await assert.rejects(failing, /forward git exited \(1\) before listening: error: unable to listen/);
  await assert.rejects(supervisedForward(() => fake(), { name: 'slow', note: () => {}, startupMs: 30 }), /Timeout forward slow/);
});
