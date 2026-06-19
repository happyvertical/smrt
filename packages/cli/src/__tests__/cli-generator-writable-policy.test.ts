/**
 * Regression tests for the generated CLI write-surface guard (S5 audit #1390
 * round 5, codex HIGH#3).
 *
 * The #1540 mass-assignment allowlist (`@smrt({ api: { writable: [...] } })`)
 * was wired into REST/MCP/SvelteKit but NOT the CLI generator, so the generated
 * `create`/`update` commands accepted EVERY field — a framework-wide,
 * CLI-shaped hole. These tests assert `CLIGenerator.applyWritablePolicy()`
 * mirrors `packages/core/src/generators/rest.ts`:
 *
 *  - framework/server-managed fields (`id`, tenant, timestamps) are always
 *    stripped,
 *  - `_`-prefixed and `@field({ readonly: true })` fields are stripped,
 *  - when `api.writable` is set, only those fields survive (so a non-writable
 *    field like `Payment.status` is ignored by the generated CLI create),
 *  - models WITHOUT a writable allowlist keep prior behavior minus framework
 *    fields (consistent with REST).
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';

describe('CLI Generator - api.writable mass-assignment guard (#1390 round 5)', () => {
  let cli: CLIGenerator;

  beforeEach(() => {
    cli = new CLIGenerator({ prompt: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function policy(objectName: string, data: Record<string, unknown>) {
    return (cli as any).applyWritablePolicy(objectName, data);
  }

  it('strips a non-writable field (Payment.status) when api.writable is set', () => {
    // Mirror Payment: writable allowlist that deliberately EXCLUDES `status`.
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
      api: { writable: ['amount', 'currency', 'method'] },
    } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());

    const result = policy('Payment', {
      amount: 199,
      currency: 'USD',
      status: 'completed', // forged settlement proof — must be dropped
    });

    expect(result).toEqual({ amount: 199, currency: 'USD' });
    expect(result).not.toHaveProperty('status');
  });

  it('keeps only allowlisted fields and drops everything else', () => {
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
      api: { writable: ['amount'] },
    } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());

    const result = policy('Payment', {
      amount: 10,
      journalId: 'forged',
      paidAt: '2026-01-01',
      backendId: 'stripe',
    });

    expect(result).toEqual({ amount: 10 });
  });

  it('always strips framework/server-managed fields, even without an allowlist', () => {
    // No api.writable → default behavior, but framework fields still stripped.
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({ api: true } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());

    const result = policy('Widget', {
      id: 'should-not-set',
      tenantId: 'should-not-set',
      tenant_id: 'should-not-set',
      createdAt: 'should-not-set',
      created_at: 'should-not-set',
      updatedAt: 'should-not-set',
      updated_at: 'should-not-set',
      _meta_type: 'should-not-set',
      name: 'keep-me',
    });

    expect(result).toEqual({ name: 'keep-me' });
  });

  it('strips @field({ readonly: true }) fields', () => {
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({ api: true } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      new Map<string, any>([
        ['name', { readonly: false }],
        ['computed', { readonly: true }],
      ]),
    );

    const result = policy('Widget', {
      name: 'keep-me',
      computed: 'drop-me',
    });

    expect(result).toEqual({ name: 'keep-me' });
  });

  it('without a writable allowlist passes through ordinary fields (REST parity)', () => {
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({ api: true } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());

    const result = policy('Widget', {
      name: 'a',
      description: 'b',
      price: 1.5,
    });

    expect(result).toEqual({ name: 'a', description: 'b', price: 1.5 });
  });

  it('returns an empty object for non-object input', () => {
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({ api: true } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());

    expect(policy('Widget', null as any)).toEqual({});
    expect(policy('Widget', undefined as any)).toEqual({});
  });
});

/**
 * Regression tests for the `--from-file` create/update path (#1390 round 6,
 * codex MED). `parseCliArgs` preserves the registered kebab-case option key
 * (`from-file`), but the handler previously read only the camelCase
 * `options.fromFile`. So `--from-file` never fired: the file was never read AND
 * (worse) its contents never reached `applyWritablePolicy` — the round-5
 * mass-assignment guard was a complete no-op on this path. These tests assert
 * the kebab key is now resolved and that file input is writable-policed.
 */
describe('CLI Generator - --from-file input is loaded AND writable-policed (#1390 round 6)', () => {
  let cli: CLIGenerator;
  let tmpFile: string;
  let captured: Record<string, unknown> | undefined;

  beforeEach(async () => {
    cli = new CLIGenerator({ prompt: false });
    captured = undefined;

    // api.writable mirrors Payment: amount/currency writable, status is NOT.
    vi.spyOn(ObjectRegistry, 'getConfig').mockReturnValue({
      api: { writable: ['amount', 'currency'] },
    } as any);
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(new Map());

    // Stub the collection so no DB is needed — capture the policed payload.
    const fakeRow = { id: 'rec-1', save: async () => {} };
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue({
      create: async (data: Record<string, unknown>) => {
        captured = data;
        return { ...fakeRow, ...data };
      },
      get: async () => ({ ...fakeRow }),
    });
    // Silence the spinner.
    vi.spyOn(cli as any, 'createSpinner').mockReturnValue({
      succeed: () => {},
      fail: () => {},
    });

    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    tmpFile = path.join(
      os.tmpdir(),
      `smrt-from-file-${Date.now()}-${Math.random()}.json`,
    );
    await fs.writeFile(
      tmpFile,
      JSON.stringify({ amount: 199, status: 'completed', currency: 'USD' }),
    );
  });

  afterEach(async () => {
    const fs = await import('node:fs/promises');
    try {
      await fs.unlink(tmpFile);
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it('handleCreate reads the kebab-case `from-file` key and drops non-writable fields', async () => {
    // The kebab key is exactly what parseCliArgs produces for `--from-file`.
    await (cli as any).handleCreate('Payment', {
      'from-file': tmpFile,
      quiet: true,
    });

    expect(captured).toBeDefined();
    // amount/currency survived (writable); the forged `status` was stripped —
    // proving the file WAS read AND passed through applyWritablePolicy.
    expect(captured).toEqual({ amount: 199, currency: 'USD' });
    expect(captured).not.toHaveProperty('status');
  });

  it('handleUpdate reads the kebab-case `from-file` key and policies the payload', async () => {
    const existing: Record<string, unknown> = {
      id: 'rec-1',
      amount: 1,
      currency: 'CAD',
      status: 'pending',
      save: async () => {},
    };
    vi.spyOn(cli as any, 'getCollection').mockResolvedValue({
      create: async () => existing,
      get: async () => existing,
    });

    await (cli as any).handleUpdate('Payment', 'rec-1', {
      'from-file': tmpFile,
      quiet: true,
    });

    // The forged `status` from the file must NOT have been applied; the
    // writable fields were. (handleUpdate Object.assign's the policed data.)
    expect(existing.amount).toBe(199);
    expect(existing.currency).toBe('USD');
    expect(existing.status).toBe('pending');
  });

  it('still honors the camelCase `fromFile` key (back-compat)', async () => {
    await (cli as any).handleCreate('Payment', {
      fromFile: tmpFile,
      quiet: true,
    });
    expect(captured).toEqual({ amount: 199, currency: 'USD' });
  });
});
