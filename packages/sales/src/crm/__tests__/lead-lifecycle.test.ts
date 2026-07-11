/**
 * Lead lifecycle tests: CRUD, JSON field helpers, and the save-time status
 * transition guard (legal transitions, illegal transitions, raw-assignment
 * forcing, and the create-onto-existing-id mass-assignment path).
 *
 * Real in-memory SQLite via `getTestDatabase()` — no DB mocking, per
 * `.claude/rules/testing.md`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { LEAD_STATUSES } from '../types.js';

describe('Lead lifecycle', () => {
  let db: DatabaseInterface;
  let leads: LeadCollection;

  beforeEach(async () => {
    db = await getTestDatabase();
    leads = await LeadCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('creates a lead with defaults and preserves fields through save/load', async () => {
    const lead = await leads.create({
      name: 'Acme rooftop retrofit',
      contactName: 'Pat Doe',
      email: 'pat@acme.test',
      phone: '+1-555-0100',
      organizationName: 'Acme Corp',
      sourceKind: 'campaign',
      sourceId: 'spring-2026',
      intakeRef: 'form-submission-42',
    });

    expect(lead.id).toBeDefined();
    expect(lead.status).toBe('new');
    expect(lead.qualifiedAt).toBeNull();
    expect(lead.mergedIntoId).toBe('');

    const loaded = await leads.get({ id: lead.id });
    expect(loaded).toBeDefined();
    expect(loaded?.name).toBe('Acme rooftop retrofit');
    expect(loaded?.contactName).toBe('Pat Doe');
    expect(loaded?.email).toBe('pat@acme.test');
    expect(loaded?.phone).toBe('+1-555-0100');
    expect(loaded?.organizationName).toBe('Acme Corp');
    expect(loaded?.sourceKind).toBe('campaign');
    expect(loaded?.sourceId).toBe('spring-2026');
    expect(loaded?.intakeRef).toBe('form-submission-42');
    expect(loaded?.status).toBe('new');
  });

  it('requires a name', async () => {
    await expect(leads.create({ email: 'anon@acme.test' })).rejects.toThrow();
  });

  it('round-trips acquisitionContext and metadata JSON helpers', async () => {
    const lead = await leads.create({ name: 'JSON roundtrip' });
    lead.setAcquisitionContext({ campaign: 'spring-2026', touches: 3 });
    lead.setMetadata({ score: 87 });
    await lead.save();

    const loaded = await leads.get({ id: lead.id });
    expect(loaded?.getAcquisitionContext()).toEqual({
      campaign: 'spring-2026',
      touches: 3,
    });
    expect(loaded?.getMetadata()).toEqual({ score: 87 });
  });

  it('returns {} from JSON helpers on malformed content instead of throwing', async () => {
    const lead = await leads.create({
      name: 'Malformed JSON',
      acquisitionContext: 'not json {',
      metadata: '[1,2,3]', // an array is not a JSON object
    });
    expect(lead.getAcquisitionContext()).toEqual({});
    expect(lead.getMetadata()).toEqual({});
  });

  it('exports the status vocabulary as a const array', () => {
    expect(LEAD_STATUSES).toEqual([
      'new',
      'working',
      'qualified',
      'disqualified',
      'merged',
    ]);
  });

  describe('status transition guard', () => {
    it('allows the legal working path new → working → qualified', async () => {
      const lead = await leads.create({ name: 'Legal path' });

      lead.status = 'working';
      await lead.save();
      lead.status = 'qualified';
      await lead.save();

      const loaded = await leads.get({ id: lead.id });
      expect(loaded?.status).toBe('qualified');
    });

    it('allows disqualified → working (re-open)', async () => {
      const lead = await leads.create({ name: 'Re-open' });
      lead.status = 'disqualified';
      await lead.save();

      lead.status = 'working';
      await lead.save();
      expect((await leads.get({ id: lead.id }))?.status).toBe('working');
    });

    it('rejects qualified → working (no un-qualifying)', async () => {
      const lead = await leads.create({ name: 'No unqualify' });
      lead.status = 'qualified';
      await lead.save();

      lead.status = 'working';
      await expect(lead.save()).rejects.toThrow(/illegal status transition/i);
    });

    it('rejects disqualified → qualified (must re-open through working)', async () => {
      const lead = await leads.create({ name: 'No direct requalify' });
      lead.status = 'disqualified';
      await lead.save();

      lead.status = 'qualified';
      await expect(lead.save()).rejects.toThrow(/illegal status transition/i);
    });

    it('treats merged as terminal, even via a freshly loaded instance', async () => {
      const lead = await leads.create({ name: 'Terminal merged' });
      lead.status = 'merged';
      await lead.save();

      const loaded = await leads.get({ id: lead.id });
      expect(loaded?.status).toBe('merged');
      if (!loaded) throw new Error('expected lead to load');
      loaded.status = 'working';
      await expect(loaded.save()).rejects.toThrow(/illegal status transition/i);
    });

    it('guards the create-onto-existing-id path (un-hydrated mass assignment)', async () => {
      const lead = await leads.create({ name: 'Poisoned prior' });
      lead.status = 'qualified';
      await lead.save();

      // create() with an existing id writes onto the row WITHOUT hydrating
      // it first — the guard must re-read the authoritative prior status
      // from the database rather than treating this as a brand-new row.
      await expect(
        leads.create({ id: lead.id, name: 'Poisoned prior', status: 'new' }),
      ).rejects.toThrow(/illegal status transition/i);
    });

    it('permits a no-op re-save of any status', async () => {
      const lead = await leads.create({ name: 'No-op resave' });
      lead.status = 'merged';
      await lead.save();

      const loaded = await leads.get({ id: lead.id });
      if (!loaded) throw new Error('expected lead to load');
      loaded.contactName = 'Updated Contact';
      await loaded.save(); // status unchanged — allowed
      expect((await leads.get({ id: lead.id }))?.contactName).toBe(
        'Updated Contact',
      );
    });
  });
});
