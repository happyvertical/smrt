/**
 * schema-contract supplementary tests.
 *
 * Covers branches not exercised by schema-contract.test.ts: the formatter ok/
 * failure rendering, assertSchemaContract / SchemaContractError, short-name and
 * dotless-field resolution, STI table inference, object-form index checks, and
 * the "db without getTableSchema" no-op path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getClassByQualifiedNameMock,
  getClassMock,
  getAllFieldsMock,
  getTableStrategyMock,
  getSTIBaseMock,
  getTableNameMock,
} = vi.hoisted(() => ({
  getClassByQualifiedNameMock: vi.fn(),
  getClassMock: vi.fn(),
  getAllFieldsMock: vi.fn(),
  getTableStrategyMock: vi.fn(),
  getSTIBaseMock: vi.fn(),
  getTableNameMock: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: {
    getClassByQualifiedName: getClassByQualifiedNameMock,
    getClass: getClassMock,
    getAllFields: getAllFieldsMock,
    getTableStrategy: getTableStrategyMock,
    getSTIBase: getSTIBaseMock,
    getTableName: getTableNameMock,
  },
}));

import {
  assertSchemaContract,
  evaluateSchemaContract,
  formatSchemaContractFailures,
  SchemaContractError,
} from '../schema-contract.js';

const projectManifest = {
  path: '/repo/.smrt/manifest.json',
  source: 'project' as const,
  packageName: '@app/x',
  objectCount: 1,
  objectNames: ['Widget'],
};

describe('schema-contract extras', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTableStrategyMock.mockReturnValue('cti');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('formatSchemaContractFailures / assertSchemaContract', () => {
    it('returns a passing message and does not throw on an ok report', async () => {
      getClassMock.mockReturnValue({ name: 'Widget' });
      const report = await evaluateSchemaContract({
        discovered: [projectManifest],
      });
      expect(report.ok).toBe(true);
      expect(formatSchemaContractFailures(report)).toBe(
        'SMRT schema contract passed.',
      );
      expect(() => assertSchemaContract(report)).not.toThrow();
    });

    it('renders failures and throws SchemaContractError when not ok', async () => {
      getClassMock.mockReturnValue(undefined);
      getClassByQualifiedNameMock.mockReturnValue(undefined);
      const report = await evaluateSchemaContract({
        discovered: [projectManifest],
        schemaContract: { requiredObjects: ['@app/x:Missing'] },
      });

      const formatted = formatSchemaContractFailures(report);
      expect(formatted).toContain('SMRT schema contract failed');
      expect(formatted).toContain('is not registered');
      expect(() => assertSchemaContract(report)).toThrow(SchemaContractError);
    });
  });

  describe('object + field resolution branches', () => {
    it('resolves a required object by short (non-qualified) name and infers its table', async () => {
      getClassMock.mockReturnValue({ name: 'Widget' });
      getTableStrategyMock.mockReturnValue('cti');
      getTableNameMock.mockReturnValue('widgets');

      const report = await evaluateSchemaContract({
        discovered: [projectManifest],
        schemaContract: { requiredObjects: ['Widget'] },
      });

      expect(report.requiredObjects[0].present).toBe(true);
      expect(report.inferredDatabaseShape.tables).toContain('widgets');
    });

    it('infers an STI base table for required objects', async () => {
      getClassMock.mockReturnValue({ name: 'Article' });
      getTableStrategyMock.mockReturnValue('sti');
      getSTIBaseMock.mockReturnValue('Content');
      getTableNameMock.mockImplementation((name: string) =>
        name === 'Content' ? 'content' : undefined,
      );

      const report = await evaluateSchemaContract({
        discovered: [projectManifest],
        schemaContract: { requiredObjects: ['@app/x:Article'] },
      });

      expect(report.inferredDatabaseShape.tables).toContain('content');
    });

    it('flags a required field that uses a dotless ref (no field name)', async () => {
      getClassMock.mockReturnValue({ name: 'Widget' });
      const report = await evaluateSchemaContract({
        discovered: [projectManifest],
        // No "." => parseRequiredField yields an empty fieldName, so it is
        // reported as a missing field.
        schemaContract: { requiredFields: ['Widget'] },
      });

      expect(
        report.failures.some((f) => f.code === 'missing_required_field'),
      ).toBe(true);
    });

    it('records inferred column metadata for a present required field', async () => {
      getClassMock.mockReturnValue({ name: 'Widget' });
      getTableStrategyMock.mockReturnValue('cti');
      getTableNameMock.mockReturnValue('widgets');
      getAllFieldsMock.mockResolvedValue(new Map([['ownerId', {}]]));

      const report = await evaluateSchemaContract({
        discovered: [projectManifest],
        schemaContract: { requiredFields: ['Widget.ownerId'] },
      });

      const field = report.requiredFields[0];
      expect(field.present).toBe(true);
      expect(field.table).toBe('widgets');
      expect(field.column).toBe('owner_id');
      expect(report.inferredDatabaseShape.columns).toContain(
        'widgets.owner_id',
      );
    });
  });

  describe('database shape checks', () => {
    it('is a no-op when the db lacks getTableSchema', async () => {
      getClassMock.mockReturnValue({ name: 'Widget' });
      const report = await evaluateSchemaContract({
        discovered: [projectManifest],
        schemaContract: {
          requiredDatabaseShape: { tables: ['widgets'] },
        },
        db: {}, // no getTableSchema -> checkTable returns null -> table missing
      });

      expect(
        report.failures.some((f) => f.code === 'missing_required_table'),
      ).toBe(true);
    });

    it('matches an index provided as an object map and a present column', async () => {
      getClassMock.mockReturnValue({ name: 'Widget' });
      const db = {
        getTableSchema: vi.fn().mockResolvedValue({
          columns: { name: { type: 'text' } },
          // object-form indexes (not an array) exercises schemaHasIndex's else.
          indexes: { idx_widgets_name: { columns: ['name'] } },
        }),
      };

      const report = await evaluateSchemaContract({
        discovered: [projectManifest],
        schemaContract: {
          requiredDatabaseShape: {
            tables: ['widgets'],
            columns: ['widgets.name'],
            indexes: ['widgets.idx_widgets_name'],
          },
        },
        db,
      });

      expect(report.ok).toBe(true);
      expect(report.failures).toHaveLength(0);
    });
  });
});
