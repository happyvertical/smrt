/** PostgreSQL proofs for atomic, idempotent referral-click recording. */

import { randomUUID } from 'node:crypto';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ReferralClickReplayConflictError,
  ReferralLinkCollection,
} from '../collections/ReferralLinkCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferralTouchCollection } from '../collections/ReferralTouchCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';
import type { ReferralLink } from '../models/ReferralLink.js';

interface TransactionDatabase extends DatabaseInterface {
  transaction<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('ReferralLinkCollection.recordClick on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: TransactionDatabase;
  let links: ReferralLinkCollection;
  let touches: ReferralTouchCollection;
  let referrers: ReferrerCollection;
  let programs: ReferralProgramCollection;

  beforeEach(async () => {
    enableTenancy();
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Referrer',
        'ReferralProgram',
        'ReferralLink',
        'ReferralTouch',
        'ReferralClickOperation',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    db = isolated.baseDb as TransactionDatabase;
    if (typeof db.transaction !== 'function') {
      throw new Error('PostgreSQL test database must expose transaction()');
    }
    links = await ReferralLinkCollection.create({ db });
    touches = await ReferralTouchCollection.create({ db });
    referrers = await ReferrerCollection.create({ db });
    programs = await ReferralProgramCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  async function createLink(
    tenantId: string,
    targetUrl = 'https://example.test/referral',
  ): Promise<ReferralLink> {
    return await withTenant({ tenantId }, async () => {
      const referrer = await referrers.create({
        profileId: randomUUID(),
        displayName: `PG referrer ${tenantId}`,
        status: 'active',
      });
      const program = await programs.create({
        key: `program-${randomUUID()}`,
        name: 'PostgreSQL referral program',
        status: 'active',
      });
      return await links.createWithUniqueCode({
        referrerId: referrer.id as string,
        programId: program.id as string,
        targetUrl,
      });
    });
  }

  it('commits once, replays the same touch, and conflicts on changed evidence or link intent', async () => {
    const tenantId = randomUUID();
    const link = await createLink(tenantId);
    const other = await createLink(tenantId, 'https://example.test/other');
    const idempotencyKey = `pg-click-${randomUUID()}`;
    const occurredAt = new Date('2026-07-17T20:00:00.000Z');

    const first = await withTenant({ tenantId }, () =>
      links.recordClick({
        code: link.code,
        idempotencyKey,
        occurredAt,
        subjectKind: 'lead',
        subjectId: randomUUID(),
        evidence: { source: 'postgres', nested: { b: 2, a: 1 } },
      }),
    );
    const replay = await withTenant({ tenantId }, () =>
      links.recordClick({
        code: link.code.toUpperCase(),
        idempotencyKey,
        occurredAt,
        subjectKind: first.touch?.subjectKind,
        subjectId: first.touch?.subjectId,
        evidence: { nested: { a: 1, b: 2 }, source: 'postgres' },
      }),
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.touch?.id).toBe(first.touch?.id);
    expect(replay.link?.clickCount).toBe(1);
    expect((first.link as unknown as { db: DatabaseInterface }).db).toBe(db);
    expect((first.touch as unknown as { db: DatabaseInterface }).db).toBe(db);
    expect((replay.link as unknown as { db: DatabaseInterface }).db).toBe(db);
    expect((replay.touch as unknown as { db: DatabaseInterface }).db).toBe(db);
    if (!replay.link) throw new Error('Expected replay link');
    replay.link.label = 'usable after transaction commit';
    await replay.link.save();
    await withTenant({ tenantId }, async () => {
      expect(await touches.findByReferrer(link.referrerId)).toHaveLength(1);
    });

    await expect(
      withTenant({ tenantId }, () =>
        links.recordClick({
          code: link.code,
          idempotencyKey,
          occurredAt,
          subjectKind: first.touch?.subjectKind,
          subjectId: first.touch?.subjectId,
          evidence: { source: 'changed' },
        }),
      ),
    ).rejects.toMatchObject<Partial<ReferralClickReplayConflictError>>({
      code: 'REFERRAL_CLICK_REPLAY_CONFLICT',
      mismatches: expect.arrayContaining(['evidence']),
    });
    await expect(
      withTenant({ tenantId }, () =>
        links.recordClick({ code: other.code, idempotencyKey }),
      ),
    ).rejects.toMatchObject<Partial<ReferralClickReplayConflictError>>({
      code: 'REFERRAL_CLICK_REPLAY_CONFLICT',
      mismatches: expect.arrayContaining(['code']),
    });
    expect(
      (await withTenant({ tenantId }, () => links.get({ id: link.id })))
        ?.clickCount,
    ).toBe(1);
    expect(
      (await withTenant({ tenantId }, () => links.get({ id: other.id })))
        ?.clickCount,
    ).toBe(0);
  });

  it('rolls back the operation and touch when the counter write fails', async () => {
    const tenantId = randomUUID();
    const link = await createLink(tenantId);
    const idempotencyKey = `pg-rollback-${randomUUID()}`;
    await db.query(`
      CREATE FUNCTION fail_referral_click_increment() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected click-count failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.query(`
      CREATE TRIGGER fail_referral_click_increment_trigger
      BEFORE UPDATE OF click_count ON referral_links
      FOR EACH ROW EXECUTE FUNCTION fail_referral_click_increment()
    `);

    await expect(
      withTenant({ tenantId }, () =>
        links.recordClick({
          code: link.code,
          idempotencyKey,
          evidence: { failure: 'between logical writes' },
        }),
      ),
    ).rejects.toThrow();

    expect(
      (await withTenant({ tenantId }, () => links.get({ id: link.id })))
        ?.clickCount,
    ).toBe(0);
    await withTenant({ tenantId }, async () => {
      expect(await touches.findByReferrer(link.referrerId)).toHaveLength(0);
    });
    expect(
      await db.list('referral_click_operations', { tenant_id: tenantId }),
    ).toHaveLength(0);

    await db.query(
      'DROP TRIGGER fail_referral_click_increment_trigger ON referral_links',
    );
    await db.query('DROP FUNCTION fail_referral_click_increment()');
    const retry = await withTenant({ tenantId }, () =>
      links.recordClick({
        code: link.code,
        idempotencyKey,
        evidence: { failure: 'between logical writes' },
      }),
    );
    expect(retry.replayed).toBe(false);
    expect(retry.link?.clickCount).toBe(1);
  });

  it('serializes concurrent same-key transactions into one create and one replay', async () => {
    const tenantId = randomUUID();
    const link = await createLink(tenantId);
    const idempotencyKey = `pg-concurrent-${randomUUID()}`;
    const input = {
      code: link.code,
      idempotencyKey,
      occurredAt: new Date('2026-07-17T20:30:00.000Z'),
      evidence: { concurrent: true },
    };

    let ready = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = async () => {
      ready += 1;
      if (ready === 2) release();
      await gate;
      return await withTenant({ tenantId }, async () => {
        const caller = await ReferralLinkCollection.create({ db });
        return await caller.recordClick(input);
      });
    };

    const results = await Promise.all([invoke(), invoke()]);
    expect(results.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(results[0].touch?.id).toBe(results[1].touch?.id);
    expect(
      (await withTenant({ tenantId }, () => links.get({ id: link.id })))
        ?.clickCount,
    ).toBe(1);
    await withTenant({ tenantId }, async () => {
      expect(await touches.findByReferrer(link.referrerId)).toHaveLength(1);
    });
  });

  it('keeps links, touches, and replay keys tenant-isolated', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const linkA = await createLink(tenantA);
    const linkB = await createLink(tenantB);
    const idempotencyKey = `pg-tenant-${randomUUID()}`;

    await withTenant({ tenantId: tenantA }, () =>
      links.recordClick({
        code: linkA.code,
        idempotencyKey,
        evidence: { tenant: 'A' },
      }),
    );
    const hidden = await withTenant({ tenantId: tenantB }, () =>
      links.recordClick({
        code: linkA.code,
        idempotencyKey: `pg-hidden-${randomUUID()}`,
      }),
    );
    expect(hidden).toMatchObject({
      link: null,
      touch: null,
      refused: 'unknown_code',
    });
    await expect(
      withTenant({ tenantId: tenantB }, () =>
        links.recordClick({
          code: linkB.code,
          idempotencyKey,
          evidence: { tenant: 'B' },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'REFERRAL_CLICK_REPLAY_CONFLICT',
      mismatches: ['tenantId'],
    });

    expect(
      (
        await withTenant({ tenantId: tenantA }, () =>
          links.get({ id: linkA.id }),
        )
      )?.clickCount,
    ).toBe(1);
    expect(
      (
        await withTenant({ tenantId: tenantB }, () =>
          links.get({ id: linkB.id }),
        )
      )?.clickCount,
    ).toBe(0);
    await withTenant({ tenantId: tenantB }, async () => {
      expect(await touches.findByReferrer(linkA.referrerId)).toHaveLength(0);
      expect(await touches.findByReferrer(linkB.referrerId)).toHaveLength(0);
    });
  });

  it('enforces the exact final multibyte UTF-8 envelope boundary', async () => {
    const tenantId = randomUUID();
    const link = await createLink(
      tenantId,
      'https://example.test/référence/☕',
    );
    const evidence = { note: 'ééé' };
    const finalEnvelope = JSON.stringify({
      code: link.code,
      linkId: link.id,
      note: evidence.note,
      targetUrl: link.targetUrl,
    });
    const exactBytes = Buffer.byteLength(finalEnvelope, 'utf8');

    const exact = await withTenant({ tenantId }, () =>
      links.recordClick({
        code: link.code,
        idempotencyKey: `pg-boundary-${randomUUID()}`,
        evidence,
        maxEvidenceBytes: exactBytes,
      }),
    );
    expect(exact.touch?.evidence).toBe(finalEnvelope);

    await expect(
      withTenant({ tenantId }, () =>
        links.recordClick({
          code: link.code,
          idempotencyKey: `pg-over-boundary-${randomUUID()}`,
          evidence: { note: `${evidence.note}é` },
          maxEvidenceBytes: exactBytes,
        }),
      ),
    ).rejects.toMatchObject({
      reason: 'evidence_too_large',
      details: { actualBytes: exactBytes + 2, maxBytes: exactBytes },
    });

    const callerOnlyBytes = Buffer.byteLength(JSON.stringify(evidence), 'utf8');
    await expect(
      withTenant({ tenantId }, () =>
        links.recordClick({
          code: link.code,
          idempotencyKey: `pg-final-envelope-${randomUUID()}`,
          evidence,
          maxEvidenceBytes: callerOnlyBytes,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'evidence_too_large' });
    expect(callerOnlyBytes).toBeLessThan(exactBytes);
    expect(
      (await withTenant({ tenantId }, () => links.get({ id: link.id })))
        ?.clickCount,
    ).toBe(1);
  });
});
