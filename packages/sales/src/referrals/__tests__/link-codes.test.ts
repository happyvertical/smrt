/**
 * ReferralLink code tests: crypto-random format, uniqueness retry with a
 * capped loop (exercised via the dependency-injected generator seam — no
 * crypto mocking), click recording (counter + immutable touch evidence),
 * disabled/unknown refusals, and target-URL validation.
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateReferralCode,
  MAX_CODE_GENERATION_ATTEMPTS,
  ReferralLinkCollection,
} from '../collections/ReferralLinkCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferralTouchCollection } from '../collections/ReferralTouchCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';

const CODE_PATTERN = /^[a-z0-9]{10}$/;

describe('ReferralLink codes', () => {
  let db: DatabaseInterface;
  let links: ReferralLinkCollection;
  let touches: ReferralTouchCollection;
  let referrerId: string;
  let programId: string;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    links = await ReferralLinkCollection.create({ db });
    touches = await ReferralTouchCollection.create({ db });
    const referrers = await ReferrerCollection.create({ db });
    const programs = await ReferralProgramCollection.create({ db });
    referrerId =
      (
        await referrers.create({
          profileId: 'profile-1',
          displayName: 'Jordan Partner',
          status: 'active',
        })
      ).id ?? '';
    programId =
      (await programs.create({ key: 'partners', name: 'Partner program' }))
        .id ?? '';
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('generates 10-character lowercase-alphanumeric codes', async () => {
    // The pure generator…
    for (let i = 0; i < 25; i++) {
      expect(generateReferralCode()).toMatch(CODE_PATTERN);
    }
    // …and the persisted artifact.
    const link = await links.createWithUniqueCode({ referrerId, programId });
    expect(link.code).toMatch(CODE_PATTERN);
    expect(link.status).toBe('active');
    expect(link.clickCount).toBe(0);
    const found = await links.findByCode(link.code);
    expect(found?.id).toBe(link.id);
  });

  it('retries on code collision via the injected generator seam', async () => {
    // Occupy a code first.
    await links.createWithUniqueCode({
      referrerId,
      programId,
      generateCode: () => 'taken00000',
    });

    // A generator that collides once, then yields a fresh code.
    const sequence = ['taken00000', 'fresh11111'];
    let calls = 0;
    const link = await links.createWithUniqueCode({
      referrerId,
      programId,
      generateCode: () => {
        const code = sequence[Math.min(calls, sequence.length - 1)];
        calls += 1;
        return code;
      },
    });
    expect(calls).toBe(2);
    expect(link.code).toBe('fresh11111');
  });

  it('caps collision retries with a clear error', async () => {
    await links.createWithUniqueCode({
      referrerId,
      programId,
      generateCode: () => 'stuck22222',
    });

    let attempts = 0;
    await expect(
      links.createWithUniqueCode({
        referrerId,
        programId,
        generateCode: () => {
          attempts += 1;
          return 'stuck22222'; // always colliding
        },
      }),
    ).rejects.toThrow(/could not mint a unique code/);
    expect(attempts).toBe(MAX_CODE_GENERATION_ATTEMPTS);
  });

  it('records clicks: increments the counter and writes touch evidence', async () => {
    const link = await links.createWithUniqueCode({
      referrerId,
      programId,
      targetUrl: 'https://example.test/landing',
      label: 'Newsletter footer',
    });
    const occurredAt = new Date('2026-06-01T12:00:00Z');

    const first = await links.recordClick({
      code: link.code,
      occurredAt,
      evidence: { userAgentHash: 'ua-1' },
    });
    expect(first.refused).toBeUndefined();
    expect(first.link?.clickCount).toBe(1);
    expect(first.touch?.kind).toBe('click');
    expect(first.touch?.referrerId).toBe(referrerId);
    expect(first.touch?.programId).toBe(programId);
    expect(first.touch?.linkId).toBe(link.id);
    expect(first.touch?.code).toBe(link.code);
    expect(first.touch?.occurredAt.toISOString()).toBe(
      occurredAt.toISOString(),
    );
    const evidence = first.touch?.getEvidence();
    expect(evidence?.code).toBe(link.code);
    expect(evidence?.linkId).toBe(link.id);
    expect(evidence?.targetUrl).toBe('https://example.test/landing');
    expect(evidence?.userAgentHash).toBe('ua-1');

    // Counter accumulates and every click leaves its own evidence row.
    const second = await links.recordClick({ code: link.code });
    expect(second.link?.clickCount).toBe(2);
    const persisted = await links.get({ id: link.id });
    expect(persisted?.clickCount).toBe(2);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(2);

    // An edge that already knows the prospect can identify the touch at
    // click time — resolve() gathers by subject pair, so this makes the
    // click attributable without a second identified touch.
    const identified = await links.recordClick({
      code: link.code,
      occurredAt,
      subjectKind: 'lead',
      subjectId: 'lead-123',
    });
    expect(identified.touch?.subjectKind).toBe('lead');
    expect(identified.touch?.subjectId).toBe('lead-123');
    expect(await touches.findBySubject('lead', 'lead-123')).toHaveLength(1);
  });

  it('rejects taking over an existing code on any write path (codex P1)', async () => {
    const victim = await links.createWithUniqueCode({
      referrerId,
      programId,
      targetUrl: 'https://example.test/victim',
    });
    const other = await links.createWithUniqueCode({ referrerId, programId });

    // A generated-surface create carrying the victim's code would upsert
    // over the victim row (hijacking its destination) — refused.
    await expect(
      links.create({
        referrerId,
        programId,
        code: victim.code,
        targetUrl: 'https://attacker.example/landing',
      }),
    ).rejects.toThrow(/cannot be taken over/);
    expect((await links.get({ id: victim.id }))?.targetUrl).toBe(
      'https://example.test/victim',
    );

    // Re-pointing an existing link's code at another link's code — refused.
    other.code = victim.code;
    await expect(other.save()).rejects.toThrow(/cannot be taken over/);

    // Legitimate edits to the link's own row still save.
    const mine = await links.get({ id: victim.id });
    if (!mine) throw new Error('missing link');
    mine.label = 'renamed';
    await mine.save();
    expect((await links.get({ id: victim.id }))?.label).toBe('renamed');
  });

  it('resolves codes case-insensitively (codes mint lowercase)', async () => {
    const link = await links.createWithUniqueCode({ referrerId, programId });
    const clicked = await links.recordClick({
      code: link.code.toUpperCase(),
    });
    expect(clicked.refused).toBeUndefined();
    expect(clicked.link?.id).toBe(link.id);
  });

  it('refuses clicks on disabled links without writing anything', async () => {
    const link = await links.createWithUniqueCode({ referrerId, programId });
    link.status = 'disabled';
    await link.save();

    const result = await links.recordClick({ code: link.code });
    expect(result.refused).toBe('link_disabled');
    expect(result.link?.id).toBe(link.id);
    expect(result.touch).toBeNull();
    expect((await links.get({ id: link.id }))?.clickCount).toBe(0);
    expect(await touches.findByReferrer(referrerId)).toHaveLength(0);
  });

  it('refuses unknown codes', async () => {
    const result = await links.recordClick({ code: 'nosuchcode' });
    expect(result.refused).toBe('unknown_code');
    expect(result.link).toBeNull();
    expect(result.touch).toBeNull();
  });

  it('validates targetUrl as absolute http(s) on every write path', async () => {
    await expect(
      links.createWithUniqueCode({
        referrerId,
        programId,
        targetUrl: 'not-a-url',
      }),
    ).rejects.toThrow(/absolute http\(s\) URL/);

    const link = await links.createWithUniqueCode({
      referrerId,
      programId,
      targetUrl: 'https://example.test/ok',
    });
    link.targetUrl = 'ftp://example.test/nope';
    await expect(link.save()).rejects.toThrow(/must use http or https/);

    link.targetUrl = 'http://example.test/also-ok';
    await expect(link.save()).resolves.toBeDefined();
  });
});
