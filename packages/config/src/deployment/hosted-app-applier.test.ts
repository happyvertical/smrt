import { describe, expect, it, vi } from 'vitest';
import { composeHostedApp } from './hosted-app.js';
import {
  createHostedAppApplier,
  HostedAppApplyError,
} from './hosted-app-applier.js';

const manifest = (() => {
  const digest = `ghcr.io/example/notes@sha256:${'0123456789abcdef'.repeat(4)}`;
  const result = composeHostedApp({
    document: {
      'x-happyvertical': {
        version: 1,
        preset: 'smrt',
        migrate: { command: ['migrate'] },
      },
      services: {
        web: {
          build: '.',
          command: ['node', 'build'],
          ports: ['3000:3000'],
          'x-happyvertical': { role: 'web', health: { path: '/health' } },
        },
      },
    },
    commit: 'a1b2c3d4e5f6',
    digests: { web: digest },
    app: { name: 'notes', poolRef: 'shared', tier: 'T1' },
    entitlements: { bindings: [] },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.rejections));
  return result.manifest;
})();

describe('createHostedAppApplier', () => {
  it('server-side applies only the HostedApp kind with the scoped credential', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ metadata: { generation: 3 } })),
    );
    const applier = createHostedAppApplier({
      apiServer: 'https://k8s.test/',
      token: 't0ken',
      fetch: fetchImpl as never,
      fieldManager: 'my-deployer',
    });
    expect(await applier.apply(manifest)).toEqual({ generation: 3 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://k8s.test/apis/hosting.happyvertical.com/v1alpha1/hostedapps/notes?fieldManager=my-deployer&force=true',
    );
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer t0ken',
      'content-type': 'application/apply-patch+yaml',
    });
    expect(JSON.parse(init.body as string)).toEqual(manifest);
  });

  it('throws a status-only error and never echoes the response or token', async () => {
    const applier = createHostedAppApplier({
      apiServer: 'https://k8s.test',
      token: 't0ken',
      fetch: (async () =>
        new Response('secret body t0ken', { status: 403 })) as never,
    });
    const error = await applier.apply(manifest).catch((caught) => caught);
    expect(error).toEqual(new HostedAppApplyError(403, 'apply failed (403)'));
    expect(error.message).not.toContain('secret');
  });

  it('refuses to apply another kind or a bad name without a request', async () => {
    const fetchImpl = vi.fn();
    const applier = createHostedAppApplier({
      apiServer: 'https://k8s.test',
      token: 't',
      fetch: fetchImpl as never,
    });
    await expect(
      applier.apply({ ...manifest, kind: 'Secret' } as never),
    ).rejects.toBeInstanceOf(HostedAppApplyError);
    await expect(
      applier.apply({
        ...manifest,
        metadata: { ...manifest.metadata, name: '../secrets' },
      }),
    ).rejects.toBeInstanceOf(HostedAppApplyError);
    await expect(applier.remove('a/b')).rejects.toBeInstanceOf(
      HostedAppApplyError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a missing HostedApp as already deleted and surfaces other failures', async () => {
    const make = (status: number) =>
      createHostedAppApplier({
        apiServer: 'https://k8s.test',
        token: 't',
        fetch: (async () => new Response('', { status })) as never,
      });
    await expect(make(404).remove('notes')).resolves.toBeUndefined();
    await expect(make(500).remove('notes')).rejects.toEqual(
      new HostedAppApplyError(500, 'delete failed (500)'),
    );
  });

  it('requires a valid API server and a token at construction', () => {
    expect(() =>
      createHostedAppApplier({ apiServer: 'not a url', token: 't' }),
    ).toThrow(HostedAppApplyError);
    expect(() =>
      createHostedAppApplier({ apiServer: 'https://k8s.test', token: '' }),
    ).toThrow(HostedAppApplyError);
  });
});
