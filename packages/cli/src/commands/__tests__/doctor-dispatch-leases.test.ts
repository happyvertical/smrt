/**
 * `smrt doctor --db`, the dispatch lease section (P6 T39): core's
 * `inspectDispatchLeases()` against a real SQLite database, and the lines
 * the doctor prints.
 */

import { createDispatchBus } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatDispatchLeaseCheck,
  runDispatchLeaseCheck,
} from '../doctor-dispatch-leases.js';

const TENANT = '0f1e2d3c-0000-4000-8000-00000000000a';

describe('doctor dispatch leases', () => {
  let db: DatabaseInterface | undefined;

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  async function insert(row: {
    id: string;
    type?: string;
    status: string;
    leaseToken?: string | null;
    claimedUntil?: string | null;
    updatedAt?: string;
    tenantId?: string | null;
  }) {
    await db?.query(
      `INSERT INTO _smrt_dispatch
         (id, type, source, payload, status, attempts, lease_token, claimed_until,
          tenant_id, metadata, created_at, updated_at)
       VALUES ($1, $2, 'test', '{}', $3, 1, $4, $5, $6, '{}', $7, $8)`,
      row.id,
      row.type ?? 'job.run',
      row.status,
      row.leaseToken ?? null,
      row.claimedUntil ?? null,
      row.tenantId ?? null,
      row.updatedAt ?? new Date().toISOString(),
      row.updatedAt ?? new Date().toISOString(),
    );
  }

  it('reports NULL-lease processing rows, long and expired leases, and tenant-correct unrouted counts', async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const bus = await createDispatchBus({ db });
    await bus.subscribe({ signalType: 'job.*', subscriber: 'worker' });
    await db.query(
      `UPDATE _smrt_dispatch_subscriptions SET tenant_id = $1`,
      TENANT,
    );
    await bus.subscribe({ signalType: 'mail.*', subscriber: 'mailer' });

    const clean = await runDispatchLeaseCheck({ db, typeHint: 'sqlite' });
    expect(clean.check).toEqual({
      legacyProcessing: 0,
      leasedProcessing: 0,
      expiredLeases: 0,
      longLeases: 0,
      unrouted: 0,
    });
    expect(formatDispatchLeaseCheck(clean.check!).join('\n')).toContain(
      'Leased processing rows: 0',
    );

    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    await insert({ id: 'legacy', status: 'processing', updatedAt: hourAgo });
    await insert({
      id: 'long',
      status: 'processing',
      leaseToken: 'a',
      claimedUntil: inAnHour,
      updatedAt: hourAgo,
      tenantId: TENANT,
    });
    await insert({
      id: 'expired',
      status: 'processing',
      leaseToken: 'b',
      claimedUntil: hourAgo,
    });
    // A tenant row only a global subscription matches: unrouted.
    await insert({
      id: 'tenant-mail',
      type: 'mail.send',
      status: 'pending',
      tenantId: TENANT,
    });
    await insert({ id: 'nobody', type: 'nobody.listens', status: 'pending' });

    const flagged = await runDispatchLeaseCheck({ db, typeHint: 'sqlite' });
    expect(flagged.check).toEqual({
      legacyProcessing: 1,
      leasedProcessing: 2,
      expiredLeases: 1,
      longLeases: 1,
      unrouted: 2,
    });
    const lines = formatDispatchLeaseCheck(flagged.check!).join('\n');
    expect(lines).toContain('release-leases');
  });

  it('skips a database without dispatch tables', async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const outcome = await runDispatchLeaseCheck({ db, typeHint: 'sqlite' });
    expect(outcome).toEqual({
      check: null,
      error: null,
      skipped: 'no dispatch tables',
    });
  });

  it('reports a failure without throwing', async () => {
    // The tables answer an existence probe, then the counts fail.
    const broken = {
      query: async (sql: string) => {
        if (sql.startsWith('SELECT 1 FROM')) return { rows: [] };
        throw new Error('connection refused');
      },
    } as unknown as DatabaseInterface;
    const outcome = await runDispatchLeaseCheck({
      db: broken,
      typeHint: 'sqlite',
    });
    expect(outcome.check).toBeNull();
    expect(outcome.error).toContain('connection refused');
  });
});
