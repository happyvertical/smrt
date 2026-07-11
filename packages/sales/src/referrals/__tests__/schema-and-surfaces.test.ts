/**
 * Schema and generation-surface tests for the referrals module: natural
 * keys registered as `conflictColumns`, INTEGER vs DECIMAL column fidelity
 * (`= 0` vs `= 0.0` defaults), explicit api/mcp/cli configs on every model
 * (an omitted config would mean FULL surface), and read-only surfaces on
 * evidence/audit/snapshot rows.
 */

import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReferralCollection } from '../collections/ReferralCollection.js';
// Side-effect import: fire every model's decorators so ObjectRegistry
// carries the full @smrt() config (api/mcp/cli/conflictColumns) for all
// nine classes, not just the ones this file references.
import '../index.js';

describe('Referrals schema and generation surfaces', () => {
  describe('natural keys (conflictColumns)', () => {
    it('registers the documented natural keys', () => {
      expect(
        ObjectRegistry.getConfig('ReferralProgram').conflictColumns,
      ).toEqual(['tenant_id', 'key']);
      expect(
        ObjectRegistry.getConfig('AttributionPolicy').conflictColumns,
      ).toEqual(['tenant_id', 'policy_key', 'version']);
      expect(ObjectRegistry.getConfig('ReferralLink').conflictColumns).toEqual([
        'code',
      ]);
      expect(
        ObjectRegistry.getConfig('ReferralAgreement').conflictColumns,
      ).toEqual(['referrer_id', 'program_id', 'version']);
    });
  });

  describe('column types', () => {
    it('stores fractions as DECIMAL and counts/versions/windows as INTEGER', () => {
      const referral = ObjectRegistry.getSchema('Referral');
      if (!referral) throw new Error('expected Referral schema');
      expect(referral.tableName).toBe('referrals');
      expect(referral.columns.credit_fraction.type).toBe('REAL');
      expect(referral.columns.policy_version.type).toBe('INTEGER');
      expect(referral.columns.expires_at.type).toBe('TIMESTAMP');

      const policy = ObjectRegistry.getSchema('AttributionPolicy');
      if (!policy) throw new Error('expected AttributionPolicy schema');
      expect(policy.tableName).toBe('attribution_policies');
      expect(policy.columns.window_days.type).toBe('INTEGER');
      expect(policy.columns.allow_self_referral.type).toBe('BOOLEAN');
      expect(policy.columns.effective_from.type).toBe('TIMESTAMP');

      const link = ObjectRegistry.getSchema('ReferralLink');
      if (!link) throw new Error('expected ReferralLink schema');
      expect(link.tableName).toBe('referral_links');
      expect(link.columns.click_count.type).toBe('INTEGER');

      const snapshot = ObjectRegistry.getSchema('ReferralTermSnapshot');
      if (!snapshot) throw new Error('expected ReferralTermSnapshot schema');
      expect(snapshot.tableName).toBe('referral_term_snapshots');
      expect(snapshot.columns.clearing_days.type).toBe('INTEGER');
      expect(snapshot.columns.plan_version.type).toBe('INTEGER');
    });
  });

  describe('generation surfaces are explicit (never wide open)', () => {
    it.each([
      'Referrer',
      'ReferralProgram',
      'AttributionPolicy',
      'ReferralLink',
      'ReferralTouch',
      'Referral',
      'AttributionException',
      'ReferralAgreement',
      'ReferralTermSnapshot',
    ])('%s declares explicit api, mcp, and cli configs', (className) => {
      const config = ObjectRegistry.getConfig(className);
      // `undefined` would mean FULL CRUD — every model must declare.
      expect(config.api).toBeDefined();
      expect(config.mcp).toBeDefined();
      expect(config.cli).toBeDefined();
    });

    it('keeps evidence, audit, and snapshot rows write-closed', () => {
      for (const className of [
        'ReferralTouch',
        'AttributionException',
        'ReferralTermSnapshot',
      ]) {
        const config = ObjectRegistry.getConfig(className);
        const api = config.api;
        if (typeof api === 'boolean' || api === undefined) {
          throw new Error(`expected object api config on ${className}`);
        }
        expect(api.include).not.toContain('update');
        expect(api.include).not.toContain('delete');
        expect(config.cli).toBe(false);
      }
      // Exceptions and snapshots are minted by services only — no create.
      for (const className of [
        'AttributionException',
        'ReferralTermSnapshot',
      ]) {
        const api = ObjectRegistry.getConfig(className).api;
        if (typeof api === 'boolean' || api === undefined) {
          throw new Error(`expected object api config on ${className}`);
        }
        expect(api.include).not.toContain('create');
      }
    });

    it('never exposes delete on any referrals model', () => {
      for (const className of [
        'Referrer',
        'ReferralProgram',
        'AttributionPolicy',
        'ReferralLink',
        'ReferralTouch',
        'Referral',
        'AttributionException',
        'ReferralAgreement',
        'ReferralTermSnapshot',
      ]) {
        const api = ObjectRegistry.getConfig(className).api;
        if (typeof api === 'boolean' || api === undefined) {
          throw new Error(`expected object api config on ${className}`);
        }
        expect(api.include).not.toContain('delete');
      }
    });
  });

  describe('value round-trips', () => {
    let db: DatabaseInterface;
    let referrals: ReferralCollection;

    beforeEach(async () => {
      db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
      referrals = await ReferralCollection.create({ db });
    });

    afterEach(async () => {
      if (db && typeof db.close === 'function') {
        await db.close();
      }
    });

    it('round-trips decimal credit fractions and integer versions exactly', async () => {
      const referral = await referrals.create({
        referrerId: '11111111-1111-4111-8111-111111111111',
        programId: '22222222-2222-4222-8222-222222222222',
        targetKind: 'client',
        targetId: 'client-1',
        creditFraction: 0.3334,
        policyVersion: 7,
        status: 'pending',
      });
      const loaded = await referrals.get({ id: referral.id });
      expect(loaded?.creditFraction).toBe(0.3334);
      expect(loaded?.policyVersion).toBe(7);
      expect(Number.isInteger(loaded?.policyVersion)).toBe(true);
    });
  });
});
