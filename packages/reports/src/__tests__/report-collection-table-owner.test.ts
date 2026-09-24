/**
 * #3110: a report collection is never a second owner of its model's table.
 */
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPORT_TABLE,
  registerConsumerReportCollection,
  registerUnrelatedTableClaimant,
} from './helpers/consumer-report-collection.js';

describe('report collection and its model share no table ownership (#3110)', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    registerConsumerReportCollection();
  });
  afterEach(() => ObjectRegistry.clear());

  it('plans the model table once, from the model', () => {
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(Object.keys(schemas[REPORT_TABLE].columns)).toEqual(
      expect.arrayContaining(['day', 'unit', 'total']),
    );
  });

  it('creates and writes the table (SQLite)', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: ['UsageDailyReport'],
    });
    try {
      await db.insert(REPORT_TABLE, {
        id: 'row-1',
        slug: 'row-1',
        day: '2026-09-24',
        unit: 'seconds',
        total: 42,
      });
      const { rows } = await db.query(`SELECT total FROM ${REPORT_TABLE}`);
      expect(rows).toEqual([{ total: 42 }]);
    } finally {
      await db.close?.();
    }
  });

  it('still rejects an unrelated class claiming the same table', () => {
    registerUnrelatedTableClaimant();
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      /claimed by unrelated classes/,
    );
  });
});
