/**
 * Regression tests for the tenant-global query helpers (#1600) in smrt-facts.
 *
 * Fact / FactContent / FactSource / FactSubject / FactTag are all
 * `@TenantScoped({ mode: 'optional' })` with a nullable `tenantId`. Their
 * collections used to expose:
 *   findGlobal()          → list({ where: { tenantId: null } })
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
 * `packages/ledgers/src/__tests__/ledgers-tenant-isolation.test.ts`.
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
import { FactContentCollection } from '../fact-contents';
import { FactSourceCollection } from '../fact-sources';
import { FactSubjectCollection } from '../fact-subjects';
import { FactTagCollection } from '../fact-tags';
import { FactCollection } from '../facts';

const sorted = (rows: Array<Record<string, any>>, field: string): string[] =>
  rows.map((r) => String(r[field] ?? '')).sort();

describe('facts tenant isolation (#1600)', () => {
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

  it('FactCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const facts = await FactCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await facts.create({
          textRefined: 't1-fact',
          type: 'assertion',
          status: 'active',
        })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await facts.create({
          textRefined: 't2-fact',
          type: 'assertion',
          status: 'active',
        })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await facts.create({
          textRefined: 'g-fact',
          type: 'assertion',
          status: 'active',
        })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => facts.findGlobal()),
        'textRefined',
      ),
    ).toEqual(['g-fact']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          facts.findWithGlobals('tenant-1'),
        ),
        'textRefined',
      ),
    ).toEqual(['g-fact', 't1-fact']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        facts.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => facts.findWithGlobals('tenant-2')),
        'textRefined',
      ),
    ).toEqual(['g-fact', 't2-fact']);
  });

  it('FactContentCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const links = await FactContentCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await links.create({
          factId: 't1-link',
          contentId: 'content-1',
          relationship: 'extracted_from',
        })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await links.create({
          factId: 't2-link',
          contentId: 'content-2',
          relationship: 'extracted_from',
        })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await links.create({
          factId: 'g-link',
          contentId: 'content-g',
          relationship: 'extracted_from',
        })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => links.findGlobal()),
        'factId',
      ),
    ).toEqual(['g-link']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          links.findWithGlobals('tenant-1'),
        ),
        'factId',
      ),
    ).toEqual(['g-link', 't1-link']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        links.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => links.findWithGlobals('tenant-2')),
        'factId',
      ),
    ).toEqual(['g-link', 't2-link']);
  });

  it('FactSourceCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const sources = await FactSourceCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await sources.create({ factId: 'f1', sourceTitle: 't1-source' })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await sources.create({ factId: 'f2', sourceTitle: 't2-source' })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await sources.create({ factId: 'fg', sourceTitle: 'g-source' })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => sources.findGlobal()),
        'sourceTitle',
      ),
    ).toEqual(['g-source']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          sources.findWithGlobals('tenant-1'),
        ),
        'sourceTitle',
      ),
    ).toEqual(['g-source', 't1-source']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        sources.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => sources.findWithGlobals('tenant-2')),
        'sourceTitle',
      ),
    ).toEqual(['g-source', 't2-source']);
  });

  it('FactSubjectCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const subjects = await FactSubjectCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (
        await subjects.create({
          factId: 'f1',
          entityType: 'Profile',
          entityId: 't1-subject',
        })
      ).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (
        await subjects.create({
          factId: 'f2',
          entityType: 'Profile',
          entityId: 't2-subject',
        })
      ).save();
    });
    await withSystemContext(async () => {
      await (
        await subjects.create({
          factId: 'fg',
          entityType: 'Profile',
          entityId: 'g-subject',
        })
      ).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => subjects.findGlobal()),
        'entityId',
      ),
    ).toEqual(['g-subject']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          subjects.findWithGlobals('tenant-1'),
        ),
        'entityId',
      ),
    ).toEqual(['g-subject', 't1-subject']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        subjects.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => subjects.findWithGlobals('tenant-2')),
        'entityId',
      ),
    ).toEqual(['g-subject', 't2-subject']);
  });

  it('FactTagCollection.findGlobal/findWithGlobals do not throw and stay tenant-scoped', async () => {
    const tags = await FactTagCollection.create({ db });
    await withTenant({ tenantId: 'tenant-1' }, async () => {
      await (await tags.create({ factId: 'f1', tagSlug: 't1-tag' })).save();
    });
    await withTenant({ tenantId: 'tenant-2' }, async () => {
      await (await tags.create({ factId: 'f2', tagSlug: 't2-tag' })).save();
    });
    await withSystemContext(async () => {
      await (await tags.create({ factId: 'fg', tagSlug: 'g-tag' })).save();
    });

    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () => tags.findGlobal()),
        'tagSlug',
      ),
    ).toEqual(['g-tag']);
    expect(
      sorted(
        await withTenant({ tenantId: 'tenant-1' }, () =>
          tags.findWithGlobals('tenant-1'),
        ),
        'tagSlug',
      ),
    ).toEqual(['g-tag', 't1-tag']);
    await expect(
      withTenant({ tenantId: 'tenant-1' }, () =>
        tags.findWithGlobals('tenant-2'),
      ),
    ).rejects.toThrow(/isolation/i);
    expect(
      sorted(
        await withSystemContext(() => tags.findWithGlobals('tenant-2')),
        'tagSlug',
      ),
    ).toEqual(['g-tag', 't2-tag']);
  });
});
