import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProviderReadinessProbe } from './provider-readiness.js';

const context = (provider: string) => ({ profile: 'self-hosted', provider });

describe('default stand-in readiness (#4864)', () => {
  it('probes the local-files asset store without leaving a file behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assets-'));
    const probe = createProviderReadinessProbe(
      'assets',
      context('local-files'),
      { environment: { SMRT_ASSETS_DIR: root } },
    );
    await expect(probe()).resolves.toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it('fails the asset probe on a missing, relative or nonexistent directory', async () => {
    for (const dir of [
      undefined,
      'relative/path',
      join(tmpdir(), `missing-${Date.now()}`),
    ]) {
      const probe = createProviderReadinessProbe(
        'assets',
        context('local-files'),
        { environment: { SMRT_ASSETS_DIR: dir } },
      );
      await expect(probe()).rejects.toThrow('assets provider readiness');
    }
  });

  it('checks the environment secret store against SMRT_SECRETS_REQUIRED', async () => {
    const make = (environment: Record<string, string>) =>
      createProviderReadinessProbe('secrets', context('environment'), {
        environment,
      });
    await expect(make({})()).resolves.toBeUndefined();
    await expect(
      make({ SMRT_SECRETS_REQUIRED: 'A, B', A: '1', B: '2' })(),
    ).resolves.toBeUndefined();
    await expect(
      make({ SMRT_SECRETS_REQUIRED: 'A,B', A: '1' })(),
    ).rejects.toThrow('secrets provider readiness');
  });

  it('still requires a named module for providers without a default', async () => {
    const probe = createProviderReadinessProbe(
      'assets',
      context('s3-compatible'),
      {
        environment: {},
      },
    );
    await expect(probe()).rejects.toThrow(
      /SMRT_ASSETS_READINESS_MODULE must name/,
    );
  });
});
