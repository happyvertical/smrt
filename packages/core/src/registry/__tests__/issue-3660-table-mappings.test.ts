import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../../collection.js';
import {
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '../../migrations/orchestrate.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import type { SmartObjectDefinition } from '../../scanner/types.js';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import { getTestDatabase } from '../../testing/database.js';

const APP = '@fixture/app';
const MESSAGES = '@fixture/messages';
function register(
  packageName: string,
  className = 'Attachment',
  target?: string,
  config: SmartObjectDefinition['decoratorConfig'] = {},
) {
  const tableName =
    config.tableName ||
    (target ? `${className.toLowerCase()}s` : 'attachments');
  const definition = {
    name: className.toLowerCase(),
    className,
    packageName,
    extends: 'SmrtObject',
    collection: tableName,
    filePath: `${packageName}/${className}.ts`,
    fields: target
      ? { attachmentId: { type: 'foreignKey', related: target } }
      : { label: { type: 'text' } },
    methods: {},
    decoratorConfig: { tableName, ...config },
    schema: {
      tableName,
      ddl: '',
      version: 'test',
      columns: target
        ? {
            attachment_id: {
              type: 'UUID',
              foreignKey: { table: 'attachments', column: 'id' },
            },
          }
        : { label: { type: 'TEXT' } },
      indexes: [
        {
          name: `${tableName}_label_idx`,
          columns: target ? ['attachment_id'] : ['label'],
          unique: false,
        },
      ],
    },
  } as SmartObjectDefinition;
  ObjectRegistry.registerFromManifest(
    `${packageName}:${className}`,
    definition,
  );
  return definition;
}
function bind(
  value: unknown = { [`${MESSAGES}:Attachment`]: 'message_attachments' },
) {
  setConfig({ smrt: { tableNames: value } } as never);
}
afterEach(() => {
  ObjectRegistry.clear();
  clearCache();
});

describe('#3660 qualified deployment table bindings', () => {
  it('retains strict collision detection without an explicit binding', () => {
    register(APP);
    register(MESSAGES);
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      /claimed by unrelated classes/,
    );
  });
  for (const order of [
    [APP, MESSAGES],
    [MESSAGES, APP],
  ]) {
    it(`isolates schemas and runtime storage with ${order[0]} registered first`, () => {
      for (const pkg of order) register(pkg);
      bind();
      const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
      expect(Object.keys(schemas)).toEqual(
        expect.arrayContaining(['attachments', 'message_attachments']),
      );
      expect(schemas.message_attachments.indexes.map((x) => x.name)).toContain(
        'message_attachments_label_idx',
      );
      expect(ObjectRegistry.getTableName(`${APP}:Attachment`)).toBe(
        'attachments',
      );
      expect(ObjectRegistry.getTableName(`${MESSAGES}:Attachment`)).toBe(
        'message_attachments',
      );
      for (const pkg of order) {
        const ctor = class Attachment extends SmrtObject {};
        ObjectRegistry.register(ctor, {
          packageName: pkg,
          tableName: 'attachments',
        });
        const collection = class extends SmrtCollection<SmrtObject> {
          static readonly _itemClass = ctor;
        };
        expect(new collection().tableName).toBe(
          pkg === APP ? 'attachments' : 'message_attachments',
        );
        expect(new ctor().tableName).toBe(
          pkg === APP ? 'attachments' : 'message_attachments',
        );
      }
      register(MESSAGES);
      expect(
        ObjectRegistry.getSchema(`${MESSAGES}:Attachment`)?.tableName,
      ).toBe('message_attachments');
    });
  }
  it('remaps foreign keys by target identity while preserving application references', () => {
    register(APP);
    register(MESSAGES);
    register(APP, 'AppLink', `${APP}:Attachment`);
    register(MESSAGES, 'MessageLink', `${MESSAGES}:Attachment`);
    bind();
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(schemas.applinks.columns.attachment_id.foreignKey?.table).toBe(
      'attachments',
    );
    expect(schemas.messagelinks.columns.attachment_id.foreignKey?.table).toBe(
      'message_attachments',
    );
    for (const dialect of ['sqlite', 'postgres', 'duckdb'] as const) {
      const ddl = getDDLStrategy(dialect).generateCreateTable(
        schemas.message_attachments,
      );
      expect(ddl).toContain('"message_attachments"');
      expect(ddl).not.toContain('"attachments"');
      expect(ddl.toUpperCase()).toContain(
        dialect === 'sqlite' ? 'TEXT' : 'UUID',
      );
    }
  });
  for (const dialect of ['sqlite', 'duckdb'] as const) {
    it(`preserves existing ${dialect} rows through an additive migration and repeat diff`, async () => {
      register(APP);
      const db = await getDatabase({ type: dialect, url: ':memory:' });
      const original = ObjectRegistry.getAllSchemasAsDefinitions().attachments;
      await db.query(getDDLStrategy(dialect).generateCreateTable(original));
      await db.query(
        "INSERT INTO attachments (id, slug, context, label) VALUES ('00000000-0000-4000-8000-000000000001', 'original', '', 'application data')",
      );
      register(MESSAGES);
      bind();
      const pending = await getPendingSchemaStatements(db, {
        engineHint: dialect,
      });
      expect(pending.statements.join('\n')).toContain('message_attachments');
      expect(pending.statements.join('\n')).not.toMatch(
        /DROP TABLE|RENAME TABLE/,
      );
      const migrated = await migrateSmrtSchemas({
        db,
        packageName: APP,
        engineHint: dialect,
      });
      expect(migrated.applied).toBe(true);
      const repeated = await getPendingSchemaStatements(db, {
        engineHint: dialect,
      });
      if (dialect === 'sqlite') expect(repeated.statements).toEqual([]);
      // DuckDB's existing index introspection may re-plan indexes; storage
      // bindings must never re-plan either table or alter its populated rows.
      expect(repeated.statements.join('\n')).not.toMatch(
        /CREATE TABLE|DROP TABLE|ALTER TABLE/,
      );
      const rows = await db.query('SELECT label FROM attachments');
      expect(rows.rows).toEqual([{ label: 'application data' }]);
      const count = (
        await db.query('SELECT COUNT(*) AS n FROM message_attachments')
      ).rows[0];
      expect(Number(count.n)).toBe(0);
      await db.close?.();
    });
  }
  for (const value of [
    null,
    [],
    { Attachment: 'messages' },
    { [`${MESSAGES}:Attachment`]: 'attachments; DROP TABLE attachments' },
    { [`${MESSAGES}:Attachment`]: '_smrt_changes' },
  ]) {
    it(`refuses malformed mapping ${JSON.stringify(value)}`, () => {
      register(MESSAGES);
      bind(value);
      expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
        /tableNames/,
      );
    });
  }
  it('keeps valid bindings dormant in a partial registry and applies them on later registration', async () => {
    register(APP);
    bind();
    const db = await getTestDatabase({ classes: [`${APP}:Attachment`] });
    expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual([
      'attachments',
    ]);
    register(MESSAGES);
    expect(ObjectRegistry.getSchema(`${MESSAGES}:Attachment`)?.tableName).toBe(
      'message_attachments',
    );
    expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual(
      expect.arrayContaining(['attachments', 'message_attachments']),
    );
    await db.close?.();
  });
  it('does not let an explicit mapping bypass the unrelated-table guard', () => {
    register(APP);
    register(MESSAGES);
    bind({ [`${MESSAGES}:Attachment`]: 'attachments' });
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      /claimed by unrelated classes/,
    );
  });
  it('binds an entire STI family through its root and refuses child-only bindings', () => {
    const root = register(MESSAGES, 'Attachment', undefined, {
      tableStrategy: 'sti',
    });
    ObjectRegistry.registerFromManifest(`${MESSAGES}:ImageAttachment`, {
      ...root,
      className: 'ImageAttachment',
      name: 'imageattachment',
      filePath: `${MESSAGES}/ImageAttachment.ts`,
      extends: 'Attachment',
      extendsQualified: `${MESSAGES}:Attachment`,
    });
    bind();
    expect(ObjectRegistry.getTableName(`${MESSAGES}:ImageAttachment`)).toBe(
      'message_attachments',
    );
    expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual([
      'message_attachments',
    ]);
    bind({ [`${MESSAGES}:ImageAttachment`]: 'image_attachments' });
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      /STI root/,
    );
  });
  it('preserves unrelated STI subtype metadata with a dormant binding', () => {
    const root = register(APP, 'Attachment', undefined, {
      tableStrategy: 'sti',
    });
    if (!root.schema) throw new Error('Expected root schema');
    ObjectRegistry.registerFromManifest(`${APP}:ImageAttachment`, {
      ...root,
      className: 'ImageAttachment',
      name: 'imageattachment',
      extends: 'Attachment',
      extendsQualified: `${APP}:Attachment`,
      schema: { ...root.schema, tableName: 'image_attachments' },
    });
    const before = ObjectRegistry.getSchema(`${APP}:ImageAttachment`);
    bind();
    expect(ObjectRegistry.getSchema(`${APP}:ImageAttachment`)).toEqual(before);
    expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual([
      'attachments',
    ]);
  });
  it('refuses bindings that would change a sensitive table identity', () => {
    register(MESSAGES, 'Attachment', undefined, { sensitive: true });
    bind();
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      /sensitive tables/,
    );
  });
  for (const trigger of [
    'configured-conflict',
    'late-registration',
    'changed-binding',
    'removed-binding-empty',
    'removed-binding-unrelated',
  ] as const) {
    it(`blocks a cached runtime collection read before SQL without schema planning (${trigger})`, async () => {
      register(MESSAGES, 'Attachment', undefined, {
        tableName: 'legacy_messages',
      });
      bind();
      const Attachment = class Attachment extends SmrtObject {
        label = '';
      };
      ObjectRegistry.register(Attachment, {
        packageName: MESSAGES,
        tableName: 'legacy_messages',
      });
      class Attachments extends SmrtCollection<SmrtObject> {
        static readonly _itemClass = Attachment;
      }
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      try {
        const schema = ObjectRegistry.getSchema(`${MESSAGES}:Attachment`);
        if (!schema) throw new Error('Expected message schema');
        await db.query(getDDLStrategy('sqlite').generateCreateTable(schema));
        const collection = await Attachments.create({ db });
        await collection.list({}); // Warm the cached table name and storage verification.
        const item = await collection.create({
          slug: 'before-conflict',
          label: 'message row',
        });
        expect(item.tableName).toBe('message_attachments');
        if (trigger === 'configured-conflict') {
          register(APP, 'Attachment', undefined, {
            tableName: 'existing_app_attachments',
          });
          bind({ [`${MESSAGES}:Attachment`]: 'existing_app_attachments' });
        } else if (trigger === 'late-registration') {
          register(APP, 'Attachment', undefined, {
            tableName: 'message_attachments',
          });
        } else if (trigger.startsWith('removed-binding')) {
          clearCache();
          if (trigger === 'removed-binding-unrelated') {
            bind({ '@fixture/absent:Other': 'other_storage' });
          }
        } else {
          bind({ [`${MESSAGES}:Attachment`]: 'moved_message_attachments' });
        }
        const query = vi.spyOn(db, 'query');
        const list = vi.spyOn(db, 'list');
        const upsert = vi.spyOn(db, 'upsert');
        const get = vi.spyOn(db, 'get');
        await expect(collection.list({})).rejects.toThrow(
          /claimed by unrelated classes|changed after runtime storage/,
        );
        if (
          trigger === 'configured-conflict' ||
          trigger === 'late-registration'
        ) {
          expect(() =>
            ObjectRegistry.getSchema(`${MESSAGES}:Attachment`),
          ).toThrow(/claimed by unrelated classes/);
        }
        await expect(item.save()).rejects.toThrow(
          /claimed by unrelated classes|changed after runtime storage/,
        );
        expect(() => item.tableName).toThrow(
          /claimed by unrelated classes|changed after runtime storage/,
        );
        expect(query).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
      } finally {
        await db.close?.();
      }
    });
  }
  it('preserves custom unbound cached table names when unrelated bindings disappear', () => {
    register(MESSAGES);
    const Attachment = class Attachment extends SmrtObject {};
    ObjectRegistry.register(Attachment, { packageName: MESSAGES });
    class Attachments extends SmrtCollection<SmrtObject> {
      static readonly _itemClass = Attachment;
    }
    const item = new Attachment();
    const collection = new Attachments();
    item._tableName = 'custom_storage';
    collection._tableName = 'custom_storage';
    bind({ '@fixture/absent:Other': 'other_storage' });
    expect(item.tableName).toBe('custom_storage');
    expect(collection.tableName).toBe('custom_storage');
    clearCache();
    expect(item.tableName).toBe('custom_storage');
    expect(collection.tableName).toBe('custom_storage');
  });
  it('refuses malformed dormant bindings even when their model is absent', () => {
    register(APP);
    bind({ '@fixture/absent:Attachment': 'bad;table' });
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      /tableNames/,
    );
  });
});
