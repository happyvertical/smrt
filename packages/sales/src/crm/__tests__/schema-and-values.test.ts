/**
 * Schema and value-fidelity tests: money is integer cents (INTEGER columns
 * from `= 0` defaults), rates/probabilities are DECIMAL (`= 0.0` defaults),
 * both round-trip exactly; natural keys are registered as `conflictColumns`;
 * and the generation surfaces are explicitly restricted (never `undefined`
 * — an omitted api/mcp config would mean FULL surface).
 */

import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpportunityCollection } from '../collections/OpportunityCollection.js';
// Side-effect import: fire every model's decorators so ObjectRegistry
// carries the full @smrt() config (api/mcp/cli/conflictColumns) for all
// seven classes, not just the ones this file references.
import '../index.js';

describe('CRM schema and value fidelity', () => {
  describe('column types', () => {
    it('stores *Cents money as INTEGER and probability as DECIMAL on Opportunity', () => {
      const schema = ObjectRegistry.getSchema('Opportunity');
      if (!schema) throw new Error('expected Opportunity schema');

      expect(schema.tableName).toBe('opportunities');
      expect(schema.columns.expected_value_cents.type).toBe('INTEGER');
      // Decimal (`= 0.0`) fields emit REAL — the framework's floating SQL
      // type — as opposed to the INTEGER emitted by `= 0` defaults.
      expect(schema.columns.probability.type).toBe('REAL');
      expect(schema.columns.expected_close_at.type).toBe('TIMESTAMP');
      expect(schema.columns.won_at.type).toBe('TIMESTAMP');
    });

    it('stores stage probability as DECIMAL and sortOrder as INTEGER', () => {
      const schema = ObjectRegistry.getSchema('PipelineStage');
      if (!schema) throw new Error('expected PipelineStage schema');

      expect(schema.tableName).toBe('pipeline_stages');
      expect(schema.columns.probability.type).toBe('REAL');
      expect(schema.columns.sort_order.type).toBe('INTEGER');
      expect(schema.columns.is_won.type).toBe('BOOLEAN');
      expect(schema.columns.is_lost.type).toBe('BOOLEAN');
    });
  });

  describe('natural keys (conflictColumns)', () => {
    it('registers the documented natural keys', () => {
      expect(
        ObjectRegistry.getConfig('PipelineDefinition').conflictColumns,
      ).toEqual(['tenant_id', 'key']);
      expect(ObjectRegistry.getConfig('PipelineStage').conflictColumns).toEqual(
        ['pipeline_id', 'key'],
      );
      expect(
        ObjectRegistry.getConfig('OpportunityConversion').conflictColumns,
      ).toEqual(['opportunity_id', 'target_kind', 'target_id']);
    });
  });

  describe('generation surfaces are explicit (never wide open)', () => {
    it.each([
      'SalesRepresentative',
      'Lead',
      'PipelineDefinition',
      'PipelineStage',
      'Opportunity',
      'SalesActivity',
      'OpportunityConversion',
    ])('%s declares explicit api and mcp configs', (className) => {
      const config = ObjectRegistry.getConfig(className);
      // `undefined` would mean FULL CRUD — every model must declare.
      expect(config.api).toBeDefined();
      expect(config.mcp).toBeDefined();
      expect(config.cli).toBeDefined();
    });

    it('never exposes delete on audit-trail models', () => {
      for (const className of [
        'Lead',
        'SalesActivity',
        'OpportunityConversion',
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
    let opportunities: OpportunityCollection;

    beforeEach(async () => {
      db = await getTestDatabase();
      opportunities = await OpportunityCollection.create({ db });
    });

    afterEach(async () => {
      if (db && typeof db.close === 'function') {
        await db.close();
      }
    });

    it('round-trips integer cents exactly (no float drift)', async () => {
      const opportunity = await opportunities.create({
        name: 'Cents fidelity',
        expectedValueCents: 123_456_789,
        currency: 'EUR',
      });

      const loaded = await opportunities.get({ id: opportunity.id });
      expect(loaded?.expectedValueCents).toBe(123_456_789);
      expect(Number.isInteger(loaded?.expectedValueCents)).toBe(true);
      expect(loaded?.currency).toBe('EUR');
    });

    it('round-trips decimal probability exactly', async () => {
      const opportunity = await opportunities.create({
        name: 'Probability fidelity',
        probability: 0.35,
      });

      const loaded = await opportunities.get({ id: opportunity.id });
      expect(loaded?.probability).toBe(0.35);
    });

    it('defaults money to 0 cents and probability to 0.0', async () => {
      const opportunity = await opportunities.create({ name: 'Defaults' });
      const loaded = await opportunities.get({ id: opportunity.id });
      expect(loaded?.expectedValueCents).toBe(0);
      expect(loaded?.probability).toBe(0.0);
      expect(loaded?.currency).toBe('USD');
    });
  });
});
