/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-ledgers.
 *
 * Account / Journal / JournalEntry are all `@TenantScoped({ mode: 'optional' })`
 * (CTI, own tables). Their collections used to expose:
 *   findGlobal()         → list({ where: { tenantId: null } })
 *   findWithGlobals(tid)  → raw `WHERE tenant_id = ? OR tenant_id IS NULL`
 * Under an ACTIVE tenant context with tenancy enabled (default `'throw'`
 * policy) BOTH throw: the explicit `tenant_id IS NULL` filter is flagged as an
 * isolation violation, and unflagged raw SQL on a tenant-scoped class is
 * blocked. `findWithGlobals` also trusted its caller-supplied `tenantId`.
 *
 * They now route through the shared `@happyvertical/smrt-tenancy` helpers, which
 * run raw with `{ allowRawOnTenantScoped: true }` and fail closed when an active
 * tenant context requests another tenant's rows (admin/system path keeps the
 * cross-tenant capability). Mirrors
 * `packages/messages/src/__tests__/messages-tenant-isolation.test.ts`.
 *
 * Real in-memory SQLite, no DB mocking, tenancy enabled under the default
 * `'throw'` policy, per `.claude/rules/testing.md`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountCollection } from '../collections/Accounts';
import { JournalEntryCollection } from '../collections/JournalEntries';
import { JournalCollection } from '../collections/Journals';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('ledgers tenant isolation (#1600)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy(); // default rawQueryPolicy: 'throw'
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('AccountCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const accounts = await AccountCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await accounts.create({ number: '1000', name: 't1-acct' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await accounts.create({ number: '2000', name: 't2-acct' })).save();
    });
    await withSystemContext(async () => {
      await (await accounts.create({ number: '9000', name: 'g-acct' })).save();
    });

    // findGlobal under an active tenant returns ONLY globals (no throw).
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => accounts.findGlobal()),
        'name',
      ),
    ).toEqual(['g-acct']);

    // findWithGlobals returns the tenant's rows plus globals — never tenant-2's.
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          accounts.findWithGlobals('tenant-1'),
        ),
        'name',
      ),
    ).toEqual(['g-acct', 't1-acct']);

    // Fails closed for a tenant other than the active context.
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        accounts.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);

    // System context keeps the deliberate cross-tenant admin capability.
    expect(
      sorted(
        await withSystemContext(() => accounts.findWithGlobals('tenant-2')),
        'name',
      ),
    ).toEqual(['g-acct', 't2-acct']);
  });

  it('JournalCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const journals = await JournalCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await journals.create({ number: 'JNL-1', description: 't1-jnl' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await journals.create({ number: 'JNL-2', description: 't2-jnl' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await journals.create({ number: 'JNL-G', description: 'g-jnl' })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => journals.findGlobal()),
        'description',
      ),
    ).toEqual(['g-jnl']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          journals.findWithGlobals('tenant-1'),
        ),
        'description',
      ),
    ).toEqual(['g-jnl', 't1-jnl']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        journals.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => journals.findWithGlobals('tenant-2')),
        'description',
      ),
    ).toEqual(['g-jnl', 't2-jnl']);
  });

  it('JournalEntryCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const entries = await JournalEntryCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await entries.create({ journalId: 'j1', debit: 10, memo: 't1-entry' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await entries.create({ journalId: 'j2', debit: 20, memo: 't2-entry' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await entries.create({ journalId: 'jg', debit: 30, memo: 'g-entry' })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => entries.findGlobal()),
        'memo',
      ),
    ).toEqual(['g-entry']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          entries.findWithGlobals('tenant-1'),
        ),
        'memo',
      ),
    ).toEqual(['g-entry', 't1-entry']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        entries.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => entries.findWithGlobals('tenant-2')),
        'memo',
      ),
    ).toEqual(['g-entry', 't2-entry']);
  });
});
