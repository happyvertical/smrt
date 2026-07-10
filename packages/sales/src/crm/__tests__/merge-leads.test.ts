/**
 * Audited duplicate-merge tests: `LeadCollection.mergeLeads()` (validation,
 * fill-without-overwrite, acquisition-context preservation, terminal loser,
 * audit rows on both sides) and `activitiesIncludingMerged()` (merge-chain
 * traversal with cycle guard).
 *
 * Real in-memory SQLite via `getTestDatabase()` — no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';

describe('LeadCollection.mergeLeads()', () => {
  let db: DatabaseInterface;
  let leads: LeadCollection;
  let activities: SalesActivityCollection;

  beforeEach(async () => {
    db = await getTestDatabase();
    leads = await LeadCollection.create({ db });
    activities = await SalesActivityCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('fills empty winner contact fields from the loser without overwriting', async () => {
    const winner = await leads.create({
      name: 'Acme (web form)',
      contactName: 'Pat Doe',
      email: '', // empty — should be filled
      phone: '+1-555-0100', // non-empty — must survive
      organizationName: '',
    });
    const loser = await leads.create({
      name: 'Acme (trade show)',
      contactName: 'Patricia Doe', // winner already has one — must NOT overwrite
      email: 'pat@acme.test',
      phone: '+1-555-9999',
      organizationName: 'Acme Corp',
    });

    const result = await leads.mergeLeads({
      winnerId: winner.id ?? '',
      loserId: loser.id ?? '',
      reason: 'same buyer from two intake paths',
    });

    expect(result.winner.contactName).toBe('Pat Doe'); // kept
    expect(result.winner.email).toBe('pat@acme.test'); // filled
    expect(result.winner.phone).toBe('+1-555-0100'); // kept
    expect(result.winner.organizationName).toBe('Acme Corp'); // filled

    const persisted = await leads.get({ id: winner.id });
    expect(persisted?.email).toBe('pat@acme.test');
    expect(persisted?.contactName).toBe('Pat Doe');
  });

  it('preserves both acquisition contexts under mergedSources', async () => {
    const winner = await leads.create({
      name: 'Winner',
      sourceKind: 'web_form',
      sourceId: 'contact-us',
      acquisitionContext: JSON.stringify({ utm: 'summer-sale' }),
    });
    const loser = await leads.create({
      name: 'Loser',
      sourceKind: 'referral_intake',
      sourceId: 'draft-77',
      acquisitionContext: JSON.stringify({ referrerCode: 'FRIEND50' }),
    });

    await leads.mergeLeads({
      winnerId: winner.id ?? '',
      loserId: loser.id ?? '',
    });

    const merged = await leads.get({ id: winner.id });
    const context = merged?.getAcquisitionContext();
    expect(context?.utm).toBe('summer-sale'); // winner's own context preserved
    const sources = context?.mergedSources as Array<Record<string, unknown>>;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(1);
    expect(sources[0].leadId).toBe(loser.id);
    expect(sources[0].sourceKind).toBe('referral_intake');
    expect(sources[0].sourceId).toBe('draft-77');
    expect(sources[0].acquisitionContext).toEqual({
      referrerCode: 'FRIEND50',
    });

    // Winner's own source pointer is untouched.
    expect(merged?.sourceKind).toBe('web_form');
    expect(merged?.sourceId).toBe('contact-us');
  });

  it('accumulates mergedSources across successive merges', async () => {
    const winner = await leads.create({ name: 'Serial winner' });
    const loserA = await leads.create({
      name: 'Dup A',
      acquisitionContext: JSON.stringify({ a: 1 }),
    });
    const loserB = await leads.create({
      name: 'Dup B',
      acquisitionContext: JSON.stringify({ b: 2 }),
    });

    await leads.mergeLeads({
      winnerId: winner.id ?? '',
      loserId: loserA.id ?? '',
    });
    await leads.mergeLeads({
      winnerId: winner.id ?? '',
      loserId: loserB.id ?? '',
    });

    const merged = await leads.get({ id: winner.id });
    const sources = merged?.getAcquisitionContext().mergedSources as Array<
      Record<string, unknown>
    >;
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.leadId)).toEqual([
      loserA.id,
      loserB.id,
    ]);
  });

  it('makes the loser terminal (status merged + mergedIntoId)', async () => {
    const winner = await leads.create({ name: 'Winner' });
    const loser = await leads.create({ name: 'Loser' });

    await leads.mergeLeads({
      winnerId: winner.id ?? '',
      loserId: loser.id ?? '',
    });

    const mergedLoser = await leads.get({ id: loser.id });
    expect(mergedLoser?.status).toBe('merged');
    expect(mergedLoser?.mergedIntoId).toBe(winner.id);
    expect(mergedLoser?.isMerged()).toBe(true);

    // Terminal — cannot be revived.
    if (!mergedLoser) throw new Error('expected loser to load');
    mergedLoser.status = 'working';
    await expect(mergedLoser.save()).rejects.toThrow(
      /illegal status transition/i,
    );
  });

  it('writes merge audit rows on BOTH leads with the full loser snapshot', async () => {
    const winner = await leads.create({ name: 'Winner' });
    const loser = await leads.create({
      name: 'Loser',
      email: 'dup@acme.test',
      sourceKind: 'campaign',
    });

    await leads.mergeLeads({
      winnerId: winner.id ?? '',
      loserId: loser.id ?? '',
      actorProfileId: 'operator-profile-1',
      reason: 'confirmed duplicate',
    });

    const winnerTrail = await activities.findBySubject('lead', winner.id ?? '');
    const winnerMerge = winnerTrail.filter(
      (row) => row.activityKind === 'merge',
    );
    expect(winnerMerge).toHaveLength(1);
    expect(winnerMerge[0].actorProfileId).toBe('operator-profile-1');
    const winnerDetail = winnerMerge[0].getMetadata();
    expect(winnerDetail.direction).toBe('absorbed');
    expect(winnerDetail.reason).toBe('confirmed duplicate');
    expect(winnerDetail.winnerId).toBe(winner.id);
    expect(winnerDetail.loserId).toBe(loser.id);

    // Full pre-merge loser snapshot rides in the metadata.
    const snapshot = winnerDetail.loserSnapshot as Record<string, unknown>;
    expect(snapshot.email).toBe('dup@acme.test');
    expect(snapshot.sourceKind).toBe('campaign');
    expect(snapshot.status).toBe('new'); // captured BEFORE the terminal flip

    const loserTrail = await activities.findBySubject('lead', loser.id ?? '');
    const loserMerge = loserTrail.filter((row) => row.activityKind === 'merge');
    expect(loserMerge).toHaveLength(1);
    expect(loserMerge[0].getMetadata().direction).toBe('merged_away');
  });

  it("leaves the loser's prior activities attached to the loser", async () => {
    const winner = await leads.create({ name: 'Winner' });
    const loser = await leads.create({ name: 'Loser' });
    await activities.create({
      subjectKind: 'lead',
      subjectId: loser.id ?? '',
      activityKind: 'call',
      summary: 'Intro call before dedup',
    });

    await leads.mergeLeads({
      winnerId: winner.id ?? '',
      loserId: loser.id ?? '',
    });

    const loserTrail = await activities.findBySubject('lead', loser.id ?? '');
    expect(
      loserTrail.some(
        (row) =>
          row.activityKind === 'call' &&
          row.summary === 'Intro call before dedup',
      ),
    ).toBe(true);
    // The winner did NOT absorb the loser's rows.
    const winnerTrail = await activities.findBySubject('lead', winner.id ?? '');
    expect(winnerTrail.every((row) => row.activityKind !== 'call')).toBe(true);
  });

  describe('validation', () => {
    it('rejects identical winner and loser ids', async () => {
      const lead = await leads.create({ name: 'Self merge' });
      await expect(
        leads.mergeLeads({
          winnerId: lead.id ?? '',
          loserId: lead.id ?? '',
        }),
      ).rejects.toThrow(/distinct/i);
    });

    it('rejects missing winner or loser', async () => {
      const lead = await leads.create({ name: 'Exists' });
      await expect(
        leads.mergeLeads({
          winnerId: 'eeeeeeee-0000-0000-0000-000000000000',
          loserId: lead.id ?? '',
        }),
      ).rejects.toThrow(/not found/i);
      await expect(
        leads.mergeLeads({
          winnerId: lead.id ?? '',
          loserId: 'ffffffff-0000-0000-0000-000000000000',
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('rejects double-merging a loser', async () => {
      const winner = await leads.create({ name: 'Winner' });
      const other = await leads.create({ name: 'Other winner' });
      const loser = await leads.create({ name: 'Loser' });

      await leads.mergeLeads({
        winnerId: winner.id ?? '',
        loserId: loser.id ?? '',
      });
      await expect(
        leads.mergeLeads({
          winnerId: other.id ?? '',
          loserId: loser.id ?? '',
        }),
      ).rejects.toThrow(/already merged/i);
    });

    it('rejects merging into a merged winner (use the chain head)', async () => {
      const head = await leads.create({ name: 'Chain head' });
      const absorbed = await leads.create({ name: 'Absorbed' });
      const newcomer = await leads.create({ name: 'Newcomer' });

      await leads.mergeLeads({
        winnerId: head.id ?? '',
        loserId: absorbed.id ?? '',
      });
      await expect(
        leads.mergeLeads({
          winnerId: absorbed.id ?? '',
          loserId: newcomer.id ?? '',
        }),
      ).rejects.toThrow(/chain head/i);
    });

    it('rejects a two-lead merge cycle', async () => {
      const a = await leads.create({ name: 'A' });
      const b = await leads.create({ name: 'B' });

      await leads.mergeLeads({ winnerId: b.id ?? '', loserId: a.id ?? '' });
      // Now try to merge B into A — A is merged (loser check fires first),
      // which is exactly what prevents the cycle.
      await expect(
        leads.mergeLeads({ winnerId: a.id ?? '', loserId: b.id ?? '' }),
      ).rejects.toThrow(/merged/i);
    });
  });

  describe('activitiesIncludingMerged()', () => {
    it('traverses merge chains and collects every side of the history', async () => {
      // Chain: C merged into B, then B merged into A.
      const a = await leads.create({ name: 'A (canonical)' });
      const b = await leads.create({ name: 'B' });
      const c = await leads.create({ name: 'C' });
      const unrelated = await leads.create({ name: 'Unrelated' });

      await activities.create({
        subjectKind: 'lead',
        subjectId: a.id ?? '',
        activityKind: 'note',
        summary: 'note on A',
      });
      await activities.create({
        subjectKind: 'lead',
        subjectId: b.id ?? '',
        activityKind: 'note',
        summary: 'note on B',
      });
      await activities.create({
        subjectKind: 'lead',
        subjectId: c.id ?? '',
        activityKind: 'note',
        summary: 'note on C',
      });
      await activities.create({
        subjectKind: 'lead',
        subjectId: unrelated.id ?? '',
        activityKind: 'note',
        summary: 'note on unrelated',
      });

      await leads.mergeLeads({ winnerId: b.id ?? '', loserId: c.id ?? '' });
      await leads.mergeLeads({ winnerId: a.id ?? '', loserId: b.id ?? '' });

      const combined = await leads.activitiesIncludingMerged(a.id ?? '');
      const summaries = combined.map((row) => row.summary);
      expect(summaries).toContain('note on A');
      expect(summaries).toContain('note on B');
      expect(summaries).toContain('note on C');
      expect(summaries).not.toContain('note on unrelated');
      // Merge audit rows from both merges are part of the combined trail
      // (each merge writes one row per side).
      expect(
        combined.filter((row) => row.activityKind === 'merge'),
      ).toHaveLength(4);

      // A plain per-subject read still sees only the lead's own rows.
      const own = await activities.findBySubject('lead', a.id ?? '');
      expect(own.map((row) => row.summary)).not.toContain('note on C');
    });

    it('guards against malformed cyclic mergedIntoId data', async () => {
      const a = await leads.create({ name: 'Cycle A' });
      const b = await leads.create({ name: 'Cycle B' });
      // Forge a cycle directly (bypassing mergeLeads validation) — status
      // stays legal, only the pointers are cyclic.
      const rawA = await leads.get({ id: a.id });
      const rawB = await leads.get({ id: b.id });
      if (!rawA || !rawB) throw new Error('expected leads to load');
      rawA.mergedIntoId = b.id ?? '';
      await rawA.save();
      rawB.mergedIntoId = a.id ?? '';
      await rawB.save();

      await activities.create({
        subjectKind: 'lead',
        subjectId: a.id ?? '',
        activityKind: 'note',
        summary: 'cyclic note',
      });

      // Must terminate and still return the reachable trail.
      const combined = await leads.activitiesIncludingMerged(a.id ?? '');
      expect(combined.map((row) => row.summary)).toContain('cyclic note');
    });
  });
});
