/**
 * SupportCase model tests (#1926): the guarded lifecycle state machine,
 * reopen bookkeeping fields, case numbering, and tenant isolation via the
 * tenancy interceptor.
 *
 * Real in-memory SQLite from the generated manifest — the transition guard
 * and unique indexes are exactly what ships.
 */

import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateCaseNumber,
  SupportCase,
  SupportCaseCollection,
} from './support-case.js';

describe('SupportCase', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let cases: SupportCaseCollection;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: ['SupportCase'],
    });
    cases = await SupportCaseCollection.create({ db: ctx.db });
  });

  afterEach(async () => {
    disableTenancy();
    await ctx.cleanup();
  });

  describe('lifecycle transitions', () => {
    it('walks the standard path new → triaged → assigned → in_progress → resolved → closed', async () => {
      const supportCase = await cases.create({
        caseNumber: generateCaseNumber(),
        subject: 'Login broken',
        status: 'new',
      });

      for (const next of [
        'triaged',
        'assigned',
        'in_progress',
        'resolved',
        'closed',
      ] as const) {
        supportCase.status = next;
        await supportCase.save();
        expect(supportCase.status).toBe(next);
      }
    });

    it('rejects an illegal status flip done via raw field assignment', async () => {
      const supportCase = await cases.create({
        caseNumber: generateCaseNumber(),
        subject: 'Billing question',
        status: 'new',
      });
      supportCase.status = 'closed';
      await supportCase.save();

      supportCase.status = 'resolved';
      await expect(supportCase.save()).rejects.toThrow(
        /illegal status transition 'closed' → 'resolved'/,
      );
    });

    it('rejects an illegal flip on an un-hydrated _skipLoad upsert (S5 #1390 idiom)', async () => {
      const supportCase = await cases.create({
        caseNumber: generateCaseNumber(),
        subject: 'Feature request',
        status: 'closed',
      });

      // Fresh instance carrying the existing id via the _skipLoad upsert path
      // — its WeakMap entry is absent, so only the authoritative DB read can
      // catch the illegal closed → resolved flip.
      await expect(
        cases.create({
          id: supportCase.id,
          caseNumber: supportCase.caseNumber,
          subject: supportCase.subject,
          status: 'resolved',
          _skipLoad: true,
        } as never),
      ).rejects.toThrow(/illegal status transition 'closed' → 'resolved'/);

      const reloaded = await cases.get({ id: supportCase.id });
      expect(reloaded?.status).toBe('closed');
    });

    it('supports reopening from resolved and from closed', async () => {
      const supportCase = await cases.create({
        caseNumber: generateCaseNumber(),
        subject: 'Recurring issue',
        status: 'resolved',
      });
      supportCase.status = 'triaged';
      await supportCase.save();
      expect(supportCase.status).toBe('triaged');

      supportCase.status = 'closed';
      await supportCase.save();
      supportCase.status = 'in_progress';
      await supportCase.save();
      expect(supportCase.status).toBe('in_progress');
    });
  });

  describe('helpers', () => {
    it('reports open vs terminal states', async () => {
      const supportCase = new SupportCase({ db: ctx.db });
      supportCase.status = 'in_progress';
      expect(supportCase.isOpen()).toBe(true);
      supportCase.status = 'closed';
      expect(supportCase.isOpen()).toBe(false);
    });

    it('generates distinct, prefixed case numbers', () => {
      const a = generateCaseNumber();
      const b = generateCaseNumber();
      expect(a).toMatch(/^SUP-/);
      expect(a).not.toBe(b);
    });

    it('round-trips metadata and plan snapshots through the JSON helpers', async () => {
      const supportCase = await cases.create({
        caseNumber: generateCaseNumber(),
        subject: 'meta',
      });
      supportCase.updateMetadata({ unresolvedClient: true });
      supportCase.setPlanSnapshot({ planKey: 'gold' });
      await supportCase.save();

      const reloaded = await cases.get({ id: supportCase.id });
      expect(reloaded?.getMetadata()).toEqual({ unresolvedClient: true });
      expect(reloaded?.getPlanSnapshot()).toEqual({ planKey: 'gold' });
    });
  });

  describe('tenant isolation', () => {
    it('scopes queue reads to the active tenant', async () => {
      enableTenancy();
      await withTenant({ tenantId: 'tenant-a' }, async () => {
        await cases.create({
          tenantId: 'tenant-a',
          caseNumber: generateCaseNumber(),
          subject: 'A case',
        });
      });
      await withTenant({ tenantId: 'tenant-b' }, async () => {
        await cases.create({
          tenantId: 'tenant-b',
          caseNumber: generateCaseNumber(),
          subject: 'B case',
        });
      });

      await withTenant({ tenantId: 'tenant-a' }, async () => {
        const visible = await cases.findQueue({ openOnly: true });
        expect(visible).toHaveLength(1);
        expect(visible[0]?.subject).toBe('A case');
      });
    });
  });

  describe('queue and thread lookups', () => {
    it('finds the open case for a thread key but never a closed one', async () => {
      const open = await cases.create({
        caseNumber: generateCaseNumber(),
        subject: 'open one',
        threadKey: 'chat:room-1',
        status: 'in_progress',
      });
      await cases.create({
        caseNumber: generateCaseNumber(),
        subject: 'closed one',
        threadKey: 'chat:room-2',
        status: 'closed',
      });

      expect((await cases.findOpenByThreadKey('chat:room-1'))?.id).toBe(
        open.id,
      );
      expect(await cases.findOpenByThreadKey('chat:room-2')).toBeNull();
    });
  });
});
