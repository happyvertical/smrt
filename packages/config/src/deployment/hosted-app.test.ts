import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type ComposeHostedAppInput,
  composeHostedApp,
  type HostedAppEntitlements,
  hostedAppReleaseId,
  isHostedAppCommit,
} from './hosted-app.js';
import { sha256Hex } from './sha256.js';

const WEB = `ghcr.io/example/notes@sha256:${'0123456789abcdef'.repeat(4)}`;
const WORKER = `ghcr.io/example/notes@sha256:${'fedcba9876543210'.repeat(4)}`;
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const digests = { web: WEB, worker: WORKER };

function document(
  options: { domain?: string; bindings?: string[]; volume?: boolean } = {},
) {
  const bindings = options.bindings ?? ['postgres', 'bucket'];
  const services: Record<string, any> = {
    web: {
      build: '.',
      entrypoint: ['docker-entrypoint.sh'],
      command: ['node', 'build'],
      ports: ['3000:3000'],
      ...(options.volume === false ? {} : { volumes: ['uploads:/data'] }),
      'x-happyvertical': {
        role: 'web',
        health: { path: '/api/_runtime/health' },
      },
    },
    worker: {
      build: '.',
      command: ['pnpm', 'exec', 'smrt', 'app', 'worker', 'task'],
      'x-happyvertical': {
        role: 'worker',
        health: { command: ['pnpm', 'exec', 'smrt', 'app', 'doctor'] },
      },
    },
  };
  if (bindings.includes('postgres')) {
    services.database = {
      image: 'postgres:17',
      'x-happyvertical': { binding: 'postgres' },
    };
  }
  if (bindings.includes('bucket')) {
    services.files = {
      image: 'garage:latest',
      'x-happyvertical': { binding: 'bucket' },
    };
  }
  return {
    'x-happyvertical': {
      version: 1,
      preset: 'smrt',
      ...(options.domain === undefined ? {} : { domain: options.domain }),
      migrate: { command: ['pnpm', 'exec', 'smrt', 'db:migrate'] },
    },
    services,
    ...(options.volume === false ? {} : { volumes: { uploads: {} } }),
  };
}

function input(
  overrides: Partial<Omit<ComposeHostedAppInput, 'entitlements'>> & {
    entitlements?: Partial<HostedAppEntitlements>;
  } = {},
): ComposeHostedAppInput {
  const { entitlements, ...rest } = overrides;
  return {
    document: document(),
    commit: COMMIT,
    digests,
    app: {
      name: 'notes',
      poolRef: 'shared',
      tier: 'T2',
      labels: { 'example.com/project-id': 'p-1' },
    },
    entitlements: {
      bindings: ['postgres', 'bucket'],
      domains: [],
      platformHost: 'notes.apps.example.com',
      volumeSize: '2Gi',
      ...entitlements,
    },
    ...rest,
  };
}

function rejected(result: ReturnType<typeof composeHostedApp>) {
  if (result.ok) throw new Error('expected a rejection');
  return result.rejections;
}

describe('composeHostedApp', () => {
  it('emits a smrt-preset HostedApp from the declaration', () => {
    const result = composeHostedApp(
      input({
        document: document({ domain: 'notes.example.org' }),
        entitlements: { domains: ['notes.example.org'] },
      }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.rejections));
    expect(result.manifest).toMatchObject({
      apiVersion: 'hosting.happyvertical.com/v1alpha1',
      kind: 'HostedApp',
      metadata: {
        name: 'notes',
        labels: { 'example.com/project-id': 'p-1' },
      },
      spec: {
        poolRef: 'shared',
        tier: 'T2',
        domains: ['notes.example.org'],
        release: { id: hostedAppReleaseId(COMMIT, digests), commit: COMMIT },
        preset: { name: 'smrt', images: { web: WEB, worker: WORKER } },
        bindings: [
          { name: 'database', type: 'postgres' },
          { name: 'files', type: 'bucket' },
        ],
      },
    });
    expect(result.manifest.spec.preset.parameters).toEqual({
      migrateCommand: '["pnpm","exec","smrt","db:migrate"]',
      webCommand: '["docker-entrypoint.sh","node","build"]',
      webPort: '3000',
      webHealthPath: '/api/_runtime/health',
      workerCommand: '["pnpm","exec","smrt","app","worker","task"]',
      workerHealthCommand: '["pnpm","exec","smrt","app","doctor"]',
      volumes:
        '[{"name":"uploads","size":"2Gi","mounts":[{"workload":"web","path":"/data"}]}]',
    });
    expect(result.declaration.workloads).toHaveLength(2);
  });

  it('passes the preset options through and sets the resource class only when given', () => {
    const plain = composeHostedApp(input());
    expect(plain.ok && plain.manifest.spec.resourceClass).toBeUndefined();
    const result = composeHostedApp(
      input({
        app: {
          name: 'notes',
          poolRef: 'shared',
          tier: 'T1',
          resourceClass: 'standard',
        },
        preset: {
          workerRole: 'task',
          environment: 'staging',
          runtimeProfile: 'cloud',
        },
      }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.rejections));
    expect(result.manifest.spec.resourceClass).toBe('standard');
    expect(result.manifest.spec.preset.parameters).toMatchObject({
      workerRole: 'task',
      environment: 'staging',
      runtimeProfile: 'cloud',
    });
  });

  it('omits bindings, domains and volumes when the declaration has none', () => {
    const result = composeHostedApp(
      input({
        document: document({ bindings: [], volume: false }),
        entitlements: { volumeSize: undefined },
      }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.rejections));
    expect(result.manifest.spec.bindings).toBeUndefined();
    expect(result.manifest.spec.domains).toBeUndefined();
    expect(result.manifest.spec.preset.parameters.volumes).toBeUndefined();
  });

  it('rejects a binding the entitlements do not cover, without internals', () => {
    const result = composeHostedApp(
      input({ entitlements: { bindings: ['postgres'] } }),
    );
    expect(rejected(result)).toEqual([
      expect.objectContaining({
        code: 'binding-not-entitled',
        message: expect.stringContaining('bucket'),
      }),
    ]);
  });

  it('rejects an unverified domain and accepts the platform host', () => {
    const other = composeHostedApp(
      input({ document: document({ domain: 'other.example.org' }) }),
    );
    expect(rejected(other)[0]?.code).toBe('domain-not-verified');

    const platform = composeHostedApp(
      input({ document: document({ domain: 'notes.apps.example.com' }) }),
    );
    expect(platform.ok && platform.manifest.spec.domains).toBeUndefined();
    expect(platform.ok).toBe(true);
  });

  it('refuses a volume with no approved size or a malformed one', () => {
    expect(
      rejected(
        composeHostedApp(input({ entitlements: { volumeSize: undefined } })),
      )[0]?.code,
    ).toBe('volume-not-entitled');
    expect(
      rejected(
        composeHostedApp(input({ entitlements: { volumeSize: 'lots' } })),
      )[0]?.code,
    ).toBe('volume-size-invalid');
  });

  it('collects every entitlement problem in one pass', () => {
    const result = composeHostedApp(
      input({
        document: document({ domain: 'other.example.org' }),
        entitlements: { bindings: [], volumeSize: undefined },
      }),
    );
    expect(rejected(result).map((item) => item.code)).toEqual([
      'binding-not-entitled',
      'binding-not-entitled',
      'domain-not-verified',
      'volume-not-entitled',
    ]);
  });

  it('refuses a second worker, which the preset cannot run', () => {
    const doc = document();
    doc.services.worker2 = structuredClone(doc.services.worker);
    const result = composeHostedApp(
      input({
        document: doc,
        digests: { ...digests, worker2: WORKER },
      }),
    );
    expect(rejected(result).map((item) => item.code)).toContain(
      'multiple-workers-unsupported',
    );
  });

  it('refuses a discarded image command the preset cannot represent', () => {
    const doc = document();
    doc.services.web.entrypoint = [];
    doc.services.web.command = [];
    const result = composeHostedApp(input({ document: doc }));
    expect(rejected(result).map((item) => item.code)).toContain(
      'startup-command-unsupported',
    );
  });

  it('keeps an empty entrypoint when a command is still declared', () => {
    const doc = document();
    doc.services.web.entrypoint = [];
    const result = composeHostedApp(input({ document: doc }));
    expect(result.ok).toBe(true);
  });

  it('refuses a web command health check instead of dropping it', () => {
    const doc = document();
    doc.services.web['x-happyvertical'].health = { command: ['true'] };
    const result = composeHostedApp(input({ document: doc }));
    expect(rejected(result).map((item) => item.code)).toContain(
      'web-health-command-unsupported',
    );
  });

  it('surfaces declaration errors from the contract validator', () => {
    const doc = document();
    doc.services.web.privileged = true;
    expect(
      rejected(composeHostedApp(input({ document: doc }))).map(
        (item) => item.code,
      ),
    ).toContain('privileged');
  });

  it('rejects tag references, bad commits, names, tiers, pools, labels and roles', () => {
    expect(
      composeHostedApp(
        input({ digests: { web: 'ghcr.io/example/notes:latest' } }),
      ).ok,
    ).toBe(false);
    const cases: Array<[string, Partial<ComposeHostedAppInput>]> = [
      ['commit-invalid', { commit: 'main' }],
      [
        'platform-name-invalid',
        { app: { name: 'Notes', poolRef: 'p', tier: 'T1' } },
      ],
      [
        'platform-name-invalid',
        { app: { name: 'a'.repeat(41), poolRef: 'p', tier: 'T1' } },
      ],
      [
        'tier-invalid',
        { app: { name: 'notes', poolRef: 'p', tier: 'T9' as never } },
      ],
      ['pool-invalid', { app: { name: 'notes', poolRef: '', tier: 'T1' } }],
      [
        'labels-invalid',
        {
          app: {
            name: 'notes',
            poolRef: 'p',
            tier: 'T1',
            labels: { 'bad key!': 'x' },
          },
        },
      ],
      ['worker-role-invalid', { preset: { workerRole: 'daemon' as never } }],
    ];
    for (const [code, override] of cases) {
      expect(rejected(composeHostedApp(input(override)))[0]?.code).toBe(code);
    }
  });

  it('never throws on an untrusted document', () => {
    for (const document of [null, 42, 'x', [], { services: 1 }]) {
      expect(composeHostedApp(input({ document })).ok).toBe(false);
    }
  });
});

describe('hostedAppReleaseId', () => {
  it('is stable for one build, ignores digest key order and differs for another', () => {
    expect(hostedAppReleaseId(COMMIT, digests)).toBe(
      hostedAppReleaseId(COMMIT, { worker: WORKER, web: WEB }),
    );
    expect(hostedAppReleaseId(COMMIT, digests)).not.toBe(
      hostedAppReleaseId(COMMIT, { ...digests, worker: WEB }),
    );
    expect(hostedAppReleaseId(COMMIT, digests)).toMatch(
      /^rel-a1b2c3d4e5f6-[0-9a-f]{8}$/,
    );
  });

  it('validates commit spelling', () => {
    expect(isHostedAppCommit(COMMIT)).toBe(true);
    expect(isHostedAppCommit('main')).toBe(false);
    expect(isHostedAppCommit(undefined)).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches node:crypto across padding boundaries and multibyte text', () => {
    for (const text of [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(1000),
      'héllo 世界 🚀',
    ]) {
      expect(sha256Hex(text)).toBe(
        createHash('sha256').update(text).digest('hex'),
      );
    }
  });
});
