import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createAdoptionMethods } from './deployment/live-adoption.mjs';
import { run, createLiveAdapter } from './deployment/live.mjs';
const execute = promisify(execFile);
const digest = (value) => createHash('sha256').update(value).digest('hex');

test('ordinary fence preflight binds protected Git module bytes without invoking native zero-writer queries', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'smrt-runtime-fence-'));
  try {
    const remote = join(scratch, 'remote.git'),
      repository = join(scratch, 'publisher');
    await execute('git', ['init', '--bare', '--initial-branch=main', remote]);
    await execute('git', ['clone', remote, repository]);
    const git = async (...args) =>
      (await execute('git', ['-C', repository, ...args])).stdout.trim();
    await git('config', 'user.name', 'SMRT fixture');
    await git('config', 'user.email', 'fixture@example.invalid');
    await mkdir(join(repository, 'platform'));
    await mkdir(join(repository, 'apps'));
    const source =
      'export async function observeWriterFence(){throw new Error("SECRET_QUERY_CANARY");}\n';
    await writeFile(join(repository, 'platform/writer-fence.mjs'), source);
    await writeFile(join(repository, 'apps/release.json'), '{}');
    await git('add', '.');
    await git('commit', '-m', 'protected provider');
    await git('push', 'origin', 'main');
    const config = {
      repository,
      branch: 'main',
      namespace: 'test',
      file: 'apps/release.json',
      kustomization: { name: 'app', namespace: 'test' },
      writerFence: {
        id: 'fixture',
        identity: 'a'.repeat(64),
        observer: { file: 'platform/writer-fence.mjs', sha256: digest(source) },
      },
    };
    const methods = createAdoptionMethods(
      config,
      run,
      { get: async () => ({ spec: { path: './apps' } }) },
      {},
    );
    await methods.prepareReleaseWriterFence();
    const document = {
      spec: {
        values: { release: { id: 'release-1', phase: 'stopped', attempt: 1 } },
      },
    };
    const revision = await git('rev-parse', 'HEAD');
    await assert.rejects(
      methods.observeReleaseWriterFence(document, revision),
      (error) =>
        error.code === 'WRITER_FENCE' &&
        !error.message.includes('SECRET_QUERY_CANARY'),
    );
    config.writerFence.observer.sha256 = 'b'.repeat(64);
    await assert.rejects(
      methods.prepareReleaseWriterFence(),
      /module identity mismatch/,
    );
    config.writerFence.observer.sha256 = digest(source);
    await writeFile(
      join(repository, 'platform/writer-fence.mjs'),
      source + '// reviewed source changed\n',
    );
    await git('add', '.');
    await git('commit', '-m', 'new provider bytes');
    await git('push', 'origin', 'main');
    await assert.rejects(
      methods.prepareReleaseWriterFence(),
      /module identity mismatch/,
    );
    config.writerFence.observer.file = 'apps/provider.mjs';
    await assert.rejects(
      methods.prepareReleaseWriterFence(),
      /outside rendered Flux/,
    );
    await symlink('writer-fence.mjs', join(repository, 'platform/link.mjs'));
    await git('add', '.');
    await git('commit', '-m', 'symlink fixture');
    await git('push', 'origin', 'main');
    config.writerFence.observer.file = 'platform/link.mjs';
    await assert.rejects(
      methods.prepareReleaseWriterFence(),
      /regular tracked file/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

import { applyOrResume, identity, hash } from './deployment/release.mjs';

test('actual-current static fence refreshes after long preflight immediately before Git CAS', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  for (const failure of [
    null,
    'expired',
    'full-document',
    'unknown-writer',
    'source-drift',
    'maintenance',
  ]) {
    const scratch = await mkdtemp(join(tmpdir(), 'smrt-runtime-cas-'));
    try {
      const remote = join(scratch, 'remote.git'),
        repository = join(scratch, 'publisher');
      await execute('git', ['init', '--bare', '--initial-branch=main', remote]);
      await execute('git', ['clone', remote, repository]);
      const git = async (...args) =>
        (await execute('git', ['-C', repository, ...args])).stdout.trim();
      await git('config', 'user.name', 'SMRT fixture');
      await git('config', 'user.email', 'fixture@example.invalid');
      const image = `registry/app@sha256:${'a'.repeat(64)}`;
      const site = {
        image,
        command: ['node', 'site'],
        env: [],
        role: 'service',
        writer: false,
        replicas: 1,
        service: { port: 80 },
        continuousStatic: true,
        automountServiceAccountToken: false,
        podSecurityContext: {
          runAsNonRoot: true,
          runAsUser: 101,
          runAsGroup: 101,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
      };
      const runtime = {
        workloads: {
          web: { image, command: ['node', 'web'], env: [], replicas: 1 },
          site,
        },
        migration: { image, command: ['node', 'migrate'], env: [] },
      };
      const document = {
        kind: 'HelmRelease',
        metadata: { name: 'app' },
        spec: {
          values: {
            app: { name: 'app', environment: 'test' },
            release: {
              id: 'release-1',
              phase: failure === 'maintenance' ? 'maintenance' : 'stopped',
              sequence: 1,
              attempt: 1,
            },
            current: structuredClone(runtime),
            target: structuredClone(runtime),
            ingress: {},
            bindings: {},
          },
        },
      };
      await mkdir(join(repository, 'apps'));
      await writeFile(
        join(repository, 'apps/release.json'),
        JSON.stringify(document),
      );
      await git('add', '.');
      await git('commit', '-m', 'current');
      await git('push', 'origin', 'main');
      const initial = await git('rev-parse', 'HEAD');
      let calls = 0,
        calledAt,
        observedContext;
      const config = {
        repository,
        branch: 'main',
        file: 'apps/release.json',
        namespace: 'test',
        source: { name: 'source' },
        kustomization: { name: 'app' },
        chart: 'unused',
        writerFence: { id: 'fixture', identity: 'f'.repeat(64) },
      };
      const live = createLiveAdapter(config, run, undefined, {
        adoptionFenceObserver: async (context) => {
          calls++;
          calledAt = clock;
          observedContext = context;
          const proof = {
            apiVersion: 'smrt.happyvertical.com/writer-fence-v1',
            contractId: context.contractId,
            contractIdentity: context.contractIdentity,
            namespace: 'test',
            context: context.context,
            epoch: 'epoch-1',
            observedAt: clock,
            expiresAt: clock + 20000,
            namespacePolicyIdentity: 'b'.repeat(64),
            databasePolicyIdentity: 'c'.repeat(64),
            observations: ['namespace', 'database'].map((scope) => ({
              scope,
              identity: 'd'.repeat(64),
              observedAt: clock,
              activeWriters: 0,
            })),
          };
          if (failure === 'expired') proof.observedAt -= 31000;
          if (failure === 'full-document')
            proof.context = {
              ...proof.context,
              documentSha256: 'e'.repeat(64),
            };
          if (failure === 'unknown-writer')
            proof.observations[0].activeWriters = 1;
          return proof;
        },
      });
      const before = clock;
      const adapter = {
        read: live.read,
        observe: async (doc, revision) => ({
          accepted: true,
          proven: true,
          identity: identity(doc),
          revision,
        }),
        preflight: async () => {
          clock += 60000;
          if (failure === 'source-drift') {
            await writeFile(join(repository, 'unrelated.txt'), 'drift');
            await git('add', '.');
            await git('commit', '-m', 'source advanced');
            await git('push', 'origin', 'main');
          }
        },
        cas: live.cas,
      };
      if (failure && failure !== 'maintenance') {
        await assert.rejects(
          applyOrResume(config, adapter),
          (error) => error.code === 'WRITER_FENCE',
        );
        assert.equal(
          JSON.parse(await git('show', 'origin/main:apps/release.json')).spec
            .values.release.phase,
          'stopped',
        );
        if (failure !== 'source-drift')
          assert.equal(await git('rev-parse', 'origin/main'), initial);
      } else {
        await applyOrResume(config, adapter);
        const snapshot = await live.read();
        assert.equal(
          snapshot.document.spec.values.release.phase,
          failure === 'maintenance' ? 'stopped' : 'migrate',
        );
        assert.equal(calls, failure === 'maintenance' ? 0 : 1);
        if (failure !== 'maintenance') {
          assert.ok(
            calledAt >= before + 60000,
            'fresh actual facts occur after preflight',
          );
          assert.equal(observedContext.phase, 'stopped');
          assert.equal(observedContext.documentSha256, hash(document));
          assert.equal(observedContext.revision, initial);
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
});
