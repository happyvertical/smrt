/**
 * `runOnce()` idempotency-seam tests (#3080).
 *
 * Uses real in-memory SQLite via `getTestDatabase()` — no DB mocking except
 * where a scenario is architecturally unreachable through the transaction
 * semantics `@happyvertical/sql`'s single-connection adapters guarantee (see
 * `../run-once.ts` module doc): those two branches are exercised by seeding
 * the claim table directly, or by calling the pure resolver function.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunOnceClaimError } from '../errors';
import {
  deriveRunOnceClaimKey,
  digestRunOnceContent,
  RUN_ONCE_CLAIMS_TABLE,
  resolveExistingRunOnceClaim,
  runOnce,
} from '../run-once';
import { getTestDatabase } from '../testing/database';

describe('runOnce (#3080)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    // No `@smrt()` model tables are needed — runOnce() only touches the
    // hand-DDL `_smrt_run_once_claims` system table, which getTestDatabase()
    // always creates. `classes: []` opts out of its "did you forget to
    // register a class" warning.
    db = await getTestDatabase({ classes: [] });
  });

  const baseParams = (overrides: Partial<Record<string, unknown>> = {}) => ({
    db,
    tenantId: 'tenant-a',
    actor: 'user-1',
    token: 'form-token-1',
    content: { amount: 100, sku: 'widget-1' },
    ...overrides,
  });

  it('runs the work exactly once and returns its result', async () => {
    const work = vi.fn(async () => ({ id: 'po-1' }));
    const result = await runOnce(baseParams(), work);
    expect(result).toEqual({ id: 'po-1' });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('retry after completion returns the original stored result without re-running', async () => {
    const work = vi.fn(async () => ({ id: 'po-1' }));
    const first = await runOnce(baseParams(), work);
    const second = await runOnce(baseParams(), work);
    expect(second).toEqual(first);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('concurrent double submit produces one row and the same id for both callers', async () => {
    let created = 0;
    const work = vi.fn(async () => {
      created += 1;
      return { id: `po-${created}` };
    });

    const [r1, r2] = await Promise.all([
      runOnce(baseParams(), work),
      runOnce(baseParams(), work),
    ]);

    expect(r1).toEqual(r2);
    expect(work).toHaveBeenCalledTimes(1);

    const rows = await db.query(
      `SELECT claim_key FROM ${RUN_ONCE_CLAIMS_TABLE}`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('same token but different content runs as two separate claims', async () => {
    const workA = vi.fn(async () => ({ sku: 'a' }));
    const workB = vi.fn(async () => ({ sku: 'b' }));

    const r1 = await runOnce(baseParams({ content: { sku: 'a' } }), workA);
    const r2 = await runOnce(baseParams({ content: { sku: 'b' } }), workB);

    expect(r1).toEqual({ sku: 'a' });
    expect(r2).toEqual({ sku: 'b' });
    expect(workA).toHaveBeenCalledTimes(1);
    expect(workB).toHaveBeenCalledTimes(1);
  });

  it('same token and content, different actor, runs as a separate claim', async () => {
    const work = vi.fn(async () => ({ ran: true }));
    await runOnce(baseParams({ actor: 'user-1' }), work);
    await runOnce(baseParams({ actor: 'user-2' }), work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('same token and content, different tenant, runs as a separate claim', async () => {
    const work = vi.fn(async () => ({ ran: true }));
    await runOnce(baseParams({ tenantId: 'tenant-a' }), work);
    await runOnce(baseParams({ tenantId: 'tenant-b' }), work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('propagates a work failure and rolls back the claim so a retry can run again', async () => {
    let attempt = 0;
    const work = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('boom');
      }
      return { id: 'po-recovered' };
    });

    await expect(runOnce(baseParams(), work)).rejects.toThrow('boom');

    const rows = await db.query(
      `SELECT claim_key FROM ${RUN_ONCE_CLAIMS_TABLE}`,
    );
    expect(rows.rows).toHaveLength(0);

    const result = await runOnce(baseParams(), work);
    expect(result).toEqual({ id: 'po-recovered' });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('rejects with RunOnceClaimError.inFlight when a claim is held but not completed', async () => {
    const contentDigest = digestRunOnceContent(baseParams().content);
    const claimKey = deriveRunOnceClaimKey({
      tenantId: 'tenant-a',
      actor: 'user-1',
      token: 'form-token-1',
      contentDigest,
    });
    await db.insert(RUN_ONCE_CLAIMS_TABLE, {
      claim_key: claimKey,
      tenant_id: 'tenant-a',
      actor: 'user-1',
      content_digest: contentDigest,
      status: 'in_progress',
      result: null,
      created_at: new Date(),
    });

    const work = vi.fn(async () => ({ id: 'never' }));
    const error = await runOnce(baseParams(), work).then(
      () => null,
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(RunOnceClaimError);
    expect((error as RunOnceClaimError).code).toBe('RUN_ONCE_IN_FLIGHT');
    expect((error as RunOnceClaimError).claimKey).toBe(claimKey);
    expect(work).not.toHaveBeenCalled();
  });

  it('produces a stable content digest regardless of key order', () => {
    const a = digestRunOnceContent({ amount: 100, sku: 'widget-1' });
    const b = digestRunOnceContent({ sku: 'widget-1', amount: 100 });
    expect(a).toBe(b);
  });

  it('produces a different content digest when content actually differs', () => {
    const a = digestRunOnceContent({ amount: 100, sku: 'widget-1' });
    const b = digestRunOnceContent({ amount: 200, sku: 'widget-1' });
    expect(a).not.toBe(b);
  });

  describe('non-plain content (#3136)', () => {
    function form(entries: Array<[string, string]>): FormData {
      const data = new FormData();
      for (const [key, value] of entries) data.append(key, value);
      return data;
    }

    it('digests FormData by its entries, not as {}', () => {
      const a = digestRunOnceContent(form([['sku', 'widget-1']]));
      const b = digestRunOnceContent(form([['sku', 'widget-2']]));
      expect(a).not.toBe(b);
      expect(a).not.toBe(digestRunOnceContent({}));
      expect(digestRunOnceContent(form([['sku', 'widget-1']]))).toBe(a);
    });

    it('treats repeated FormData fields as significant', () => {
      const one = digestRunOnceContent(form([['line', 'a']]));
      const two = digestRunOnceContent(
        form([
          ['line', 'a'],
          ['line', 'b'],
        ]),
      );
      expect(one).not.toBe(two);
    });

    it('digests a FormData file by name, type and size', () => {
      const withFile = (name: string) => {
        const data = new FormData();
        data.append('upload', new File(['abc'], name, { type: 'text/plain' }));
        return digestRunOnceContent(data);
      };
      expect(withFile('a.txt')).not.toBe(withFile('b.txt'));
      expect(withFile('a.txt')).toBe(withFile('a.txt'));
    });

    it('rejects values JSON would reduce to {}', () => {
      expect(() => digestRunOnceContent(new Map([['a', 1]]))).toThrow(
        TypeError,
      );
      expect(() => digestRunOnceContent({ lines: new Set([1]) })).toThrow(
        TypeError,
      );
      expect(() => digestRunOnceContent({ n: 1n })).toThrow(TypeError);
    });
  });

  it('produces a different content digest when only a Date differs', () => {
    const a = digestRunOnceContent({
      due: new Date('2026-09-01T00:00:00Z'),
      sku: 'widget-1',
    });
    const b = digestRunOnceContent({
      due: new Date('2026-10-01T00:00:00Z'),
      sku: 'widget-1',
    });
    expect(a).not.toBe(b);
  });

  it('does not collide with {} for content carrying an own "__proto__" key', () => {
    // JSON.parse() creates "__proto__" as a genuine own enumerable property
    // (never as the prototype), so this is realistic attacker- or
    // client-supplied content, not a contrived object literal. The shared
    // `stableStringify()` (knowledge-graph.ts) used to sort keys into a
    // plain `{}` target, where assigning the key "__proto__" through bracket
    // notation invokes Object.prototype's accessor instead of creating an
    // own property — silently dropping the key and digesting this content
    // identically to an empty object.
    const withProtoKey = digestRunOnceContent(
      JSON.parse('{"__proto__":{"a":1}}'),
    );
    const empty = digestRunOnceContent({});
    expect(withProtoKey).not.toBe(empty);
  });

  describe('resolveExistingRunOnceClaim (pure resolver)', () => {
    it('returns the parsed result for a completed claim', () => {
      const result = resolveExistingRunOnceClaim(
        {
          claim_key: 'k',
          status: 'completed',
          result: JSON.stringify({ id: 'po-1' }),
        },
        'k',
      );
      expect(result).toEqual({ id: 'po-1' });
    });

    it('throws RunOnceClaimError.inFlight for a non-completed claim', () => {
      expect(() =>
        resolveExistingRunOnceClaim(
          { claim_key: 'k', status: 'in_progress', result: null },
          'k',
        ),
      ).toThrow(RunOnceClaimError);
      try {
        resolveExistingRunOnceClaim(
          { claim_key: 'k', status: 'in_progress', result: null },
          'k',
        );
      } catch (error) {
        expect((error as RunOnceClaimError).code).toBe('RUN_ONCE_IN_FLIGHT');
      }
    });

    it('throws RunOnceClaimError.outcomeUnknown when no row can be read back', () => {
      expect(() => resolveExistingRunOnceClaim(null, 'k')).toThrow(
        RunOnceClaimError,
      );
      try {
        resolveExistingRunOnceClaim(null, 'k');
      } catch (error) {
        expect((error as RunOnceClaimError).code).toBe(
          'RUN_ONCE_OUTCOME_UNKNOWN',
        );
      }
    });
  });
});
