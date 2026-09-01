import { describe, expect, it } from 'vitest';

import {
  MAX_RUNTIME_DIAGNOSTIC_ERRORS,
  MAX_RUNTIME_DIAGNOSTIC_TOOLS,
  projectRuntimeDiagnostics,
} from './runtime-diagnostics.js';

const observedAt = '2026-09-01T12:34:56.789Z';

function baseInput() {
  return {
    profile: 'self-hosted',
    health: 'healthy',
    schema: { status: 'ready', migrations: 'current' },
    capabilities: {
      'asset-storage': 'available',
      authentication: 'available',
      'background-jobs': 'available',
      database: 'available',
      'paid-capabilities': 'disabled',
      'secret-storage': 'available',
    },
    toolNames: [
      'smrt.items.read',
      'smrt.runtime.diagnostics.read',
      'smrt.items.read',
    ],
    worker: {
      topology: 'external',
      required: true,
      heartbeatAt: '2026-09-01T12:34:21.123Z',
    },
    recentErrors: [],
    observedAt,
  };
}

describe('public runtime diagnostics projection', () => {
  it('projects a deterministic schemaVersion 1 allowlist with canonical tools', () => {
    const first = projectRuntimeDiagnostics(baseInput());
    const second = projectRuntimeDiagnostics(baseInput());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      profile: 'self-hosted',
      health: 'healthy',
      schema: { status: 'ready', migrations: 'current' },
      tools: {
        names: ['smrt.items.read', 'smrt.runtime.diagnostics.read'],
        count: 2,
      },
      operationalDifferences: {
        backgroundJobs: 'enabled',
        workerTopology: 'external',
      },
      worker: {
        topology: 'external',
        liveness: 'alive',
        heartbeatAt: '2026-09-01T12:34:00.000Z',
        observedAt: '2026-09-01T12:34:00.000Z',
      },
    });
    expect(first.tools.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.capabilities.map(({ id }) => id)).toEqual([
      'asset-storage',
      'authentication',
      'background-jobs',
      'database',
      'paid-capabilities',
      'secret-storage',
    ]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.tools.names)).toBe(true);
  });

  it('uses only the worker heartbeat seam and distinguishes missing and stale workers', () => {
    const missing = projectRuntimeDiagnostics({
      ...baseInput(),
      worker: { topology: 'external', required: true },
    });
    expect(missing.worker).toMatchObject({
      liveness: 'unknown',
      heartbeatAt: null,
    });

    const stale = projectRuntimeDiagnostics({
      ...baseInput(),
      worker: {
        topology: 'scalable',
        required: true,
        heartbeatAt: '2026-09-01T12:30:59.999Z',
      },
    });
    expect(stale.worker).toMatchObject({
      topology: 'scalable',
      liveness: 'stale',
      heartbeatAt: '2026-09-01T12:30:00.000Z',
    });

    const truncatedBoundary = projectRuntimeDiagnostics({
      ...baseInput(),
      observedAt: '2026-09-01T12:34:59.000Z',
      worker: {
        topology: 'external',
        required: true,
        heartbeatAt: '2026-09-01T12:32:01.000Z',
      },
    });
    expect(truncatedBoundary.worker).toMatchObject({
      liveness: 'stale',
      heartbeatAt: '2026-09-01T12:32:00.000Z',
      observedAt: '2026-09-01T12:34:00.000Z',
    });

    const webOnly = projectRuntimeDiagnostics({
      ...baseInput(),
      worker: {
        topology: 'external',
        required: true,
        webProcessAlive: true,
      },
    });
    expect(webOnly.worker.liveness).toBe('unknown');

    const inline = projectRuntimeDiagnostics({
      ...baseInput(),
      worker: { topology: 'inline', required: false },
    });
    expect(inline.worker.liveness).toBe('not-required');
  });

  it('caps recent errors, sorts them, and maps unknown codes to a generic code', () => {
    const recentErrors = Array.from(
      { length: MAX_RUNTIME_DIAGNOSTIC_ERRORS + 5 },
      (_, index) => ({
        code: index === 0 ? 'database_unavailable' : `private-${index}`,
        at: new Date(Date.parse(observedAt) - index * 60_000).toISOString(),
        message: `raw provider failure ${index}`,
        stack: `/Users/person/private-${index}.ts`,
      }),
    );
    const projected = projectRuntimeDiagnostics({
      ...baseInput(),
      recentErrors,
    });

    expect(projected.recentErrors).toHaveLength(MAX_RUNTIME_DIAGNOSTIC_ERRORS);
    expect(projected.recentErrors[0]).toEqual({
      code: 'database_unavailable',
      at: '2026-09-01T12:34:00.000Z',
    });
    expect(projected.recentErrors[1]?.code).toBe('runtime_error');
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('raw provider failure');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('private-');
  });

  it('omits the prohibited-key corpus and rejects unsafe tool identifiers', () => {
    const prohibited = {
      credentials: { password: 'correct horse battery staple' },
      token: 'bearer-private-value',
      token_hash: 'sha256-private-value',
      databaseUrl: 'postgresql://private.example/db',
      homePath: '/Users/alice/private-app',
      email: 'alice@example.test',
      stack: 'Error: private\n at /Users/alice/source.ts:1:1',
      logs: ['raw private event'],
      records: [{ id: 'private-record', payload: { nested: true } }],
      constructor: { prototype: { polluted: true } },
      prototype: { polluted: true },
      oversized: 'x'.repeat(200_000),
      nested: { one: { two: { three: { secret: 'deep-private' } } } },
    };
    const input = {
      ...baseInput(),
      ...prohibited,
      toolNames: [
        'smrt.runtime.diagnostics.read',
        'smrt.session.read',
        'smrt.token.read',
        'smrt.database-url.read',
        'smrt.raw-logs.read',
        '__proto__',
        'constructor.prototype',
        'https://private.example/tool',
        'x'.repeat(81),
        { name: 'smrt.hidden.read', secret: 'private' },
      ],
      schema: {
        status: 'ready',
        migrations: 'current',
        ...prohibited,
      },
      capabilities: {
        database: 'available',
        ...prohibited,
      },
      recentErrors: [
        {
          code: 'private_stack_code',
          at: observedAt,
          ...prohibited,
        },
      ],
    };

    const projected = projectRuntimeDiagnostics(input);
    expect(projected.tools.names).toEqual(['smrt.runtime.diagnostics.read']);
    const serialized = JSON.stringify(projected);
    for (const prohibitedValue of [
      'correct horse',
      'bearer-private',
      'sha256-private',
      'postgresql://',
      '/Users/',
      'alice@example',
      'raw private',
      'private-record',
      'deep-private',
      'polluted',
    ]) {
      expect(serialized).not.toContain(prohibitedValue);
    }
    for (const prohibitedKey of [
      'credentials',
      'token',
      'hash',
      'databaseUrl',
      'homePath',
      'email',
      'stack',
      'logs',
      'records',
      'prototype',
      'oversized',
      'nested',
    ]) {
      expect(serialized).not.toContain(`"${prohibitedKey}"`);
    }
    expect(projected.recentErrors).toEqual([
      { code: 'runtime_error', at: '2026-09-01T12:34:00.000Z' },
    ]);
  });

  it('bounds tool inventory and fails closed around accessor/proxy traps', () => {
    const toolNames = Array.from(
      { length: MAX_RUNTIME_DIAGNOSTIC_TOOLS * 5 },
      (_, index) => `smrt.public-tool-${index}.read`,
    );
    const projected = projectRuntimeDiagnostics({
      ...baseInput(),
      toolNames,
    });
    expect(projected.tools.names).toHaveLength(MAX_RUNTIME_DIAGNOSTIC_TOOLS);

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private proxy detail');
        },
      },
    );
    expect(() => projectRuntimeDiagnostics(hostile)).not.toThrow();
    expect(projectRuntimeDiagnostics(hostile)).toMatchObject({
      schemaVersion: 1,
      tools: { names: [] },
      recentErrors: [],
    });

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const throwingArray = new Proxy([], {
      get(_target, property) {
        if (property === 'length') throw new Error('private length');
        return undefined;
      },
    });
    const throwingDescriptor = new Proxy(
      {},
      {
        getPrototypeOf() {
          return Object.prototype;
        },
        getOwnPropertyDescriptor() {
          throw new Error('private descriptor');
        },
      },
    );
    expect(() => projectRuntimeDiagnostics(throwingDescriptor)).not.toThrow();
    expect(() =>
      projectRuntimeDiagnostics({
        toolNames: revoked.proxy,
        recentErrors: throwingArray,
        observedAt: '2026-09-01T12:34:56Z',
      }),
    ).not.toThrow();
    expect(
      projectRuntimeDiagnostics({
        toolNames: revoked.proxy,
        recentErrors: throwingArray,
        observedAt: '2026-09-01T12:34:56Z',
      }),
    ).toMatchObject({
      profile: 'unknown',
      tools: { names: [] },
      recentErrors: [],
    });
  });
});
