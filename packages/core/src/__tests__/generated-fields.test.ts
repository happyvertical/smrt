// biome-ignore-all lint/suspicious/noThenProperty: SQL SDK conditionals require a non-callable then data property.
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
} from '../scanner/types.js';
import { detectEngine, getDDLStrategy } from '../schema/ddl/index.js';
import { checkLiveSchemaParity } from '../schema/live-parity.js';
import { manifestColumnsToDefinitions } from '../schema/manifest-schema.js';
import type { SchemaDefinition } from '../schema/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

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
          body: JSON.stringify({ qty: 2, total: 99 }),
        }),
      );
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({
        error: { code: 'VALIDATION_GENERATED_FIELD_WRITE' },
      });
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
          'typedDatetime',
          'integer',
          {
            op: 'day',
            value: {
              value: { kind: 'datetime', iso: '2024-02-29T23:30:00-02:00' },
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
      schema.columns.total = { type: 'INTEGER', defaultValue: 17 };
      const schemas = { generated_conversion: schema };
      const parity = () =>
        checkLiveSchemaParity({
          db,
          schemas,
          engineHint: engine,
          includeSystemTables: false,
        });
      expect((await parity()).findings).toContainEqual(
        expect.objectContaining({
          kind: 'generated_expression_drift',
          target: 'total',
        }),
      );
      const diff = await new SchemaComparer(db, { engineHint: engine }).compare(
        schemas,
      );
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
          await new SchemaComparer(db, { engineHint: engine }).compare(schemas)
        ).changes.filter((change) => change.name === 'total'),
      ).toEqual([]);
      schema.columns.total = { type: 'INTEGER', generated: { col: 'qty' } };
      expect((await parity()).findings).toContainEqual(
        expect.objectContaining({ kind: 'generated_expression_drift' }),
      );
      const back = await new SchemaComparer(db, { engineHint: engine }).compare(
        schemas,
      );
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
