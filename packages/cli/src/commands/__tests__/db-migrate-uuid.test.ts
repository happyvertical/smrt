import { describe, expect, it } from 'vitest';
import { dbMigrateUuidCommand, parseRenameSpecs } from '../db-migrate-uuid.js';
import { utilityCommands } from '../utilities.js';

describe('db:migrate-uuid command', () => {
  it('is registered in the utility command map', () => {
    expect(utilityCommands['db:migrate-uuid']).toBe(dbMigrateUuidCommand);
    expect(dbMigrateUuidCommand.name).toBe('db:migrate-uuid');
    expect(dbMigrateUuidCommand.aliases).toContain('migrate-uuid');
  });

  describe('parseRenameSpecs', () => {
    it('returns no specs for an empty arg', () => {
      expect(parseRenameSpecs(undefined, undefined)).toEqual([]);
      expect(parseRenameSpecs('', 'assets')).toEqual([]);
    });

    it('parses a single old:new pair against the default --table', () => {
      expect(parseRenameSpecs('parent_id:source_asset_id', 'assets')).toEqual([
        { table: 'assets', from: 'parent_id', to: 'source_asset_id' },
      ]);
    });

    it('parses multiple comma-separated pairs', () => {
      expect(
        parseRenameSpecs('parent_slug:parent_id,old_ref:new_ref', 'tags'),
      ).toEqual([
        { table: 'tags', from: 'parent_slug', to: 'parent_id' },
        { table: 'tags', from: 'old_ref', to: 'new_ref' },
      ]);
    });

    it('supports per-entry table via "table.old:new" overriding the default', () => {
      expect(
        parseRenameSpecs(
          'tags.parent_slug:parent_id,facts.parent_id:previous_fact_id',
          'assets',
        ),
      ).toEqual([
        { table: 'tags', from: 'parent_slug', to: 'parent_id' },
        { table: 'facts', from: 'parent_id', to: 'previous_fact_id' },
      ]);
    });

    it('throws when a pair is malformed', () => {
      expect(() => parseRenameSpecs('parent_id', 'assets')).toThrow(
        /Invalid --rename entry/,
      );
    });

    it('throws when no table can be resolved for a pair', () => {
      expect(() =>
        parseRenameSpecs('parent_id:source_asset_id', undefined),
      ).toThrow(/no table/);
    });
  });
});
