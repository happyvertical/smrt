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
