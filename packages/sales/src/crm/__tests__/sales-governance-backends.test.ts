/** Unsupported databases are refused before opening a connection or invoking policy. */
import { expect, it, vi } from 'vitest';
import { SalesGovernanceService } from '../services/SalesGovernanceService.js';
import type { SalesGovernanceHost } from '../services/sales-governance-types.js';

it.each([
  null,
  undefined,
  {},
  { type: 'duckdb', url: ':memory:' },
  { type: 'sqlite', url: ':memory:' },
  { type: 'pglite' },
  { type: 'unknown' },
])('rejects unsupported configuration before any I/O: %j', async (database) => {
  const sql = await import('@happyvertical/sql');
  const open = vi.spyOn(sql, 'getDatabase');
  const predicate = vi.fn(async () => true);
  const host: SalesGovernanceHost = {
    isMember: predicate,
    isUnsuspended: predicate,
    canSell: predicate,
    canApprove: predicate,
    advertiserExists: predicate,
    validateQuote: predicate,
    policy: vi.fn(async () => ({
      version: 'v1',
      maxDiscountBps: 1000,
      leaseDurationMs: 1000,
      approvalDurationMs: 1000,
    })),
  };
  try {
    // @ts-expect-error intentionally malformed runtime input, never trusted host config
    await expect(
      SalesGovernanceService.create({ database, host }),
    ).rejects.toThrow('unsupported_backend');
    expect(open).not.toHaveBeenCalled();
    expect(predicate).not.toHaveBeenCalled();
    expect(host.policy).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
});

it('rejects adapter-shaped and schema-creating configuration before opening', async () => {
  const sql = await import('@happyvertical/sql');
  const open = vi.spyOn(sql, 'getDatabase');
  try {
    for (const database of [
      { type: 'postgres', url: 'postgres://unused', query() {} },
      { type: 'postgres', url: 'postgres://unused', cache: true },
      { type: 'postgres', url: 'postgres://unused', schemas: {} },
    ]) {
      // @ts-expect-error intentional untrusted configuration, no host needed before refusal
      await expect(SalesGovernanceService.create({ database })).rejects.toThrow(
        'invalid_database_configuration',
      );
    }
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
});
