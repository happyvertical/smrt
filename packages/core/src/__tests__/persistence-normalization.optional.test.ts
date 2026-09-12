import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject, type SmrtObjectOptions } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt()
class PersistenceNormalizationProbe extends SmrtObject {
  sourceText = '';
  derivedText = '';

  constructor(options: SmrtObjectOptions & { sourceText?: string } = {}) {
    super(options);
    this.sourceText = options.sourceText ?? '';
  }

  protected override transformJSON(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...super.transformJSON(data),
      sourceText: `serialized:${data.sourceText}`,
    };
  }

  protected override getPersistenceDerivedColumns(): readonly string[] {
    return [...super.getPersistenceDerivedColumns(), 'derived_text'];
  }

  protected override normalizePersistenceData(
    data: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    this.derivedText = String(data.source_text).toUpperCase();
    return {
      ...super.normalizePersistenceData(data),
      derived_text: this.derivedText,
    };
  }
}

@smrt({ conflictColumns: ['externalId'] })
class CamelConflictNormalizationProbe extends SmrtObject {
  @field({ type: 'text' })
  externalId = 'original';

  protected override getPersistenceDerivedColumns(): readonly string[] {
    return ['external_id'];
  }

  protected override normalizePersistenceData(): Record<string, unknown> {
    return { external_id: 'replacement' };
  }
}

for (const dialect of ['sqlite', 'duckdb', 'postgres'] as const) {
  const suite =
    dialect === 'postgres' && !process.env.SMRT_TEST_POSTGRES_URL
      ? describe.skip
      : describe.sequential;
  suite(`final persistence normalization (${dialect})`, () => {
    let db: DatabaseInterface;
    beforeEach(async () => {
      if (dialect === 'postgres') {
        const connection = await getDatabase({
          type: 'postgres',
          url: process.env.SMRT_TEST_POSTGRES_URL,
          dbid: `normalization-${randomUUID()}`,
        } as Parameters<typeof getDatabase>[0]);
        db = await getTestDatabase({
          db: connection,
          classes: ['PersistenceNormalizationProbe'],
        });
      } else {
        db = await getTestDatabase({
          type: dialect,
          url: ':memory:',
          classes: ['PersistenceNormalizationProbe'],
        });
      }
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await db?.close?.();
    });

    it('protects a real camelCase registry conflict column before strict insertion', async () => {
      expect(
        ObjectRegistry.getConflictColumns('CamelConflictNormalizationProbe'),
      ).toEqual(['externalId']);
      expect(
        ObjectRegistry.getFields('CamelConflictNormalizationProbe').get(
          'externalId',
        )?.type,
      ).toBe('text');
      // Real registry configuration, pre-provisioned physical columns. Default
      // schema generation's camelCase conflict-index mapping is a separate edge.
      const uuid = dialect === 'sqlite' ? 'TEXT' : 'UUID';
      await db.query(
        'DROP TABLE IF EXISTS camel_conflict_normalization_probes',
      );
      await db.query(`CREATE TABLE camel_conflict_normalization_probes (
        id ${uuid} PRIMARY KEY, external_id TEXT UNIQUE,
        slug TEXT, context TEXT, created_at TIMESTAMP, updated_at TIMESTAMP)`);
      const instance = await new CamelConflictNormalizationProbe({
        db,
      }).initialize();
      instance.requireInsertOnSave();
      const normalize = vi.spyOn(instance as any, 'normalizePersistenceData');
      await expect(instance.save()).rejects.toThrow(
        'Invalid persistence derived column declaration: external_id',
      );
      expect(normalize).not.toHaveBeenCalled();
      expect(
        (await db.query(`SELECT id FROM ${instance.tableName}`)).rows,
      ).toEqual([]);
    });
    it('normalization cannot restore the previous framework revision', async () => {
      const instance = new PersistenceNormalizationProbe({
        db,
        sourceText: 'first',
      });
      await instance.initialize();
      await instance.save();
      const oldRevision = instance.updated_at;
      const transform = (instance as any).transformJSON.bind(instance);
      vi.spyOn(instance as any, 'transformJSON').mockImplementation(
        (data: any) => ({ ...transform(data), updated_at: oldRevision }),
      );
      instance.sourceText = 'transform only';
      await instance.save();
      const afterTransform = await db.query(
        `SELECT updated_at FROM ${instance.tableName} WHERE id = ?`,
        instance.id,
      );
      expect(
        new Date(afterTransform.rows[0].updated_at as any).getTime(),
      ).toBeGreaterThan(new Date(oldRevision!).getTime());
      const revision = instance.updated_at;
      vi.spyOn(instance as any, 'normalizePersistenceData').mockReturnValue({
        updated_at: revision,
      });
      instance.sourceText = 'normalizer override';
      await expect(instance.save()).rejects.toThrow(
        'Undeclared persistence derived column',
      );
      const afterNormalization = await db.query(
        `SELECT updated_at FROM ${instance.tableName} WHERE id = ?`,
        instance.id,
      );
      expect(
        new Date(afterNormalization.rows[0].updated_at as any).getTime(),
      ).toBe(new Date(revision!).getTime());
      expect(instance.updated_at).toEqual(revision);
    });
    it.each([
      'id',
      'tenant_id',
      'updated_at',
      'source_text',
      'unknown_column',
    ])('rejects undeclared %s without writing', async (column) => {
      const instance = await new PersistenceNormalizationProbe({
        db,
        sourceText: 'retained',
      }).initialize();
      await instance.save();
      const originalRevision = instance.updated_at;
      const before = await db.query(
        `SELECT * FROM ${instance.tableName} WHERE id = ?`,
        instance.id,
      );
      vi.spyOn(instance as any, 'normalizePersistenceData').mockReturnValue({
        [column]: 'replacement',
      });
      await expect(instance.save()).rejects.toThrow(
        'Undeclared persistence derived column',
      );
      const after = await db.query(
        `SELECT * FROM ${instance.tableName} WHERE id = ?`,
        instance.id,
      );
      expect(after.rows).toEqual(before.rows);
      expect(instance.updated_at).toEqual(originalRevision);
    });
    it.each([
      'id',
      'slug',
      'tenant_id',
      'created_at',
      'updated_at',
      '_meta_type',
      '_meta_data',
      'unknown_column',
    ])('rejects invalid %s declaration before normalization', async (column) => {
      const instance = await new PersistenceNormalizationProbe({
        db,
        sourceText: 'retained',
      }).initialize();
      await instance.save();
      const originalRevision = instance.updated_at;
      const before = await db.query(
        `SELECT * FROM ${instance.tableName} WHERE id = ?`,
        instance.id,
      );
      vi.spyOn(instance as any, 'getPersistenceDerivedColumns').mockReturnValue(
        [column],
      );
      const normalize = vi.spyOn(instance as any, 'normalizePersistenceData');
      await expect(instance.save()).rejects.toThrow(
        'Invalid persistence derived column declaration',
      );
      expect(normalize).not.toHaveBeenCalled();
      const after = await db.query(
        `SELECT * FROM ${instance.tableName} WHERE id = ?`,
        instance.id,
      );
      expect(after.rows).toEqual(before.rows);
      expect(instance.updated_at).toEqual(originalRevision);
    });
    it('rejects a declared custom tenant field before normalization', async () => {
      const instance = await new PersistenceNormalizationProbe({
        db,
        sourceText: 'retained',
      }).initialize();
      await instance.save();
      const getFields = ObjectRegistry.getFields.bind(ObjectRegistry);
      vi.spyOn(ObjectRegistry, 'getFields').mockImplementation((name) => {
        const fields = new Map(getFields(name));
        const source = fields.get('sourceText');
        if (source)
          fields.set('sourceText', {
            ...source,
            __tenancy: { isTenantIdField: true },
          });
        return fields;
      });
      vi.spyOn(instance as any, 'getPersistenceDerivedColumns').mockReturnValue(
        ['source_text'],
      );
      const normalize = vi.spyOn(instance as any, 'normalizePersistenceData');
      await expect(instance.save()).rejects.toThrow(
        'Invalid persistence derived column declaration',
      );
      expect(normalize).not.toHaveBeenCalled();
    });
    it('rejects a declared natural conflict column before normalization', async () => {
      const instance = await new PersistenceNormalizationProbe({
        db,
        sourceText: 'retained',
      }).initialize();
      await instance.save();
      vi.spyOn(ObjectRegistry, 'getConflictColumns').mockReturnValue([
        'source_text',
      ]);
      vi.spyOn(instance as any, 'getPersistenceDerivedColumns').mockReturnValue(
        ['source_text'],
      );
      const normalize = vi.spyOn(instance as any, 'normalizePersistenceData');
      await expect(instance.save()).rejects.toThrow(
        'Invalid persistence derived column declaration',
      );
      expect(normalize).not.toHaveBeenCalled();
    });
    it('passes a frozen final-row copy to normalization', async () => {
      const instance = await new PersistenceNormalizationProbe({
        db,
        sourceText: 'retained',
      }).initialize();
      const normalize = (instance as any).normalizePersistenceData.bind(
        instance,
      );
      vi.spyOn(instance as any, 'normalizePersistenceData').mockImplementation(
        (row: any) => {
          expect(Object.isFrozen(row)).toBe(true);
          return normalize(row);
        },
      );
      await instance.save();
    });
    for (const insertOnly of [false, true]) {
      it(`merges returned derived columns into ${insertOnly ? 'strict insert' : 'upsert'} and subsequent update`, async () => {
        const instance = new PersistenceNormalizationProbe({
          db,
          sourceText: 'first',
        });
        await instance.initialize();
        if (insertOnly) instance.requireInsertOnSave();
        for (const source of ['first', 'second']) {
          instance.sourceText = source;
          await instance.save();
          const { rows } = await db.query(
            `SELECT source_text, derived_text FROM ${instance.tableName} WHERE id = ?`,
            instance.id,
          );
          expect(rows[0]).toEqual({
            source_text: `serialized:${source}`,
            derived_text: `SERIALIZED:${source.toUpperCase()}`,
          });
          expect(instance.toJSON()).toMatchObject({
            sourceText: rows[0].source_text,
            derivedText: rows[0].derived_text,
          });
        }
      });
    }
  });
}
