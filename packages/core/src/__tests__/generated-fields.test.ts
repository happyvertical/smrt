// biome-ignore-all lint/suspicious/noThenProperty: SQL SDK conditionals require a non-callable then data property.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { field } from '../decorators/index.js';
import {
  compileGeneratedExpression,
  type GeneratedExpression,
  GeneratedFieldError,
  generatedExpressionsEqual,
  validateGeneratedFields,
} from '../generated-fields.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { generateOpenAPISpec } from '../generators/swagger.js';
import { SchemaComparer } from '../migrations/differ.js';
import { SmrtObject } from '../object.js';
import { fieldsToColumns } from '../registry/schema-builder.js';
import { ObjectRegistry, smrt } from '../registry.js';
import {
  planRuntimeModelDDL,
  type RuntimeModelDefinition,
  registerRuntimeModel,
  runtimeModelEntry,
} from '../runtime-model.js';
import type {
  FieldDefinition,
  QualifiedClassName,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { detectEngine, getDDLStrategy } from '../schema/ddl/index.js';
import { checkLiveSchemaParity } from '../schema/live-parity.js';
import { manifestColumnsToDefinitions } from '../schema/manifest-schema.js';
import type { SchemaDefinition } from '../schema/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { generateSvelteKitRoutes } from '../vite-plugin/sveltekit-generator.js';

const persistenceEngines =
  process.env.SMRT_TEST_PGLITE === '1'
    ? (['postgres'] as const)
    : (['sqlite'] as const);

@smrt({ tableName: 'generated_decorated', conflictColumns: ['id'] })
class GeneratedDecorated extends SmrtObject {
  @field({ type: 'integer' }) qty = 0;
  @field({ type: 'integer' }) unitPrice = 0;
  @field({
    type: 'integer',
    generated: { op: 'mul', left: { col: 'qty' }, right: { col: 'unitPrice' } },
  })
  total = 0;
}

@smrt({ tableStrategy: 'sti', tableName: 'generated_sti' })
class GeneratedSTI extends SmrtObject {
  @field({ type: 'integer' }) qty = 0;
  @field({ type: 'integer' }) price = 0;
}

const definition = (): RuntimeModelDefinition => ({
  name: 'GeneratedInvoice',
  packageName: '@test/generated',
  tableName: 'generated_invoices',
  fields: {
    qty: { type: 'integer' },
    unitPrice: { type: 'integer' },
    category: { type: 'text' },
    total: {
      type: 'integer',
      required: true,
      generated: {
        op: 'mul',
        left: { col: 'qty' },
        right: { col: 'unitPrice' },
      },
    },
  },
});

describe('database-generated fields #4915', () => {
  let restore: () => void;
  const databases: DatabaseInterface[] = [];
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(async () => {
    for (const db of databases.splice(0)) await db.close?.();
    restore();
  });

  it('keeps decorator, registry and runtime column expressions in parity', () => {
    expect(detectEngine('memory://', 'pglite')).toBe('postgres');
    expect(detectEngine('pglite:memory://')).toBe('postgres');
    const name =
      ObjectRegistry.getClassByConstructor(GeneratedDecorated)!.qualifiedName!;
    const fields = ObjectRegistry.getFields(name);
    const columns = fieldsToColumns(fields);
    expect(columns.total.generated).toEqual({
      op: 'mul',
      left: { col: 'qty' },
      right: { col: 'unit_price' },
    });
    expect(columns.total.defaultValue).toBeUndefined();
    expect(
      ObjectRegistry.getAllSchemasAsDefinitions({
        tables: ['generated_decorated'],
      }).generated_decorated.columns.total.generated,
    ).toEqual(columns.total.generated);
    expect(ObjectRegistry.getFields(name).get('total')?._meta?.readonly).toBe(
      true,
    );
    const expression = columns.total.generated!;
    for (const engine of ['sqlite', 'postgres', 'duckdb'] as const) {
      const ddl = getDDLStrategy(engine).generateColumnDefinition('total', {
        type: 'INTEGER',
        generated: expression,
      });
      expect(ddl).toContain(
        `GENERATED ALWAYS AS (("qty" * "unit_price")) ${engine === 'postgres' ? 'STORED' : 'VIRTUAL'}`,
      );
    }
    expect(() =>
      getDDLStrategy('json').generateColumnDefinition('total', columns.total),
    ).toThrow(GeneratedFieldError);
    for (const engine of ['sqlite', 'postgres'] as const) {
      const fragment = getDDLStrategy(engine).generateColumnDefinition(
        'total',
        {
          type: 'INTEGER',
          generated: expression,
          notNull: true,
          unique: true,
          check: 'total >= 0',
        },
      );
      expect(fragment).toContain('NOT NULL UNIQUE CHECK (total >= 0)');
    }
    expect(() =>
      getDDLStrategy('duckdb').generateColumnDefinition('total', {
        type: 'INTEGER',
        generated: expression,
        notNull: true,
      }),
    ).toThrow(GeneratedFieldError);
  });

  for (const engine of persistenceEngines) {
    it(`${engine}: create/update/upsert never write total; filters, sorts and aggregate read it`, async () => {
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      const name = registerRuntimeModel(definition());
      for (const sql of await planRuntimeModelDDL(
        name,
        engine,
        async () => null,
      ))
        await db.query(sql);
      const collection = await ObjectRegistry.getCollection(name, { db });
      const api = new APIGenerator(
        {
          basePath: '/api',
          authMiddleware: () => async (request: Request) => request,
        },
        { db },
      );
      api.registerCollection('generated_invoices', collection);
      const denied = await api.generateHandler()(
        new Request('http://test/api/generated_invoices', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ qty: 2, unitPrice: 3, total: 99 }),
        }),
      );
      expect(denied.status).toBe(201);
      const accepted = (await collection.list())[0];
      expect(accepted.toJSON()).toHaveProperty('total', 6);
      await collection.delete(accepted.id!);
      const first = (await collection.create({
        qty: 2,
        unitPrice: 30,
        category: 'a',
      })) as SmrtObject & { qty: number; total: number };
      expect(first.total).toBe(60);
      first.qty = 3;
      await first.save();
      expect(first.total).toBe(90);
      const updated = await collection.update(first.id!, { unitPrice: 40 });
      expect((updated as unknown as { total: number }).total).toBe(120);
      // An unloaded new object with the same id follows the upsert path.
      await collection.create({
        id: first.id,
        qty: 4,
        unitPrice: 40,
        category: 'a',
      });
      const second = await collection.create({
        qty: 1,
        unitPrice: 10,
        category: 'b',
      });
      expect(
        (
          await collection.list({
            where: { 'total >': 100 },
            orderBy: 'total DESC',
          })
        ).map((row) => row.id),
      ).toEqual([first.id]);
      expect(
        (await collection.list({ orderBy: 'total ASC' })).map((row) => row.id),
      ).toEqual([second.id, first.id]);
      const result = await db.query(
        'SELECT SUM(total) AS total FROM generated_invoices',
      );
      expect(Number(result.rows[0].total)).toBe(170);
      await expect(
        collection.create({ qty: 1, total: 123 }),
      ).rejects.toMatchObject({ code: 'VALIDATION_GENERATED_FIELD_WRITE' });
      await expect(
        collection.update(first.id!, { total: 123 }),
      ).rejects.toMatchObject({ code: 'VALIDATION_GENERATED_FIELD_WRITE' });
      await expect(
        collection.getOrUpsert({ id: first.id, total: 160 }),
      ).rejects.toMatchObject({ code: 'VALIDATION_GENERATED_FIELD_WRITE' });
      const loaded = (await collection.get(first.id!)) as SmrtObject & {
        total: number;
      };
      loaded.total = 999;
      await expect(loaded.save()).rejects.toMatchObject({
        code: 'VALIDATION_GENERATED_FIELD_WRITE',
      });
      expect(
        Number(
          (
            await db.query(
              'SELECT total FROM generated_invoices WHERE id = $1',
              [first.id],
            )
          ).rows[0].total,
        ),
      ).toBe(160);
      const current = (await collection.get(first.id!, {
        cache: false,
      })) as typeof first;
      await expect(
        current.withTransaction(async (record) => {
          (record as typeof first).qty = 9;
          await record.save();
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        Number(
          (
            await db.query(
              'SELECT total FROM generated_invoices WHERE id = $1',
              [first.id],
            )
          ).rows[0].total,
        ),
      ).toBe(160);
    });

    it(`${engine}: hydrates STI generated fields and omits them in compatible batches`, async () => {
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      const ancestor =
        ObjectRegistry.getClassByConstructor(GeneratedSTI)!.qualifiedName!;
      const parent = registerRuntimeModel({
        name: 'GeneratedSTIMiddle',
        packageName: '@test/generated-sti',
        extends: ancestor,
        fields: {
          baseTotal: {
            type: 'integer',
            generated: {
              op: 'mul',
              left: { col: 'qty' },
              right: { col: 'price' },
            },
          },
        },
      });
      const child = registerRuntimeModel({
        name: 'GeneratedSTIChild',
        packageName: '@test/generated-sti',
        extends: parent,
        fields: {
          total: {
            type: 'integer',
            generated: {
              op: 'mul',
              left: { col: 'qty' },
              right: { col: 'price' },
            },
          },
        },
      });
      for (const sql of await planRuntimeModelDDL(
        child,
        engine,
        async (table) => {
          const schema = await db.getTableSchema?.(table);
          return schema ? Object.keys(schema.columns) : null;
        },
      ))
        await db.query(sql);
      const children = await ObjectRegistry.getCollection(child, { db });
      const row = (await children.create({
        qty: 2,
        price: 6,
      })) as SmrtObject & { total: number };
      expect(row.total).toBe(12);
      expect(row.toJSON()).toHaveProperty('baseTotal', 12);
      await expect(
        children.create({ qty: 2, price: 6, baseTotal: 99 }),
      ).rejects.toMatchObject({ code: 'VALIDATION_GENERATED_FIELD_WRITE' });
      expect(() =>
        registerRuntimeModel(
          {
            name: 'GeneratedSTIChild',
            packageName: '@test/generated-sti',
            extends: parent,
            fields: {
              total: {
                type: 'integer',
                generated: {
                  op: 'add',
                  left: { col: 'qty' },
                  right: { col: 'price' },
                },
              },
            },
          },
          { refresh: true },
        ),
      ).not.toThrow();
      expect(
        ObjectRegistry.getFields(child).get('total')?._meta?.generated,
      ).toMatchObject({ op: 'add' });
      expect((await children.get(row.id!))?.toJSON()).toHaveProperty(
        'total',
        12,
      );
      await expect(
        children.create({ qty: 2, price: 6, total: 99 }),
      ).rejects.toMatchObject({ code: 'VALIDATION_GENERATED_FIELD_WRITE' });

      const name =
        ObjectRegistry.getClassByConstructor(GeneratedDecorated)!
          .qualifiedName!;
      const schema = ObjectRegistry.getAllSchemasAsDefinitions({
        tables: ['generated_decorated'],
      }).generated_decorated;
      await db.query(getDDLStrategy(engine).generateCreateTable(schema));
      for (const sql of getDDLStrategy(engine).generateIndexes(schema))
        await db.query(sql);
      const added = await Promise.all(
        [2, 3].map(async (qty) => {
          const item = new GeneratedDecorated({
            db,
            qty,
            unitPrice: 4,
            _skipLoad: true,
          });
          await item.initialize();
          return item;
        }),
      );
      expect(added.every((item) => item.supportsJunctionBatch())).toBe(true);
      expect(await SmrtObject.tryJunctionBatch([], added)).toBe(true);
      expect(added.map((item) => item.total)).toEqual([8, 12]);
      expect((await ObjectRegistry.getCollection(name, { db })).tableName).toBe(
        'generated_decorated',
      );
    });

    it(`${engine}: executes SDK scalar nodes and compares PostgreSQL deparsed casts`, async () => {
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      const name = registerRuntimeModel({
        name: 'GeneratedExpressions',
        packageName: '@test/generated-expressions',
        fields: {
          qty: { type: 'integer' },
          price: { type: 'integer' },
          label: { type: 'text' },
          ratio: {
            type: 'decimal',
            generated: {
              op: 'div',
              left: { col: 'qty' },
              right: { col: 'price' },
            },
          },
          eligible: {
            type: 'boolean',
            generated: {
              op: 'and',
              operands: [
                { op: 'gte', left: { col: 'qty' }, right: { value: 2 } },
                {
                  op: 'not',
                  operand: { op: 'isNull', operand: { col: 'price' } },
                },
              ],
            },
          },
          fallback: {
            type: 'text',
            generated: {
              op: 'coalesce',
              operands: [{ col: 'label' }, { value: "fallback'$1" }],
            },
          },
          textQty: {
            type: 'text',
            generated: { op: 'asText', operand: { col: 'qty' } },
          },
        },
      });
      for (const sql of await planRuntimeModelDDL(
        name,
        engine,
        async () => null,
      ))
        await db.query(sql);
      const collection = await ObjectRegistry.getCollection(name, { db });
      const item = await collection.create({ qty: 3, price: 2, label: null });
      expect(item.toJSON()).toMatchObject({
        ratio: 1.5,
        eligible: true,
        fallback: "fallback'$1",
        textQty: '3',
      });
      const schema = ObjectRegistry.getAllSchemasAsDefinitions({
        tables: [collection.tableName],
      });
      expect(
        manifestColumnsToDefinitions(schema[collection.tableName].columns).ratio
          .generated,
      ).toBeDefined();
      const parity = await checkLiveSchemaParity({
        db,
        schemas: schema,
        includeSystemTables: false,
        engineHint: engine,
      });
      expect(
        parity.findings.filter(
          (finding) => finding.kind === 'generated_expression_drift',
        ),
      ).toEqual([]);
      await collection.update(item.id!, { price: 0 });
      expect(
        (await collection.get(item.id!, { cache: false }))?.toJSON(),
      ).toHaveProperty('ratio', null);
    });

    it(`${engine}: executes every new SDK node with typed dates and mapped references`, async () => {
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      const n = { col: 'unitPrice' },
        text = { col: 'label' };
      const date = { value: { kind: 'date', iso: '2024-02-28' } } as const;
      const next = { op: 'addDays', value: date, days: { value: 2 } } as const;
      const cases: [
        string,
        'integer' | 'decimal' | 'text',
        GeneratedExpression,
        unknown,
      ][] = [
        [
          'conditional',
          'decimal',
          { op: 'if', condition: { col: 'paid' }, then: { value: 0 }, else: n },
          12.345,
        ],
        [
          'branches',
          'decimal',
          {
            op: 'case',
            branches: [{ when: { col: 'paid' }, then: { value: 0 } }],
            else: n,
          },
          12.345,
        ],
        [
          'rounded',
          'decimal',
          { op: 'round', value: n, digits: { value: 2 } },
          12.35,
        ],
        ['absolute', 'decimal', { op: 'abs', value: n }, 12.345],
        ['floored', 'integer', { op: 'floor', value: n }, 12],
        ['ceiling', 'integer', { op: 'ceil', value: n }, 13],
        [
          'minimum',
          'decimal',
          { op: 'least', operands: [n, { value: 10 }] },
          10,
        ],
        [
          'maximum',
          'decimal',
          { op: 'greatest', operands: [n, { value: 10 }] },
          12.345,
        ],
        [
          'remainder',
          'decimal',
          { op: 'mod', left: n, right: { value: 10 } },
          2.345,
        ],
        [
          'joined',
          'text',
          { op: 'concat', operands: [text, { value: "'$1" }] },
          " AbC '$1",
        ],
        ['lowered', 'text', { op: 'lower', value: text }, ' abc '],
        ['uppered', 'text', { op: 'upper', value: text }, ' ABC '],
        ['trimmed', 'text', { op: 'trim', value: text }, 'AbC'],
        ['size', 'integer', { op: 'length', value: text }, 5],
        [
          'part',
          'text',
          {
            op: 'substring',
            value: text,
            start: { value: 2 },
            length: { value: 2 },
          },
          'Ab',
        ],
        ['calendarYear', 'integer', { op: 'year', value: next }, 2024],
        ['calendarMonth', 'integer', { op: 'month', value: next }, 3],
        ['calendarDay', 'integer', { op: 'day', value: next }, 1],
        [
          'elapsedDays',
          'integer',
          { op: 'daysBetween', later: next, earlier: date },
          2,
        ],
        [
          'typedDate',
          'integer',
          {
            op: 'day',
            value: {
              value: { kind: 'date', iso: '2024-03-01' },
            },
          },
          1,
        ],
      ];
      const name = registerRuntimeModel({
        name: 'PortableFields',
        packageName: '@test/portable',
        fields: {
          unitPrice: { type: 'decimal' },
          paid: { type: 'boolean' },
          label: { type: 'text' },
          ...Object.fromEntries(
            cases.map(([key, type, generated]) => [key, { type, generated }]),
          ),
        },
      });
      for (const sql of await planRuntimeModelDDL(
        name,
        engine,
        async () => null,
      ))
        await db.query(sql);
      const collection = await ObjectRegistry.getCollection(name, { db });
      const row = await collection.create({
        unitPrice: 12.345,
        paid: false,
        label: ' AbC ',
      });
      const output = row.toJSON();
      for (const [key, , , expected] of cases) {
        if (typeof expected === 'number')
          expect(Number(output[key]), key).toBeCloseTo(expected, 8);
        else expect(output[key], key).toEqual(expected);
      }
      await collection.update(row.id!, { paid: true, label: null });
      const updated = (await collection.get(row.id!, {
        cache: false,
      }))!.toJSON();
      expect(updated.conditional).toBe(0);
      expect(updated.branches).toBe(0);
      expect(updated.joined).toBeNull();
    });

    it(`${engine}: adds a generated column to populated tables and changes its expression`, async () => {
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      await db.query(
        'CREATE TABLE generated_migration (qty INTEGER, unit_price INTEGER)',
      );
      await db.query(
        'INSERT INTO generated_migration (qty, unit_price) VALUES (2, 5)',
      );
      const schema: SchemaDefinition = {
        tableName: 'generated_migration',
        columns: {
          qty: { type: 'INTEGER' as const },
          unit_price: { type: 'INTEGER' as const },
          total: {
            type: 'INTEGER' as const,
            generated: {
              op: 'mul' as const,
              left: { col: 'qty' },
              right: { col: 'unit_price' },
            },
          },
        },
        indexes: [{ name: 'generated_total_idx', columns: ['total'] }],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1',
      };
      const schemas = { generated_migration: schema };
      const diff = await new SchemaComparer(db, { engineHint: engine }).compare(
        schemas,
      );
      const addition = diff.changes.find(
        (change) => change.name === 'total' && change.type === 'add_column',
      )!;
      expect(addition.sql).toContain('GENERATED ALWAYS');
      await db.query(addition.sql!);
      for (const sql of getDDLStrategy(engine).generateIndexes(schema))
        await db.query(sql);
      expect(
        Number(
          (await db.query('SELECT total FROM generated_migration')).rows[0]
            .total,
        ),
      ).toBe(10);
      expect(
        (
          await new SchemaComparer(db, { engineHint: engine }).compare(schemas)
        ).changes.filter((change) => change.name === 'total'),
      ).toEqual([]);
      const parity = () =>
        checkLiveSchemaParity({
          db,
          schemas,
          includeSystemTables: false,
          engineHint: engine,
        });
      expect(
        (await parity()).findings.filter(
          (finding) => finding.target === 'total',
        ),
      ).toEqual([]);
      schema.columns.total.generated = {
        op: 'add',
        left: { col: 'qty' },
        right: { col: 'unit_price' },
      };
      expect((await parity()).findings).toContainEqual(
        expect.objectContaining({
          kind: 'generated_expression_drift',
          target: 'total',
        }),
      );
      const changed = await new SchemaComparer(db, {
        engineHint: engine,
      }).compare(schemas);
      const replacement = changed.changes.find(
        (change) => change.name === 'total',
      )!;
      expect(replacement.type).toBe('alter_column');
      for (const sql of replacement.sqlStatements!) await db.query(sql);
      expect(
        Number(
          (await db.query('SELECT total FROM generated_migration')).rows[0]
            .total,
        ),
      ).toBe(7);
      expect(
        (await parity()).findings.filter(
          (finding) => finding.target === 'total',
        ),
      ).toEqual([]);
    });
  }

  for (const path of ['decoration', 'manifest', 'runtime'] as const) {
    for (const invalid of ['organizationId', 'ordinaryCode', undefined]) {
      it(`#4972 round4 item1: ${path} child-first ${invalid ? `${invalid} redeclaration is quarantined` : 'own generated field becomes usable'}`, async () => {
        const packageName = '@test/late-generated';
        const parentKey = `${packageName}:LateGeneratedParent`;
        const grandchildKey = `${packageName}:LateGeneratedGrandchild`;
        const childKey = `${packageName}:LateGeneratedChild`;
        const Parent = class LateGeneratedParent extends SmrtObject {};
        const Child = class LateGeneratedChild extends Parent {};
        const fields: RuntimeModelDefinition['fields'] = {
          ownerSource: { type: 'text' },
          qty: { type: 'integer' },
          [invalid ?? 'total']: {
            type: invalid ? 'text' : 'integer',
            generated: { col: invalid ? 'ownerSource' : 'qty' },
          },
        };
        if (path === 'decoration') {
          for (const [name, fd] of Object.entries(fields))
            field(fd)(Child.prototype, name);
          smrt({
            packageName,
            tableStrategy: 'sti',
            tableName: 'late_generated',
          })(Child);
        } else if (path === 'runtime') {
          registerRuntimeModel({
            name: 'LateGeneratedChild',
            packageName,
            tableName: 'late_generated',
            extends: parentKey,
            fields,
          });
        } else {
          const entry = runtimeModelEntry({
            name: 'LateGeneratedChild',
            packageName,
            tableName: 'late_generated',
            fields,
          });
          entry.extendsQualified = parentKey as QualifiedClassName;
          ObjectRegistry.registerFromManifest(childKey, entry, packageName);
        }
        const grandchild = runtimeModelEntry({
          name: 'LateGeneratedGrandchild',
          packageName,
          tableName: 'late_generated',
          fields: {},
        });
        grandchild.extendsQualified = childKey as QualifiedClassName;
        ObjectRegistry.registerFromManifest(
          grandchildKey,
          grandchild,
          packageName,
        );
        await expect(
          ObjectRegistry.getAllFields(grandchildKey),
        ).rejects.toThrow(
          expect.objectContaining({
            name: 'GeneratedFieldError',
            message: expect.stringContaining('ancestry unresolved'),
          }),
        );
        const unresolved = expect.objectContaining({
          name: 'GeneratedFieldError',
          message: expect.stringMatching(
            /LateGeneratedChild.*ancestry unresolved/i,
          ),
        });
        expect(() => ObjectRegistry.getSchemaDDL(childKey, 'sqlite')).toThrow(
          unresolved,
        );
        expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
          unresolved,
        );
        await expect(ObjectRegistry.getAllFields(childKey)).rejects.toThrow(
          unresolved,
        );
        const db = await getTestDatabase({
          type: persistenceEngines[0] === 'postgres' ? 'pglite' : 'sqlite',
          classes: [],
          includeSystemTables: false,
        });
        databases.push(db);
        await expect(
          ObjectRegistry.getCollection(childKey, { db }),
        ).rejects.toThrow(unresolved);
        await expect(async () =>
          new SchemaComparer(db).compare(
            ObjectRegistry.getAllSchemasAsDefinitions(),
          ),
        ).rejects.toThrow(unresolved);
        const Ctor = ObjectRegistry.getClass(childKey)!
          .constructor as typeof SmrtObject;
        await expect(async () => new Ctor({ db }).save()).rejects.toThrow(
          unresolved,
        );
        const registerParent = () => {
          if (path === 'decoration') {
            field({ type: 'text' })(Parent.prototype, 'ordinaryCode');
            smrt({
              packageName,
              tableStrategy: 'sti',
              tableName: 'late_generated',
              tenantScoped: { field: 'organizationId' },
            })(Parent);
          } else {
            const entry = runtimeModelEntry({
              name: 'LateGeneratedParent',
              packageName,
              tableName: 'late_generated',
              tenantScoped: { field: 'organizationId' },
              fields: { ordinaryCode: { type: 'text' } },
            });
            entry.decoratorConfig!.tableStrategy = 'sti';
            ObjectRegistry.registerFromManifest(parentKey, entry, packageName);
          }
        };
        if (invalid) {
          const rejected = expect.objectContaining({
            name: 'GeneratedFieldError',
            message: expect.stringContaining('LateGeneratedChild'),
          });
          expect(registerParent).toThrow(rejected);
          await expect(
            ObjectRegistry.getAllFields(grandchildKey),
          ).rejects.toThrow(rejected);
          expect(() => ObjectRegistry.getSchemaDDL(childKey, 'sqlite')).toThrow(
            rejected,
          );
          await expect(
            ObjectRegistry.getCollection(childKey, { db }),
          ).rejects.toThrow(rejected);
        } else {
          registerParent();
          const readyDb = await getTestDatabase({
            type: persistenceEngines[0] === 'postgres' ? 'pglite' : 'sqlite',
            classes: [childKey],
            includeSystemTables: false,
          });
          databases.push(readyDb);
          const collection = await ObjectRegistry.getCollection(childKey, {
            db: readyDb,
          });
          const row = await collection.create({
            organizationId: '11111111-1111-4111-8111-111111111111',
            qty: 7,
          });
          expect(row.toJSON()).toMatchObject({
            organizationId: '11111111-1111-4111-8111-111111111111',
            total: 7,
          });
          expect(
            (await readyDb.query('SELECT organization_id FROM late_generated'))
              .rows[0].organization_id,
          ).toBe('11111111-1111-4111-8111-111111111111');
        }
      });
    }
  }

  for (const path of ['decoration', 'manifest', 'runtime'] as const) {
    for (const inherited of [
      'organizationId',
      'ordinaryCode',
      'ordinary_code',
    ]) {
      it(`#4972 round3 item1: ${path} refuses generated redeclaration of inherited ${inherited}`, () => {
        const Root = class InheritedOwnerRoot extends SmrtObject {};
        field({ type: 'text' })(Root.prototype, 'ownerSource');
        field({ type: 'text' })(Root.prototype, 'ordinaryCode');
        smrt({
          packageName: '@test/inherited-owner',
          tableStrategy: 'sti',
          tenantScoped: { field: 'organizationId' },
        })(Root);
        const Middle = class InheritedOwnerMiddle extends Root {};
        smrt({ packageName: '@test/inherited-owner' })(Middle);
        const parent =
          ObjectRegistry.getClassByConstructor(Middle)!.qualifiedName!;
        const def: RuntimeModelDefinition = {
          name: 'InheritedOwnerLeaf',
          packageName: '@test/inherited-owner',
          extends: parent,
          fields: {
            [inherited]: { type: 'text', generated: { col: 'ownerSource' } },
          },
        };
        const register = () => {
          if (path === 'runtime') return registerRuntimeModel(def);
          if (path === 'manifest') {
            const entry = runtimeModelEntry({ ...def, fields: {} });
            entry.fields[inherited] = {
              type: 'text',
              generated: { col: 'ownerSource' },
            };
            // Reproduce a scanned leaf with no own tenancy declaration/marker.
            delete entry.decoratorConfig!.tenantScoped;
            return ObjectRegistry.registerFromManifest(
              entry.qualifiedName!,
              entry,
              def.packageName,
            );
          }
          const Leaf = class InheritedOwnerLeaf extends Middle {};
          field({ type: 'text', generated: { col: 'ownerSource' } })(
            Leaf.prototype,
            inherited,
          );
          smrt({ packageName: def.packageName })(Leaf);
        };
        expect(register).toThrow(
          expect.objectContaining({ name: 'GeneratedFieldError' }),
        );
        expect(
          ObjectRegistry.getClass('@test/inherited-owner:InheritedOwnerLeaf'),
        ).toBeUndefined();
      });
    }

    it(`#4972 round3 item3: ${path} refuses every configured natural conflict column`, () => {
      for (const conflict of ['natural_key', 'naturalKey']) {
        const def: RuntimeModelDefinition = {
          name: 'GeneratedNaturalKey',
          packageName: '@test/generated-conflict',
          conflictColumns: [conflict],
          fields: {
            source: { type: 'text' },
            naturalKey: { type: 'text', generated: { col: 'source' } },
          },
        };
        const register = () => {
          if (path === 'runtime') return registerRuntimeModel(def);
          if (path === 'manifest') {
            const entry = runtimeModelEntry({
              ...def,
              conflictColumns: ['id'],
            });
            entry.decoratorConfig!.conflictColumns = [conflict];
            return ObjectRegistry.registerFromManifest(
              entry.qualifiedName!,
              entry,
              def.packageName,
            );
          }
          const Model = class GeneratedNaturalKey extends SmrtObject {};
          field({ type: 'text' })(Model.prototype, 'source');
          field({ type: 'text', generated: { col: 'source' } })(
            Model.prototype,
            'naturalKey',
          );
          smrt({ packageName: def.packageName, conflictColumns: [conflict] })(
            Model,
          );
        };
        expect(register).toThrow(
          expect.objectContaining({ name: 'GeneratedFieldError' }),
        );
        expect(
          ObjectRegistry.getClass(
            '@test/generated-conflict:GeneratedNaturalKey',
          ),
        ).toBeUndefined();
      }
    });
  }

  for (const path of ['decoration', 'runtime'] as const) {
    it(`#4972 round3 item1: ${path} cannot explicitly redeclare even an inherited generated field`, () => {
      const parent = registerRuntimeModel(definition());
      const total = definition().fields!.total;
      const register = () => {
        if (path === 'runtime')
          return registerRuntimeModel({
            name: 'RedeclaredGeneratedLeaf',
            packageName: '@test/generated',
            extends: parent,
            fields: { total },
          });
        const Parent = ObjectRegistry.getClass(parent)!.constructor;
        const Leaf = class RedeclaredGeneratedLeaf extends Parent {};
        field({ type: 'integer', generated: total.generated })(
          Leaf.prototype,
          'total',
        );
        smrt({ packageName: '@test/generated' })(Leaf);
      };
      expect(register).toThrow(GeneratedFieldError);
    });
  }

  for (const path of ['decoration', 'manifest', 'runtime'] as const) {
    it(`#4972 round3 item3: ${path} cannot choose an inherited generated column as its conflict key`, () => {
      const Root = class GeneratedKeyRoot extends SmrtObject {};
      field({ type: 'integer' })(Root.prototype, 'qty');
      field({ type: 'integer', generated: { col: 'qty' } })(
        Root.prototype,
        'total',
      );
      smrt({
        packageName: '@test/generated-key',
        tableStrategy: 'sti',
        conflictColumns: ['id'],
      })(Root);
      const parent = ObjectRegistry.getClassByConstructor(Root)!.qualifiedName!;
      const register = () => {
        if (path === 'runtime')
          return registerRuntimeModel({
            name: 'GeneratedKeyLeaf',
            packageName: '@test/generated-key',
            extends: parent,
            conflictColumns: ['total'],
            fields: {},
          });
        if (path === 'manifest') {
          const entry = runtimeModelEntry({
            name: 'GeneratedKeyLeaf',
            packageName: '@test/generated-key',
            extends: parent,
            fields: {},
          });
          entry.fields = {};
          entry.decoratorConfig!.conflictColumns = ['total'];
          return ObjectRegistry.registerFromManifest(
            entry.qualifiedName!,
            entry,
            '@test/generated-key',
          );
        }
        const Leaf = class GeneratedKeyLeaf extends Root {};
        smrt({
          packageName: '@test/generated-key',
          conflictColumns: ['total'],
        })(Leaf);
      };
      expect(register).toThrow(GeneratedFieldError);
    });
  }

  for (const engine of persistenceEngines) {
    for (const path of ['decoration', 'runtime'] as const) {
      it(`#4972 round3 item1: ${engine} ${path} three-level rows retain their custom owner`, async () => {
        const Root = class SavedOwnerRoot extends SmrtObject {};
        field({ type: 'text' })(Root.prototype, 'ownerSource');
        field({ type: 'integer' })(Root.prototype, 'qty');
        smrt({
          packageName: '@test/saved-owner',
          tableName: 'saved_owner_rows',
          tableStrategy: 'sti',
          tenantScoped: { field: 'organizationId' },
        })(Root);
        const Middle = class SavedOwnerMiddle extends Root {};
        smrt({ packageName: '@test/saved-owner' })(Middle);
        let name: string;
        if (path === 'runtime') {
          name = registerRuntimeModel({
            name: 'SavedOwnerLeaf',
            packageName: '@test/saved-owner',
            extends:
              ObjectRegistry.getClassByConstructor(Middle)!.qualifiedName!,
            fields: { total: { type: 'integer', generated: { col: 'qty' } } },
          });
        } else {
          const Leaf = class SavedOwnerLeaf extends Middle {};
          field({ type: 'integer', generated: { col: 'qty' } })(
            Leaf.prototype,
            'total',
          );
          smrt({ packageName: '@test/saved-owner' })(Leaf);
          name = ObjectRegistry.getClassByConstructor(Leaf)!.qualifiedName!;
        }
        expect(ObjectRegistry.getOwnershipTenantColumn(name)).toBe(
          'organization_id',
        );
        const db = await getTestDatabase({
          type: engine === 'sqlite' ? 'sqlite' : 'pglite',
          classes: [],
          includeSystemTables: false,
        });
        databases.push(db);
        for (const sql of await planRuntimeModelDDL(
          name,
          engine,
          async () => null,
        ))
          await db.query(sql);
        const collection = await ObjectRegistry.getCollection(name, { db });
        const owner = '11111111-1111-4111-8111-111111111111';
        const row = await collection.create({
          organizationId: owner,
          ownerSource: 'untrusted',
          qty: 5,
        });
        await collection.update(row.id!, { qty: 7, ownerSource: 'changed' });
        expect(
          (
            await db.query(
              'SELECT organization_id, total FROM saved_owner_rows',
            )
          ).rows,
        ).toEqual([
          expect.objectContaining({ organization_id: owner, total: 7 }),
        ]);
      });
    }
  }

  for (const path of ['decoration', 'manifest', 'runtime'] as const) {
    it(`#4972: refuses implicit tenantId generation at ${path}`, () => {
      const def: RuntimeModelDefinition = {
        name: 'ImplicitGeneratedOwner',
        packageName: '@test/generated-owner',
        fields: {
          ownerSource: { type: 'text' },
          tenantId: { type: 'text' },
        },
      };
      const ordinary = runtimeModelEntry(def);
      const expression = { col: 'ownerSource' };
      const register = () => {
        if (path === 'runtime') {
          def.fields!.tenantId.generated = expression;
          return registerRuntimeModel(def);
        }
        if (path === 'manifest') {
          ordinary.fields.tenantId.generated = expression;
          return ObjectRegistry.registerFromManifest(
            '@test/generated-owner:ImplicitGeneratedOwner',
            ordinary,
            def.packageName,
          );
        }
        const Model = class ImplicitGeneratedOwner extends SmrtObject {};
        field({ type: 'text' })(Model.prototype, 'ownerSource');
        field({ type: 'text', generated: expression })(
          Model.prototype,
          'tenantId',
        );
        smrt({ packageName: def.packageName })(Model);
      };
      expect(register).toThrow(GeneratedFieldError);
      expect(register).toThrow(
        expect.objectContaining({
          code: 'VALIDATION_GENERATED_EXPRESSION',
        }),
      );
    });
  }

  it('#4972: ordinary implicit ownership and custom tenancy remain valid', () => {
    for (const tenant of ['tenantId', 'organizationId']) {
      const name = registerRuntimeModel({
        name: `OrdinaryOwner${tenant}`,
        packageName: '@test/generated-owner',
        ...(tenant === 'organizationId'
          ? { tenantScoped: { field: tenant } }
          : {}),
        fields: { [tenant]: { type: 'text' } },
      });
      expect(ObjectRegistry.getOwnershipTenantColumn(name)).toBe(
        tenant === 'tenantId' ? 'tenant_id' : 'organization_id',
      );
    }
    expect(() =>
      runtimeModelEntry({
        name: 'CustomGeneratedOwner',
        packageName: '@test/generated-owner',
        tenantScoped: { field: 'organizationId' },
        fields: {
          source: { type: 'text' },
          organizationId: { type: 'text', generated: { col: 'source' } },
        },
      }),
    ).toThrow(GeneratedFieldError);
  });

  it('#4972: refuses identity, primary-key, reference and authority system fields', () => {
    const fields: [string, FieldDefinition][] = [
      ...[
        'id',
        'slug',
        'context',
        'createdAt',
        'updatedAt',
        'created_at',
        'updated_at',
        '_meta_type',
        '_meta_data',
        '_sync_revision',
        '_sync_origin_device_id',
      ].map((name): [string, FieldDefinition] => [name, { type: 'text' }]),
      ['key', { type: 'text', _meta: { primaryKey: true } }],
      ['reference', { type: 'foreignKey', related: 'Other' }],
      ['external', { type: 'crossPackageRef', related: '@other/pkg:Other' }],
    ];
    for (const [name, field] of fields) {
      expect(
        () =>
          validateGeneratedFields(
            new Map([
              ['source', { type: 'text' }],
              [name, { ...field, generated: { col: 'source' } }],
            ]),
          ),
        name,
      ).toThrow(GeneratedFieldError);
    }
  });

  it('#4972: resolves same-named parents by constructor identity', () => {
    const First = class GeneratedSameParent extends SmrtObject {};
    field({ type: 'integer' })(First.prototype, 'wrong');
    smrt({
      packageName: '@test/generated-first',
      tableStrategy: 'sti',
      tableName: 'generated_first',
    })(First);
    const Real = class GeneratedSameParent extends SmrtObject {};
    field({ type: 'integer' })(Real.prototype, 'qty');
    smrt({
      packageName: '@test/generated-real',
      tableStrategy: 'sti',
      tableName: 'generated_real',
    })(Real);
    const Child = class GeneratedExactChild extends Real {};
    field({ type: 'integer', generated: { col: 'qty' } })(
      Child.prototype,
      'total',
    );
    expect(() =>
      smrt({ packageName: '@test/generated-real' })(Child),
    ).not.toThrow();
    expect(ObjectRegistry.getClassByConstructor(Child)?.extends).toBe(
      '@test/generated-real:GeneratedSameParent',
    );
  });

  for (const engine of persistenceEngines) {
    for (const path of ['decoration', 'manifest'] as const) {
      it(`#4972: ${engine} three-level ${path} ancestry registers and computes`, async () => {
        const pkg = '@test/generated-ancestry';
        let child: QualifiedClassName;
        if (path === 'decoration') {
          const A = class GeneratedAncestor extends SmrtObject {};
          field({ type: 'integer' })(A.prototype, 'qty');
          smrt({
            packageName: pkg,
            tableStrategy: 'sti',
            tableName: 'generated_ancestry',
          })(A);
          const B = class GeneratedMiddle extends A {};
          field({ type: 'integer', generated: { col: 'qty' } })(
            B.prototype,
            'total',
          );
          smrt({ packageName: pkg })(B);
          const C = class GeneratedLeaf extends B {};
          smrt({ packageName: pkg })(C);
          child = ObjectRegistry.getClassByConstructor(C)!.qualifiedName!;
        } else {
          const entry = runtimeModelEntry({
            name: 'GeneratedAncestor',
            packageName: pkg,
            tableName: 'generated_ancestry',
            fields: { qty: { type: 'integer' } },
          });
          entry.decoratorConfig!.tableStrategy = 'sti';
          ObjectRegistry.registerFromManifest(
            `${pkg}:GeneratedAncestor`,
            entry,
            pkg,
          );
          const middle: SmartObjectDefinition = {
            ...entry,
            name: 'generatedmiddle',
            className: 'GeneratedMiddle',
            qualifiedName: `${pkg}:GeneratedMiddle`,
            extends: 'GeneratedAncestor',
            extendsQualified: `${pkg}:GeneratedAncestor`,
            fields: {
              total: { type: 'integer' as const, generated: { col: 'qty' } },
            },
          };
          ObjectRegistry.registerFromManifest(
            `${pkg}:GeneratedMiddle`,
            middle,
            pkg,
          );
          child = `${pkg}:GeneratedLeaf`;
          ObjectRegistry.registerFromManifest(
            child,
            {
              ...middle,
              name: 'generatedleaf',
              className: 'GeneratedLeaf',
              qualifiedName: child,
              extends: 'GeneratedMiddle',
              extendsQualified: `${pkg}:GeneratedMiddle`,
              fields: {},
            },
            pkg,
          );
        }
        const db = await getTestDatabase({
          type: engine === 'sqlite' ? 'sqlite' : 'pglite',
          classes: [],
          includeSystemTables: false,
        });
        databases.push(db);
        for (const sql of await planRuntimeModelDDL(
          child,
          engine,
          async () => null,
        ))
          await db.query(sql);
        const collection = await ObjectRegistry.getCollection(child, { db });
        const row = await collection.create({ qty: 6 });
        expect(row.toJSON()).toHaveProperty('total', 6);
      });
    }

    it(`#4972: ${engine} converts the last generated column to ordinary and back`, async () => {
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      const schema: SchemaDefinition = {
        tableName: 'generated_conversion',
        columns: {
          qty: { type: 'INTEGER' },
          total: { type: 'INTEGER', generated: { col: 'qty' } },
        },
        indexes: [{ name: 'conversion_total_idx', columns: ['total'] }],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1',
      };
      await db.query(getDDLStrategy(engine).generateCreateTable(schema));
      for (const sql of getDDLStrategy(engine).generateIndexes(schema))
        await db.query(sql);
      await db.query('INSERT INTO generated_conversion (qty) VALUES (6)');
      const previousSchemas = { generated_conversion: structuredClone(schema) };
      schema.columns.total = { type: 'INTEGER', defaultValue: 17 };
      const schemas = { generated_conversion: schema };
      const parity = () =>
        checkLiveSchemaParity({
          db,
          schemas,
          previousSchemas,
          engineHint: engine,
          includeSystemTables: false,
        });
      expect((await parity()).findings).toContainEqual(
        expect.objectContaining({
          kind: 'generated_expression_drift',
          target: 'total',
        }),
      );
      const diff = await new SchemaComparer(db, {
        engineHint: engine,
        previousSchemas,
      }).compare(schemas);
      const conversion = diff.changes.find(
        (change) => change.name === 'total',
      )!;
      expect(conversion.type).toBe('alter_column');
      const apply = async (executor: DatabaseInterface) => {
        for (const change of diff.changes.filter(
          (change) => change.name === 'total',
        ))
          for (const sql of change.sqlStatements ?? [change.sql!])
            await executor.query(sql);
      };
      // DDL and data changes roll back together on both supported engines.
      await expect(
        db.transaction!(async (tx) => {
          await apply(tx);
          throw new Error('conversion rollback');
        }),
      ).rejects.toThrow('conversion rollback');
      expect((await parity()).findings).toContainEqual(
        expect.objectContaining({
          kind: 'generated_expression_drift',
          target: 'total',
        }),
      );
      await db.transaction!(apply);
      expect(
        Number(
          (await db.query('SELECT total FROM generated_conversion')).rows[0]
            .total,
        ),
      ).toBe(engine === 'postgres' ? 6 : 17);
      await db.query('UPDATE generated_conversion SET total = 99');
      expect(
        Number(
          (await db.query('SELECT total FROM generated_conversion')).rows[0]
            .total,
        ),
      ).toBe(99);
      expect(
        (await parity()).findings.filter(
          (finding) => finding.target === 'total',
        ),
      ).toEqual([]);
      expect(
        (
          await new SchemaComparer(db, {
            engineHint: engine,
            previousSchemas,
          }).compare(schemas)
        ).changes.filter((change) => change.name === 'total'),
      ).toEqual([]);
      schema.columns.total = { type: 'INTEGER', generated: { col: 'qty' } };
      expect((await parity()).findings).toContainEqual(
        expect.objectContaining({ kind: 'generated_expression_drift' }),
      );
      const back = await new SchemaComparer(db, {
        engineHint: engine,
        previousSchemas,
      }).compare(schemas);
      const replacement = back.changes.find(
        (change) => change.name === 'total',
      )!;
      await db.transaction!(async (tx) => {
        for (const sql of replacement.sqlStatements!) await tx.query(sql);
      });
      expect(
        Number(
          (await db.query('SELECT total FROM generated_conversion')).rows[0]
            .total,
        ),
      ).toBe(6);
      expect(
        (await parity()).findings.filter(
          (finding) => finding.target === 'total',
        ),
      ).toEqual([]);
    });
  }

  it('#4972: SQLite required conversion without a default preserves the live column as manual drift', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: [],
      includeSystemTables: false,
    });
    databases.push(db);
    await db.query(
      'CREATE TABLE required_conversion (qty INTEGER, total INTEGER GENERATED ALWAYS AS (qty) VIRTUAL)',
    );
    await db.query('INSERT INTO required_conversion (qty) VALUES (6)');
    const schema: SchemaDefinition = {
      tableName: 'required_conversion',
      columns: {
        qty: { type: 'INTEGER' },
        total: { type: 'INTEGER', notNull: true },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1',
    };
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      { required_conversion: schema },
    );
    const change = diff.changes.find((change) => change.name === 'total')!;
    expect(change.sql).toContain('requires an explicit data migration');
    expect(change.sqlStatements).toBeUndefined();
    expect(
      (await db.query('SELECT total FROM required_conversion')).rows[0].total,
    ).toBe(6);
    // A nullable ordinary column can be installed; there are no virtual values to retain.
    schema.columns.total.notNull = false;
    const nullable = await new SchemaComparer(db, {
      engineHint: 'sqlite',
    }).compare({ required_conversion: schema });
    const conversion = nullable.changes.find(
      (change) => change.name === 'total',
    )!;
    await db.transaction!(async (tx) => {
      for (const sql of conversion.sqlStatements!) await tx.query(sql);
    });
    expect(
      (await db.query('SELECT total FROM required_conversion')).rows[0].total,
    ).toBeNull();
    await db.query('UPDATE required_conversion SET total = 42');
    expect(
      (await db.query('SELECT total FROM required_conversion')).rows[0].total,
    ).toBe(42);
  });

  for (const operation of ['add', 'change', 'ordinary-to-generated'] as const) {
    it(`#4972 round2 item1: DuckDB refuses ${operation} before a real migration can alter data`, async () => {
      const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
      databases.push(db);
      await db.query(
        operation === 'add'
          ? 'CREATE TABLE duck_generated (qty INTEGER)'
          : operation === 'change'
            ? 'CREATE TABLE duck_generated (qty INTEGER, total INTEGER GENERATED ALWAYS AS (qty * 2) VIRTUAL)'
            : 'CREATE TABLE duck_generated (qty INTEGER, total INTEGER)',
      );
      await db.query(
        operation === 'ordinary-to-generated'
          ? 'INSERT INTO duck_generated (qty, total) VALUES (5, 77)'
          : 'INSERT INTO duck_generated (qty) VALUES (5)',
      );
      const schema: SchemaDefinition = {
        tableName: 'duck_generated',
        columns: {
          qty: { type: 'INTEGER' },
          total: {
            type: 'INTEGER',
            generated: { op: 'add', left: { col: 'qty' }, right: { value: 1 } },
          },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1',
      };
      const migrate = async () => {
        const diff = await new SchemaComparer(db, {
          engineHint: 'duckdb',
        }).compare({ duck_generated: schema });
        for (const change of diff.changes)
          for (const sql of change.sqlStatements ??
            (change.sql ? [change.sql] : []))
            await db.query(sql);
      };
      await expect(migrate()).rejects.toMatchObject({
        code: 'VALIDATION_GENERATED_DIALECT',
        name: 'GeneratedFieldError',
      });
      const row = (await db.query('SELECT * FROM duck_generated')).rows[0];
      expect(Number(row.qty)).toBe(5);
      if (operation !== 'add')
        expect(Number(row.total)).toBe(operation === 'change' ? 10 : 77);
      else expect(row).not.toHaveProperty('total');
    });
  }

  it('#4972 round2 item1: real DuckDB creates and computes a new VIRTUAL column', async () => {
    const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    databases.push(db);
    const schema: SchemaDefinition = {
      tableName: 'duck_new_generated',
      columns: {
        qty: { type: 'INTEGER' },
        total: {
          type: 'INTEGER',
          generated: { op: 'mul', left: { col: 'qty' }, right: { value: 2 } },
        },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1',
    };
    await db.query(getDDLStrategy('duckdb').generateCreateTable(schema));
    await db.query('INSERT INTO duck_new_generated (qty) VALUES (5)');
    expect(
      Number(
        (await db.query('SELECT total FROM duck_new_generated')).rows[0].total,
      ),
    ).toBe(10);
  });

  for (const engine of persistenceEngines) {
    it(`#4972 round2 item2: ${engine} refuses datetime inputs nested in boolean generated expressions`, async () => {
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      const literal = {
        value: { kind: 'datetime', iso: '2024-01-01T00:00:00Z' },
      } as const;
      const expressions: GeneratedExpression[] = [
        { op: 'gt', left: { col: 'time' }, right: literal },
        {
          op: 'isNull',
          operand: { op: 'coalesce', operands: [{ col: 'time' }, literal] },
        },
        { op: 'isNull', operand: { col: 'time' } },
        { op: 'eq', left: literal, right: literal },
      ];
      for (const generated of expressions) {
        expect(() =>
          runtimeModelEntry({
            name: 'UnsafeBoolean',
            packageName: '@test/generated',
            fields: {
              time: { type: 'datetime' },
              result: { type: 'boolean', generated },
            },
          }),
        ).toThrow(
          expect.objectContaining({
            code: 'VALIDATION_GENERATED_NON_IMMUTABLE',
          }),
        );
        expect(() =>
          compileGeneratedExpression(generated, 'postgres', {
            time: 'datetime',
          }),
        ).toThrow(
          expect.objectContaining({
            code: 'VALIDATION_GENERATED_NON_IMMUTABLE',
          }),
        );
      }
      // Date-only literals are still portable and execute on the actual engine.
      await db.query(
        getDDLStrategy(engine).generateCreateTable({
          tableName: 'safe_generated_date',
          columns: {
            qty: { type: 'INTEGER' },
            year: {
              type: 'INTEGER',
              generated: {
                op: 'year',
                value: { value: { kind: 'date', iso: '2024-01-01' } },
              },
            },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1',
        }),
      );
      await db.query('INSERT INTO safe_generated_date (qty) VALUES (1)');
      expect(
        Number(
          (await db.query('SELECT year FROM safe_generated_date')).rows[0].year,
        ),
      ).toBe(2024);
    });

    it(`#4972 round2 item3: ${engine} warns before discarding an ordinary column's values`, async () => {
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      await db.query(
        'CREATE TABLE destructive_generated (qty INTEGER, total INTEGER)',
      );
      await db.query(
        'INSERT INTO destructive_generated (qty, total) VALUES (5, 77)',
      );
      const schema: SchemaDefinition = {
        tableName: 'destructive_generated',
        columns: {
          qty: { type: 'INTEGER' },
          total: { type: 'INTEGER', generated: { col: 'qty' } },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1',
      };
      const diff = await new SchemaComparer(db, { engineHint: engine }).compare(
        { destructive_generated: schema },
      );
      const change = diff.changes.find((change) => change.name === 'total')!;
      expect(change.advisory).toMatchObject({
        severity: 'warning',
        message: expect.stringMatching(/discard.*values/i),
      });
      expect(
        Number(
          (await db.query('SELECT total FROM destructive_generated')).rows[0]
            .total,
        ),
      ).toBe(77);
      await db.transaction!(async (tx) => {
        for (const sql of change.sqlStatements!) await tx.query(sql);
      });
      expect(
        Number(
          (await db.query('SELECT total FROM destructive_generated')).rows[0]
            .total,
        ),
      ).toBe(5);
    });
  }

  it('#4972 round2 item6: SQLite adds and enforces a unique generated column on populated storage', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: [],
      includeSystemTables: false,
    });
    databases.push(db);
    await db.query('CREATE TABLE unique_generated (qty INTEGER)');
    await db.query('INSERT INTO unique_generated (qty) VALUES (5), (7)');
    const schema: SchemaDefinition = {
      tableName: 'unique_generated',
      columns: {
        qty: { type: 'INTEGER' },
        total: { type: 'INTEGER', unique: true, generated: { col: 'qty' } },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1',
    };
    const diff = await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
      { unique_generated: schema },
    );
    const change = diff.changes.find((change) => change.name === 'total')!;
    await db.transaction!(async (tx) => {
      for (const sql of change.sqlStatements ?? [change.sql!])
        await tx.query(sql);
    });
    expect(
      (
        await db.query('SELECT total FROM unique_generated ORDER BY total')
      ).rows.map((row) => Number(row.total)),
    ).toEqual([5, 7]);
    await expect(
      db.query('INSERT INTO unique_generated (qty) VALUES (5)'),
    ).rejects.toThrow();
    schema.columns.total.generated = {
      op: 'add',
      left: { col: 'qty' },
      right: { value: 1 },
    };
    const replacement = (
      await new SchemaComparer(db, { engineHint: 'sqlite' }).compare({
        unique_generated: schema,
      })
    ).changes.find((change) => change.name === 'total')!;
    await db.transaction!(async (tx) => {
      for (const sql of replacement.sqlStatements!) await tx.query(sql);
    });
    expect(
      (
        await db.query('SELECT total FROM unique_generated ORDER BY total')
      ).rows.map((row) => Number(row.total)),
    ).toEqual([6, 8]);
    await expect(
      db.query('INSERT INTO unique_generated (qty) VALUES (5)'),
    ).rejects.toThrow();
  });

  for (const engine of persistenceEngines) {
    for (const transport of ['REST', 'MCP', 'SvelteKit'] as const) {
      it(`#4972 round2 item7: ${engine} ${transport} round-trips a fetched record and drops generated/readonly keys`, async () => {
        const db = await getTestDatabase({
          type: engine === 'sqlite' ? 'sqlite' : 'pglite',
          classes: [],
          includeSystemTables: false,
        });
        databases.push(db);
        const def = definition();
        def.fields!.serverNote = { type: 'text', default: 'server' };
        const entry = runtimeModelEntry(def);
        entry.fields.serverNote.readonly = true;
        entry.decoratorConfig!.api = {
          include: ['get', 'create', 'update'],
          public: true,
        };
        const name = '@test/generated:GeneratedInvoice';
        ObjectRegistry.registerFromManifest(name, entry, def.packageName);
        for (const sql of await planRuntimeModelDDL(
          name,
          engine,
          async () => null,
        ))
          await db.query(sql);
        const collection = await ObjectRegistry.getCollection(name, { db });
        const row = await collection.create({ qty: 2, unitPrice: 3 });
        const fetched = (await collection.get(row.id!, {
          cache: false,
        }))!.toPublicJSON();
        expect(fetched).toHaveProperty('total', 6);
        const body = { ...fetched, qty: 4, total: 999, serverNote: 'forged' };
        if (transport === 'REST') {
          const api = new APIGenerator({ basePath: '/api' }, { db });
          api.registerCollection('generated_invoices', collection);
          const response = await api.generateHandler()(
            new Request(`http://test/api/generated_invoices/${row.id}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
          );
          expect(response.status).toBe(200);
        } else if (transport === 'MCP') {
          const generator = new MCPGenerator({ classNames: [name] }, { db });
          const response = await generator.handleToolCall({
            method: 'tools/call',
            params: {
              name: 'generatedinvoice_update',
              arguments: body,
            },
          });
          expect(response.isError, JSON.stringify(response)).not.toBe(true);
        } else {
          const root = await mkdtemp(
            join(tmpdir(), 'smrt-generated-roundtrip-'),
          );
          try {
            await generateSvelteKitRoutes(
              root,
              {
                packageName: def.packageName,
                version: '1',
                timestamp: 0,
                objects: { [name]: entry },
              } as SmartObjectManifest,
              {
                enabled: true,
                routesDir: 'src/routes/api',
                objectsDir: 'src/lib/objects',
                configPath: 'src/lib/server',
                configFileName: 'smrt.ts',
              },
            );
            const source = await readFile(
              join(root, 'src/routes/api/generated_invoices/[id]/+server.ts'),
              'utf8',
            );
            const js = ts.transpileModule(source, {
              compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
              },
            }).outputText;
            const core = await import('../index.js');
            const exports: {
              PUT?: (event: {
                request: Request;
                params: { id: string };
                locals: object;
              }) => Promise<Response>;
            } = {};
            const require = (specifier: string): unknown => {
              if (specifier === '@happyvertical/smrt-core') return core;
              if (specifier === '@sveltejs/kit')
                return {
                  json: (data: unknown, init?: ResponseInit) =>
                    Response.json(data, init),
                  error: (status: number, message: string) =>
                    Object.assign(new Error(message), { status }),
                };
              if (specifier.includes('smrt-register')) return {};
              if (specifier.endsWith('/smrt'))
                return {
                  runtime: {
                    getCollection: async () => collection,
                    classOptions: () => ({ db }),
                  },
                };
              throw new Error(
                `Unexpected generated route import: ${specifier}`,
              );
            };
            // Execute the actual emitted PUT handler; no server or listening port.
            new Function('require', 'exports', js)(require, exports);
            expect(exports.PUT).toBeTypeOf('function');
            const response = await exports.PUT!({
              params: { id: row.id! },
              locals: {},
              request: new Request('http://test/item', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }),
            });
            expect(response.status).toBe(200);
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }
        const updated = (await collection.get(row.id!, {
          cache: false,
        }))!.toJSON();
        expect(updated).toMatchObject({
          qty: 4,
          total: 12,
          serverNote: 'server',
        });
        await expect(
          collection.update(row.id!, { total: 999 }),
        ).rejects.toMatchObject({ code: 'VALIDATION_GENERATED_FIELD_WRITE' });
      });
    }

    it(`#4972 round2 private naming: ${engine} a user generatedValues field does not collide with hydration bookkeeping`, async () => {
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      const def = definition();
      def.fields!.generatedValues = { type: 'text' };
      const name = registerRuntimeModel(def);
      for (const sql of await planRuntimeModelDDL(
        name,
        engine,
        async () => null,
      ))
        await db.query(sql);
      const collection = await ObjectRegistry.getCollection(name, { db });
      const row = await collection.create({
        generatedValues: 'user data',
        qty: 2,
        unitPrice: 3,
      });
      expect(row.toJSON()).toMatchObject({
        generatedValues: 'user data',
        total: 6,
      });
      await collection.update(row.id!, { qty: 4 });
      expect(
        (await collection.get(row.id!, { cache: false }))!.toJSON(),
      ).toMatchObject({ generatedValues: 'user data', total: 12 });
    });
  }

  for (const engine of persistenceEngines) {
    it(`#4972 round2 item2: ${engine} accepts supported expression depth with nested operand arrays`, async () => {
      let generated: GeneratedExpression = { col: 'qty' };
      for (let i = 0; i < 14; i++)
        generated = { op: 'coalesce', operands: [generated, { value: 0 }] };
      const name = registerRuntimeModel({
        name: 'NestedGenerated',
        packageName: '@test/generated',
        fields: {
          qty: { type: 'integer' },
          total: { type: 'integer', generated },
        },
      });
      const db = await getTestDatabase({
        type: engine === 'sqlite' ? 'sqlite' : 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      for (const sql of await planRuntimeModelDDL(
        name,
        engine,
        async () => null,
      ))
        await db.query(sql);
      const collection = await ObjectRegistry.getCollection(name, { db });
      expect((await collection.create({ qty: 5 })).toJSON()).toHaveProperty(
        'total',
        5,
      );
    });
  }

  for (const engine of [...persistenceEngines, 'duckdb'] as const) {
    it(`#4972 round3 item4: ${engine} ordinary diff and parity make zero generated catalog probes`, async () => {
      const db =
        engine === 'duckdb'
          ? await getDatabase({ type: 'duckdb', url: ':memory:' })
          : await getTestDatabase({
              type: engine === 'postgres' ? 'pglite' : 'sqlite',
              classes: [],
              includeSystemTables: false,
            });
      databases.push(db);
      await db.query('CREATE TABLE plain_probe (qty INTEGER)');
      const schemas: Record<string, SchemaDefinition> = {
        plain_probe: {
          tableName: 'plain_probe',
          columns: { qty: { type: 'INTEGER' } },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1',
        },
      };
      const query = db.query.bind(db);
      const probes: string[] = [];
      const spy = vi
        .spyOn(db, 'query')
        .mockImplementation(async (sql, ...values) => {
          if (
            /generation_expression|SELECT sql FROM (sqlite_master|duckdb_tables\(\))/i.test(
              sql,
            )
          ) {
            probes.push(sql);
            throw new Error('ordinary models must not read generated catalogs');
          }
          return query(sql, ...values);
        });
      try {
        await new SchemaComparer(db, { engineHint: engine }).compare(schemas);
        await checkLiveSchemaParity({
          db,
          schemas,
          engineHint: engine,
          includeSystemTables: false,
        });
        const previousSchemas = structuredClone(schemas);
        schemas.plain_probe.columns.added = { type: 'INTEGER' };
        await new SchemaComparer(db, {
          engineHint: engine,
          previousSchemas,
        }).compare(schemas);
        await checkLiveSchemaParity({
          db,
          schemas,
          previousSchemas,
          engineHint: engine,
          includeSystemTables: false,
        });
        expect(probes).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  }

  for (const expectedGenerated of [false, true]) {
    it(`#4972 round3 item4: failed SQLite fallback probe is ${expectedGenerated ? 'fatal for expected generated' : 'optional for unknown missing'} columns`, async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        classes: [],
        includeSystemTables: false,
      });
      databases.push(db);
      await db.query('CREATE TABLE failed_probe (qty INTEGER)');
      const schemas: Record<string, SchemaDefinition> = {
        failed_probe: {
          tableName: 'failed_probe',
          columns: {
            qty: { type: 'INTEGER' },
            total: {
              type: 'INTEGER',
              ...(expectedGenerated ? { generated: { col: 'qty' } } : {}),
            },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1',
        },
      };
      const failure = new Error('catalog unavailable');
      const query = db.query.bind(db);
      const spy = vi
        .spyOn(db, 'query')
        .mockImplementation(async (sql, ...values) => {
          if (/SELECT sql FROM sqlite_master/i.test(sql)) throw failure;
          return query(sql, ...values);
        });
      try {
        const diff = () =>
          new SchemaComparer(db, { engineHint: 'sqlite' }).compare(schemas);
        const parity = () =>
          checkLiveSchemaParity({
            db,
            schemas,
            engineHint: 'sqlite',
            includeSystemTables: false,
          });
        if (expectedGenerated) {
          await expect(diff()).rejects.toBe(failure);
          await expect(parity()).rejects.toBe(failure);
        } else {
          expect((await diff()).changes).toContainEqual(
            expect.objectContaining({ type: 'add_column', name: 'total' }),
          );
          expect((await parity()).findings).toContainEqual(
            expect.objectContaining({
              kind: 'missing_column',
              target: 'total',
            }),
          );
        }
      } finally {
        spy.mockRestore();
      }
    });
  }

  for (const engine of [...persistenceEngines, 'duckdb'] as const) {
    it(`#4972 round3 items4/5: ${engine} a previous snapshot reveals handwritten generated columns and warns before conversion`, async () => {
      const db =
        engine === 'duckdb'
          ? await getDatabase({ type: 'duckdb', url: ':memory:' })
          : await getTestDatabase({
              type: engine === 'sqlite' ? 'sqlite' : 'pglite',
              classes: [],
              includeSystemTables: false,
            });
      databases.push(db);
      await db.query(
        `CREATE TABLE manual_generated (qty INTEGER, total INTEGER GENERATED ALWAYS AS (qty * 2) ${engine === 'postgres' ? 'STORED' : 'VIRTUAL'})`,
      );
      await db.query('INSERT INTO manual_generated (qty) VALUES (5)');
      const schema: SchemaDefinition = {
        tableName: 'manual_generated',
        columns: { qty: { type: 'INTEGER' }, total: { type: 'INTEGER' } },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1',
      };
      const schemas = { manual_generated: schema };
      const previousSchemas = structuredClone(schemas);
      previousSchemas.manual_generated.columns.total.generated = {
        op: 'mul',
        left: { col: 'qty' },
        right: { value: 2 },
      };
      const parity = await checkLiveSchemaParity({
        db,
        schemas,
        previousSchemas,
        engineHint: engine,
        includeSystemTables: false,
      });
      expect(parity.findings).toContainEqual(
        expect.objectContaining({
          kind: 'generated_expression_drift',
          target: 'total',
        }),
      );
      const diff = await new SchemaComparer(db, {
        engineHint: engine,
        previousSchemas,
      }).compare(schemas);
      const change = diff.changes.find((change) => change.name === 'total')!;
      expect(change.advisory).toMatchObject({
        severity: 'warning',
        message: expect.stringMatching(/(generated|calculated)/i),
      });
      await db.transaction!(async (tx) => {
        for (const sql of change.sqlStatements ?? [change.sql!])
          await tx.query(sql);
      });
      await db.query('UPDATE manual_generated SET qty = 7');
      expect(
        (await db.query('SELECT total FROM manual_generated')).rows[0].total,
      ).toBe(engine === 'postgres' ? 10 : null);
    });
  }

  it('#4972 round2 item1: runtime DDL planning also refuses DuckDB generated additions', async () => {
    const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    databases.push(db);
    await db.query('CREATE TABLE duck_runtime_generated (qty INTEGER)');
    await db.query('INSERT INTO duck_runtime_generated (qty) VALUES (5)');
    const name = registerRuntimeModel({
      name: 'DuckRuntimeGenerated',
      packageName: '@test/generated',
      tableName: 'duck_runtime_generated',
      fields: {
        qty: { type: 'integer' },
        total: { type: 'integer', generated: { col: 'qty' } },
      },
    });
    await expect(
      planRuntimeModelDDL(name, 'duckdb', async (table) =>
        Object.keys((await db.getTableSchema!(table))!.columns),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_GENERATED_DIALECT' });
    expect(
      Number(
        (await db.query('SELECT qty FROM duck_runtime_generated')).rows[0].qty,
      ),
    ).toBe(5);
  });

  it('validates the closed grammar, reference rules, result types and bounds', () => {
    const check = (
      generated: unknown,
      extras: Record<string, FieldDefinition> = {},
    ) =>
      validateGeneratedFields(
        new Map(
          Object.entries({
            qty: { type: 'integer' as const },
            tmp: { type: 'integer' as const, transient: true },
            ...extras,
            total: {
              type: 'integer' as const,
              generated: generated as GeneratedExpression,
            },
          }),
        ),
      );
    for (const expression of [
      true,
      null,
      'qty * 2',
      {},
      { col: 'missing' },
      { col: 'tmp' },
      { col: 'total' },
      { col: 'other.qty' },
      { op: 'raw', sql: 'DROP TABLE x' },
      { col: 'qty', value: 1 },
      { value: Infinity },
      { value: 'wrong type' },
      { op: 'add', left: { col: 'qty' }, right: { value: 'bad' } },
      { op: 'and', operands: [{ col: 'qty' }] },
    ])
      expect(() => check(expression)).toThrow(GeneratedFieldError);
    expect(() =>
      check(
        { col: 'other' },
        { other: { type: 'integer', generated: { col: 'qty' } } },
      ),
    ).toThrow(GeneratedFieldError);
    let deep: GeneratedExpression = { col: 'qty' };
    for (let i = 0; i < 26; i++)
      deep = { op: 'add', left: deep, right: { value: 1 } };
    expect(() => check(deep)).toThrow(GeneratedFieldError);
    expect(() =>
      check({
        op: 'coalesce',
        operands: Array.from({ length: 1025 }, () => ({ col: 'qty' })),
      }),
    ).toThrow(GeneratedFieldError);
    expect(() =>
      runtimeModelEntry({
        ...definition(),
        fields: {
          ...definition().fields,
          total: { type: 'integer', generated: { col: 'missing' } },
        },
      }),
    ).toThrow(GeneratedFieldError);
    expect(
      generatedExpressionsEqual(
        '(a * (b + c))',
        {
          op: 'add',
          left: { op: 'mul', left: { col: 'a' }, right: { col: 'b' } },
          right: { col: 'c' },
        },
        'sqlite',
      ),
    ).toBe(false);
  });

  it('refuses nonimmutable temporal inputs and invalid new-node argument types', () => {
    const check = (
      generated: unknown,
      type: 'integer' | 'text' | 'decimal' = 'integer',
    ) =>
      runtimeModelEntry({
        name: 'InvalidPortable',
        packageName: '@test/portable',
        fields: {
          time: { type: 'datetime' },
          text: { type: 'text' },
          amount: { type: 'decimal' },
          result: { type, generated: generated as GeneratedExpression },
        },
      });
    for (const expression of [
      { op: 'day', value: { value: new Date() } },
      { op: 'length', value: { op: 'asText', operand: { col: 'time' } } },
    ])
      expect(() => check(expression)).toThrow(GeneratedFieldError);
    expect(() =>
      compileGeneratedExpression(
        { op: 'year', value: { col: 'time' } },
        'postgres',
        { time: 'datetime' },
      ),
    ).toThrow(
      expect.objectContaining({ code: 'VALIDATION_GENERATED_NON_IMMUTABLE' }),
    );
    for (const [expression, type] of [
      [
        {
          op: 'if',
          condition: { col: 'amount' },
          then: { value: 1 },
          else: { value: 0 },
        },
        'integer',
      ],
      [
        {
          op: 'case',
          branches: [
            { when: { value: true }, then: { value: 1 }, extra: true },
          ],
          else: { value: 0 },
        },
        'integer',
      ],
      [
        { op: 'round', value: { col: 'amount' }, digits: { value: 13 } },
        'decimal',
      ],
      [
        { op: 'least', operands: [{ col: 'amount' }, { col: 'text' }] },
        'decimal',
      ],
      [{ op: 'lower', value: { col: 'amount' } }, 'text'],
      [
        {
          op: 'substring',
          value: { col: 'text' },
          start: { value: 0 },
          length: { value: 1 },
        },
        'text',
      ],
      [
        { op: 'year', value: { value: { kind: 'date', iso: '2023-02-29' } } },
        'integer',
      ],
      [
        {
          op: 'day',
          value: {
            op: 'addDays',
            value: { value: { kind: 'date', iso: '2024-01-01' } },
            days: { value: 400000 },
          },
        },
        'integer',
      ],
    ] as const)
      expect(() => check(expression, type)).toThrow(GeneratedFieldError);
  });

  it('owns expression metadata and rejects unsupported policy combinations before refresh', () => {
    const def = definition();
    const name = registerRuntimeModel(def);
    const expr = def.fields!.total.generated as { op: string };
    expr.op = 'raw';
    expect(
      ObjectRegistry.getFields(name).get('total')?._meta?.generated,
    ).toMatchObject({ op: 'mul' });
    expect(() => registerRuntimeModel(def, { refresh: true })).toThrow(
      GeneratedFieldError,
    );
    expect(
      ObjectRegistry.getFields(name).get('total')?._meta?.generated,
    ).toMatchObject({ op: 'mul' });
    expect(() =>
      runtimeModelEntry({
        name: 'MultiPolicy',
        packageName: '@test/generated',
        fields: {
          a: { type: 'integer', readPermission: 'a.read' },
          b: { type: 'integer', readPermission: 'b.read' },
          total: {
            type: 'integer',
            generated: { op: 'add', left: { col: 'a' }, right: { col: 'b' } },
          },
        },
      }),
    ).toThrow(GeneratedFieldError);
  });

  it('quotes literals safely and preserves placeholder-shaped string contents', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      classes: [],
      includeSystemTables: false,
    });
    databases.push(db);
    const expression: GeneratedExpression = {
      op: 'coalesce',
      operands: [{ col: 'label' }, { value: "x'$1\\y" }],
    };
    const sql = compileGeneratedExpression(expression, 'sqlite');
    await db.query(
      `CREATE TABLE generated_literals (label TEXT, value TEXT GENERATED ALWAYS AS (${sql}) VIRTUAL)`,
    );
    await db.query('INSERT INTO generated_literals(label) VALUES (NULL)');
    expect(
      (await db.query('SELECT value FROM generated_literals')).rows[0].value,
    ).toBe("x'$1\\y");
  });

  it('inherits sensitivity and read permission from dependencies', async () => {
    const name = registerRuntimeModel({
      ...definition(),
      fields: {
        secret: { type: 'integer', sensitive: true },
        gated: { type: 'integer', readPermission: 'cost.read' },
        hidden: { type: 'integer', generated: { col: 'secret' } },
        permitted: { type: 'integer', generated: { col: 'gated' } },
      },
    });
    const fields = ObjectRegistry.getFields(name);
    expect(fields.get('hidden')?._meta?.sensitive).toBe(true);
    expect(fields.get('permitted')?._meta?.readPermission).toBe('cost.read');
    const ctor = ObjectRegistry.getClass(name)!.constructor;
    const record = new ctor({ _skipLoad: true });
    await record.initialize();
    Object.assign(record, { secret: 5, gated: 7, hidden: 5, permitted: 7 });
    expect(record.toPublicJSON()).not.toHaveProperty('hidden');
    expect(record.toPublicJSON()).not.toHaveProperty('permitted');
    expect(record.toPublicJSON({ permissions: ['cost.read'] })).toHaveProperty(
      'permitted',
      7,
    );
  });

  it('keeps generated fields in output schemas and excludes them from write schemas', async () => {
    const name = registerRuntimeModel(definition());
    const generator = new MCPGenerator({ name: 'test', version: '1' });
    const tools = await generator.generateTools();
    const create = tools.find(
      (tool) => tool.name === 'generatedinvoice_create',
    )!;
    const update = tools.find(
      (tool) => tool.name === 'generatedinvoice_update',
    )!;
    expect(create).toBeDefined();
    expect(create.inputSchema.properties).not.toHaveProperty('total');
    expect(update.inputSchema.properties).not.toHaveProperty('total');
    expect(JSON.stringify(create.outputSchema)).toContain('total');
    const spec = generateOpenAPISpec() as {
      components: {
        schemas: Record<string, { properties: Record<string, unknown> }>;
      };
    };
    expect(spec.components.schemas.GeneratedInvoice.properties).toHaveProperty(
      'total',
    );
    expect(
      spec.components.schemas.GeneratedInvoiceInput.properties,
    ).not.toHaveProperty('total');
    expect(ObjectRegistry.getFields(name).has('total')).toBe(true);
  });
});

describe('generated column introspection #4915', () => {
  it('reads a generated column declared with a parameterised type', async () => {
    const { readGeneratedColumns } = await import('../generated-fields.js');
    const db = {
      async query() {
        return {
          rows: [
            {
              sql: 'CREATE TABLE t (qty INTEGER, "total" DECIMAL(18,3) GENERATED ALWAYS AS ((qty * 2)) VIRTUAL, plain NUMERIC(10, 2))',
            },
          ],
        };
      },
    };
    const columns = await readGeneratedColumns(db, 't', 'duckdb');
    expect([...columns]).toEqual([['total', '(qty * 2)']]);
  });
});
