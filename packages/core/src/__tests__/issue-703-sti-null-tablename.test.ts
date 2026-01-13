/**
 * Issue #703: STI db:migrate creates separate tables when tableName is null
 *
 * When STI subclasses are loaded from external manifests with tableName: null,
 * getAllSchemas() should still merge them into the parent table instead of
 * creating separate tables.
 *
 * Root cause: getSTIBase() relied on tableName matching between child and parent.
 * When registerFromManifest() derives a tableName from class name (due to null
 * in manifest), the child's tableName ('meetings') doesn't match parent's
 * tableName ('events'), so getSTIBase() fails to find the parent.
 *
 * Fix: getSTIBase() now finds the STI base by looking for the oldest ancestor
 * with explicit tableStrategy: 'sti', without requiring tableName matching.
 *
 * Related: https://github.com/happyvertical/smrt/issues/703
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry';

describe('Issue #703: STI with null tableName from external manifest', () => {
  // Store original registry state to restore after tests
  const originalClasses = new Map(ObjectRegistry.classes);
  const originalClassNameMap = new Map(
    (ObjectRegistry as any).classNameMap || new Map(),
  );

  beforeAll(() => {
    // Register STI base class with explicit tableStrategy and tableName
    ObjectRegistry.registerFromManifest(
      'Issue703Event',
      {
        className: 'Issue703Event',
        extends: 'SmrtObject',
        decoratorConfig: {
          tableStrategy: 'sti',
          tableName: 'issue703_events',
        },
        fields: {
          title: { type: 'text', default: '' },
          eventDate: { type: 'datetime' },
        },
        schema: {
          tableName: 'issue703_events',
          ddl: 'CREATE TABLE IF NOT EXISTS "issue703_events" ("id" TEXT PRIMARY KEY, "title" TEXT, "event_date" DATETIME, "_meta_type" TEXT, "_meta_data" TEXT)',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            title: { type: 'TEXT' },
            event_date: { type: 'DATETIME' },
            _meta_type: { type: 'TEXT' },
            _meta_data: { type: 'TEXT' },
          },
          indexes: [],
        },
      },
      'test-package',
    );

    // Register STI child class with null tableName (simulating external manifest)
    // This is the key scenario: the manifest has tableName: null, which causes
    // registerFromManifest() to derive 'issue703meetings' from class name
    ObjectRegistry.registerFromManifest(
      'Issue703Meeting',
      {
        className: 'Issue703Meeting',
        extends: 'Issue703Event',
        decoratorConfig: {
          // tableName is intentionally omitted to simulate null in manifest
          // registerFromManifest will derive 'issue703meetings' from class name
        },
        fields: {
          councilId: { type: 'text', default: '' },
          agendaUrl: { type: 'text', default: '' },
        },
        // No schema provided - simulating external manifest scenario
      },
      'test-package',
    );

    // Register another STI child with different tableName (explicit mismatch)
    ObjectRegistry.registerFromManifest(
      'Issue703WeatherForecast',
      {
        className: 'Issue703WeatherForecast',
        extends: 'Issue703Event',
        decoratorConfig: {
          // Explicitly different tableName to test mismatch handling
          tableName: 'issue703_forecasts',
        },
        fields: {
          temperatureHigh: { type: 'decimal', default: 0.0 },
          temperatureLow: { type: 'decimal', default: 0.0 },
        },
      },
      'test-package',
    );
  });

  afterAll(() => {
    // Restore original registry state
    ObjectRegistry.classes.clear();
    for (const [key, value] of originalClasses) {
      ObjectRegistry.classes.set(key, value);
    }
    const classNameMap = (ObjectRegistry as any).classNameMap;
    if (classNameMap) {
      classNameMap.clear();
      for (const [key, value] of originalClassNameMap) {
        classNameMap.set(key, value);
      }
    }
  });

  describe('getSTIBase()', () => {
    it('should return STI base class for the base class itself', () => {
      const stiBase = ObjectRegistry.getSTIBase('Issue703Event');
      expect(stiBase).toBe('Issue703Event');
    });

    it('should find STI base for child class even when tableName is derived (null in manifest)', () => {
      // This is the key fix for Issue #703
      // Before fix: getSTIBase('Issue703Meeting') would return 'Issue703Meeting'
      //             because its derived tableName 'issue703meetings' doesn't match
      //             parent's tableName 'issue703_events'
      // After fix: getSTIBase('Issue703Meeting') returns 'Issue703Event'
      //            because we find the oldest ancestor with explicit tableStrategy: 'sti'
      const stiBase = ObjectRegistry.getSTIBase('Issue703Meeting');
      expect(stiBase).toBe('Issue703Event');
    });

    it('should find STI base for child class even when tableName explicitly differs', () => {
      // Even with explicitly different tableName, the STI base should be found
      // because STI inheritance is determined by tableStrategy, not tableName
      const stiBase = ObjectRegistry.getSTIBase('Issue703WeatherForecast');
      expect(stiBase).toBe('Issue703Event');
    });

    it('should return null for CTI classes', () => {
      // Register a CTI class for comparison
      ObjectRegistry.registerFromManifest(
        'Issue703CTIClass',
        {
          className: 'Issue703CTIClass',
          extends: 'SmrtObject',
          decoratorConfig: {
            tableStrategy: 'cti',
            tableName: 'issue703_cti',
          },
          fields: {},
        },
        'test-package',
      );

      const stiBase = ObjectRegistry.getSTIBase('Issue703CTIClass');
      expect(stiBase).toBeNull();
    });
  });

  describe('getTableStrategy()', () => {
    it('should return sti for base class', () => {
      const strategy = ObjectRegistry.getTableStrategy('Issue703Event');
      expect(strategy).toBe('sti');
    });

    it('should return sti for child class (inherited)', () => {
      const strategy = ObjectRegistry.getTableStrategy('Issue703Meeting');
      expect(strategy).toBe('sti');
    });

    it('should return sti for another child class (inherited)', () => {
      const strategy = ObjectRegistry.getTableStrategy(
        'Issue703WeatherForecast',
      );
      expect(strategy).toBe('sti');
    });
  });

  describe('getAllSchemas()', () => {
    it('should merge STI child columns into parent table schema', () => {
      const schemas = ObjectRegistry.getAllSchemas();

      // The parent table should exist with ALL columns merged
      const eventsSchema = schemas.issue703_events;
      expect(eventsSchema).toBeDefined();
      expect(eventsSchema.tableName).toBe('issue703_events');

      // DDL should include base class columns
      expect(eventsSchema.ddl).toContain('"title"');
      expect(eventsSchema.ddl).toContain('"event_date"');

      // DDL should include Meeting subclass columns (Issue #703 fix)
      expect(eventsSchema.ddl).toContain('"council_id"');
      expect(eventsSchema.ddl).toContain('"agenda_url"');

      // DDL should include WeatherForecast subclass columns (Issue #703 fix)
      expect(eventsSchema.ddl).toContain('"temperature_high"');
      expect(eventsSchema.ddl).toContain('"temperature_low"');

      // STI meta columns should be present
      expect(eventsSchema.ddl).toContain('"_meta_type"');
      expect(eventsSchema.ddl).toContain('"_meta_data"');
    });

    it('should NOT create separate tables for STI subclasses', () => {
      const schemas = ObjectRegistry.getAllSchemas();

      // Subclass tables should NOT exist (columns merged into parent)
      // The derived tableName 'issue703meetings' should NOT appear
      expect(schemas.issue703meetings).toBeUndefined();
      expect(schemas.issue703_meetings).toBeUndefined();

      // The explicit different tableName 'issue703_forecasts' should also NOT appear
      // because STI subclasses share the parent table regardless of their declared tableName
      expect(schemas.issue703_forecasts).toBeUndefined();
      expect(schemas.issue703forecasts).toBeUndefined();
    });

    it('should only produce ONE table for the entire STI hierarchy', () => {
      const schemas = ObjectRegistry.getAllSchemas();

      // Count STI tables that match the issue703 prefix
      // (exclude the CTI table 'issue703_cti' which was registered for getSTIBase comparison)
      const issue703STITables = Object.keys(schemas).filter(
        (name) => name.startsWith('issue703') && name !== 'issue703_cti',
      );

      // There should be exactly ONE table for the entire STI hierarchy
      expect(issue703STITables).toEqual(['issue703_events']);
    });
  });
});
