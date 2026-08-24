import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { ensureSchema } from '../schema/utils.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

describe('getTestDatabase manifest schemas', () => {
  let restoreRegistry: () => void;

  function registerCollectionStubWithSTIItem(): void {
    ObjectRegistry.registerFromManifest(
      '@test/pkg:Meetings',
      {
        className: 'Meetings',
        extends: 'SmrtCollection',
        extendsTypeArg: 'Event',
        fields: {},
        methods: {},
        decoratorConfig: {
          tableName: 'events',
        },
        schema: {
          tableName: 'events',
          ddl: `CREATE TABLE IF NOT EXISTS "events" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp
)`,
          columns: {
            id: { type: 'TEXT', notNull: true, primaryKey: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, default: '' },
            created_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            updated_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
          },
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/pkg',
    );

    ObjectRegistry.registerFromManifest(
      '@test/pkg:Event',
      {
        className: 'Event',
        fields: {
          name: { type: 'text', required: false, default: '' },
        },
        methods: {},
        decoratorConfig: {
          tableName: 'events',
          tableStrategy: 'sti',
        },
        schema: {
          tableName: 'events',
          ddl: `CREATE TABLE IF NOT EXISTS "events" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "_meta_type" TEXT NOT NULL,
  "_meta_data" JSON,
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "name" TEXT DEFAULT ''
)`,
          columns: {
            id: { type: 'TEXT', notNull: true, primaryKey: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, default: '' },
            _meta_type: { type: 'TEXT', notNull: true },
            _meta_data: { type: 'JSON', notNull: false },
            created_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            updated_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            name: { type: 'TEXT', notNull: false, default: '' },
          },
          indexes: [
            {
              name: 'events_meta_type_idx',
              columns: ['_meta_type'],
              unique: false,
            },
          ],
          version: 'test-version',
        },
      },
      '@test/pkg',
    );
  }

  function registerNativeUuidThing(): void {
    ObjectRegistry.registerFromManifest(
      '@test/pkg:NativeUuidThing',
      {
        className: 'NativeUuidThing',
        fields: {},
        methods: {},
        decoratorConfig: {
          tableName: 'native_uuid_things',
          idType: 'uuid',
        },
      },
      '@test/pkg',
    );
  }

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('normalizes manifest column defaults into runtime schema definitions', () => {
    ObjectRegistry.registerFromManifest(
      '@test/pkg:ManifestDefaultedFeedSource',
      {
        className: 'ManifestDefaultedFeedSource',
        fields: {},
        methods: {},
        decoratorConfig: {
          tableName: 'manifest_defaulted_feed_sources',
        },
        schema: {
          tableName: 'manifest_defaulted_feed_sources',
          ddl: `CREATE TABLE IF NOT EXISTS "manifest_defaulted_feed_sources" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "poll_interval_minutes" INTEGER NOT NULL DEFAULT 15
)`,
          columns: {
            id: { type: 'TEXT', notNull: true, primaryKey: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, default: '' },
            created_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            updated_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            poll_interval_minutes: {
              type: 'INTEGER',
              notNull: true,
              default: 15,
            },
          },
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/pkg',
    );

    const schema =
      ObjectRegistry.getAllSchemasAsDefinitions()
        .manifest_defaulted_feed_sources;

    expect(schema.columns.context.defaultValue).toBe('');
    expect(schema.columns.created_at.defaultValue).toBe('current_timestamp');
    expect(schema.columns.updated_at.defaultValue).toBe('current_timestamp');
    expect(schema.columns.poll_interval_minutes.defaultValue).toBe(15);
  });

  it('preserves manifest-defined unique conflict indexes for test databases', async () => {
    ObjectRegistry.registerFromManifest(
      '@test/pkg:ManifestIndexedJoin',
      {
        className: 'ManifestIndexedJoin',
        fields: {
          factId: { type: 'text', required: true },
          contentId: { type: 'text', required: true },
          relationship: { type: 'text', required: true },
        },
        methods: {},
        decoratorConfig: {
          tableName: 'manifest_indexed_joins',
          conflictColumns: ['fact_id', 'content_id', 'relationship'],
        },
        schema: {
          tableName: 'manifest_indexed_joins',
          ddl: `CREATE TABLE IF NOT EXISTS "manifest_indexed_joins" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "fact_id" TEXT NOT NULL DEFAULT '',
  "content_id" TEXT NOT NULL DEFAULT '',
  "relationship" TEXT NOT NULL DEFAULT 'extracted_from'
)`,
          columns: {
            id: { type: 'TEXT', notNull: true, primaryKey: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, default: '' },
            created_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            updated_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            fact_id: { type: 'TEXT', notNull: true, default: '' },
            content_id: { type: 'TEXT', notNull: true, default: '' },
            relationship: {
              type: 'TEXT',
              notNull: true,
              default: 'extracted_from',
            },
          },
          indexes: [
            {
              name: 'manifest_indexed_joins_fact_id_content_id_idx',
              columns: ['fact_id', 'content_id', 'relationship'],
              unique: true,
            },
          ],
          version: 'test-version',
        },
      },
      '@test/pkg',
    );

    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ManifestIndexedJoin'],
    });

    const indexListResult = await db.query(
      `PRAGMA index_list('manifest_indexed_joins')`,
    );
    const indexList = Array.isArray(indexListResult)
      ? indexListResult
      : indexListResult.rows;
    const conflictIndex = indexList.find(
      (row: { name: string }) =>
        row.name === 'manifest_indexed_joins_fact_id_content_id_idx',
    );

    expect(conflictIndex).toBeDefined();
    expect(Boolean(conflictIndex?.unique)).toBe(true);
    // Custom conflict columns replace the default UNIQUE (slug, context)
    // conflict index. Slug loading still filters on slug/context, so a plain
    // lookup index under that name is kept — but it must not be unique
    // (#2359, A7).
    const slugLookup = indexList.find(
      (row: { name: string }) =>
        row.name === 'manifest_indexed_joins_slug_context_idx',
    );
    expect(slugLookup).toBeDefined();
    expect(Boolean(slugLookup?.unique)).toBe(false);

    const indexInfoResult = await db.query(
      `PRAGMA index_info('manifest_indexed_joins_fact_id_content_id_idx')`,
    );
    const indexInfo = Array.isArray(indexInfoResult)
      ? indexInfoResult
      : indexInfoResult.rows;

    expect(indexInfo.map((row: { name: string }) => row.name)).toEqual([
      'fact_id',
      'content_id',
      'relationship',
    ]);
  });

  it('prefers the STI item schema over collection manifest stubs that share the same table', async () => {
    registerCollectionStubWithSTIItem();

    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Meetings', 'Event'],
    });

    const columnsResult = await db.query(`PRAGMA table_info('events')`);
    const columns = Array.isArray(columnsResult)
      ? columnsResult
      : columnsResult.rows;
    const columnNames = columns.map((row: { name: string }) => row.name);

    expect(columnNames).toContain('_meta_type');
    expect(columnNames).toContain('_meta_data');
    expect(columnNames).toContain('name');
  });

  it('maps requested collection classes to their STI item schema', async () => {
    registerCollectionStubWithSTIItem();

    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Meetings'],
    });

    const columnsResult = await db.query(`PRAGMA table_info('events')`);
    const columns = Array.isArray(columnsResult)
      ? columnsResult
      : columnsResult.rows;
    const columnNames = columns.map((row: { name: string }) => row.name);

    expect(columnNames).toContain('_meta_type');
    expect(columnNames).toContain('_meta_data');
    expect(columnNames).toContain('name');
  });

  it('uses JSON adapter DDL for JSON-like test databases', async () => {
    const statements: string[] = [];
    const db = {
      exportTable: () => undefined,
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      },
    };

    ObjectRegistry.registerFromManifest(
      '@test/pkg:JsonIndexedThing',
      {
        className: 'JsonIndexedThing',
        fields: {
          label: { type: 'text', required: true },
        },
        methods: {},
        decoratorConfig: {
          tableName: 'json_indexed_things',
        },
      },
      '@test/pkg',
    );

    await getTestDatabase({
      db: db as any,
      classes: ['JsonIndexedThing'],
      includeSystemTables: false,
    });

    const createTable = statements.find((sql) =>
      sql.startsWith('CREATE TABLE IF NOT EXISTS "json_indexed_things"'),
    );

    expect(createTable).toContain('"id" TEXT PRIMARY KEY');
    expect(createTable).toContain('UNIQUE("slug", "context")');
    expect(
      statements.some(
        (sql) =>
          sql.includes('CREATE UNIQUE INDEX') &&
          sql.includes('json_indexed_things_slug_context_idx'),
      ),
    ).toBe(false);
  });

  it('uses native UUID DDL for an explicitly requested DuckDB database', async () => {
    registerNativeUuidThing();
    const db = await getTestDatabase({
      type: 'duckdb',
      classes: ['NativeUuidThing'],
      includeSystemTables: false,
    });

    try {
      const result = await db.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'native_uuid_things' AND column_name = 'id'`,
      );
      expect(result.rows[0]?.data_type).toBe('UUID');
    } finally {
      await db.close?.();
    }
  });

  it('infers native UUID DDL from an existing DuckDB database', async () => {
    registerNativeUuidThing();
    const db = await getDatabase({
      type: 'duckdb',
      url: ':memory:',
      // This test exercises getTestDatabase's existing-adapter inference, so
      // the Vitest wrapper must not prepare the table before that call.
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);

    try {
      await getTestDatabase({
        db,
        classes: ['NativeUuidThing'],
        includeSystemTables: false,
      });
      const result = await db.query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = 'native_uuid_things' AND column_name = 'id'`,
      );
      expect(result.rows[0]?.data_type).toBe('UUID');
    } finally {
      await db.close?.();
    }
  });

  it('creates registry schemas in foreign-key dependency order (#2413)', async () => {
    const statements: string[] = [];
    const db = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      },
    };

    ObjectRegistry.registerFromManifest(
      '@test/fk:RegistryParent',
      {
        className: 'RegistryParent',
        fields: {},
        methods: {},
        decoratorConfig: { tableName: 'z_registry_parents' },
      },
      '@test/fk',
    );
    ObjectRegistry.registerFromManifest(
      '@test/fk:RegistryChild',
      {
        className: 'RegistryChild',
        fields: {
          parentId: {
            type: 'foreignKey',
            related: 'RegistryParent',
          },
        },
        methods: {},
        decoratorConfig: { tableName: 'a_registry_children' },
      },
      '@test/fk',
    );

    await getTestDatabase({
      db: db as any,
      classes: ['RegistryChild'],
      includeSystemTables: false,
    });

    const parentCreate = statements.findIndex((sql) =>
      sql.startsWith('CREATE TABLE IF NOT EXISTS "z_registry_parents"'),
    );
    const childCreate = statements.findIndex((sql) =>
      sql.startsWith('CREATE TABLE IF NOT EXISTS "a_registry_children"'),
    );
    expect(parentCreate).toBeGreaterThanOrEqual(0);
    expect(childCreate).toBeGreaterThan(parentCreate);
    expect(statements[childCreate]).toContain(
      'REFERENCES "z_registry_parents" ("id")',
    );
  });

  it('fails closed when JSON-on-DuckDB cannot enforce a registry FK action (#2413)', async () => {
    ObjectRegistry.registerFromManifest(
      '@test/fk:DuckRegistryParent',
      {
        className: 'DuckRegistryParent',
        fields: {},
        methods: {},
        decoratorConfig: { tableName: 'duck_registry_parents' },
      },
      '@test/fk',
    );
    ObjectRegistry.registerFromManifest(
      '@test/fk:DuckRegistryChild',
      {
        className: 'DuckRegistryChild',
        fields: {
          parentId: {
            type: 'foreignKey',
            related: 'DuckRegistryParent',
          },
        },
        methods: {},
        decoratorConfig: { tableName: 'duck_registry_children' },
      },
      '@test/fk',
    );

    await expect(
      getTestDatabase({
        db: {
          exportTable: () => undefined,
          query: async () => ({ rows: [] }),
        } as any,
        classes: ['DuckRegistryChild', 'DuckRegistryParent'],
        includeSystemTables: false,
      }),
    ).rejects.toThrow(/ON UPDATE CASCADE.*does not support/);
  });

  it('preserves explicit manifest FK actions in test-database DDL (#2413)', async () => {
    ObjectRegistry.registerFromManifest(
      '@test/fk:ActionParent',
      {
        className: 'ActionParent',
        fields: {},
        methods: {},
        decoratorConfig: { tableName: 'action_parents' },
        schema: {
          tableName: 'action_parents',
          ddl: '',
          columns: { id: { type: 'TEXT', primaryKey: true } },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '2413',
        },
      },
      '@test/fk',
    );
    ObjectRegistry.registerFromManifest(
      '@test/fk:ActionChild',
      {
        className: 'ActionChild',
        fields: {
          parentId: { type: 'foreignKey', related: 'ActionParent.id' },
        },
        methods: {},
        decoratorConfig: { tableName: 'action_children' },
        schema: {
          tableName: 'action_children',
          ddl: '',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            parent_id: {
              type: 'TEXT',
              foreignKey: {
                table: 'action_parents',
                column: 'id',
                onDelete: 'RESTRICT',
                onUpdate: 'NO ACTION',
              },
            },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: ['action_parents'],
          version: '2413',
        },
      },
      '@test/fk',
    );
    ObjectRegistry.registerFieldDecorator('ActionChild', 'parentId', {
      type: 'foreignKey',
      related: 'ActionParent.id',
      onDelete: 'CASCADE',
    });
    const statements: string[] = [];
    await getTestDatabase({
      db: {
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: [] };
        },
      } as any,
      classes: ['ActionChild', 'ActionParent'],
      includeSystemTables: false,
    });

    const childDDL = statements.find((sql) =>
      sql.startsWith('CREATE TABLE IF NOT EXISTS "action_children"'),
    );
    expect(childDDL).toContain('ON DELETE RESTRICT ON UPDATE NO ACTION');
    expect(childDDL).not.toContain('ON DELETE CASCADE');
  });

  it('does not restore a physical FK excluded by the authoritative manifest (#2413)', async () => {
    ObjectRegistry.registerFromManifest(
      '@test/fk:RuntimeOnlyParent',
      {
        className: 'RuntimeOnlyParent',
        fields: {},
        methods: {},
        decoratorConfig: { tableName: 'runtime_only_parents' },
      },
      '@test/fk',
    );
    ObjectRegistry.registerFromManifest(
      '@test/fk:RuntimeOnlyChild',
      {
        className: 'RuntimeOnlyChild',
        fields: {
          parentId: {
            type: 'foreignKey',
            related: 'RuntimeOnlyParent.id',
            __tenancy: { isTenantIdField: true },
            _meta: { __tenancy: { isTenantIdField: true } },
          },
        },
        methods: {},
        decoratorConfig: { tableName: 'runtime_only_children' },
        schema: {
          tableName: 'runtime_only_children',
          ddl: '',
          columns: {
            id: { type: 'TEXT', primaryKey: true },
            parent_id: { type: 'TEXT' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '2413',
        },
      },
      '@test/fk',
    );
    const statements: string[] = [];
    await getTestDatabase({
      db: {
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: [] };
        },
      } as any,
      classes: ['RuntimeOnlyChild'],
      includeSystemTables: false,
    });

    expect(statements.join('\n')).not.toContain('FOREIGN KEY');
    expect(statements.join('\n')).not.toContain('runtime_only_parents');
  });

  it('plans the registered dependency closure when ensureSchema starts inside a PG cycle (#2413)', async () => {
    const registerCycle = (
      className: string,
      tableName: string,
      fieldName: string,
      targetClass: string,
      targetTable: string,
    ) =>
      ObjectRegistry.registerFromManifest(
        `@test/cycle:${className}`,
        {
          className,
          fields: {
            [fieldName]: { type: 'foreignKey', related: `${targetClass}.id` },
          },
          methods: {},
          decoratorConfig: { tableName },
          schema: {
            tableName,
            ddl: '',
            columns: {
              id: { type: 'TEXT', primaryKey: true },
              [fieldName === 'rightId' ? 'right_id' : 'left_id']: {
                type: 'TEXT',
                foreignKey: {
                  table: targetTable,
                  column: 'id',
                  onDelete: 'NO ACTION',
                  onUpdate: 'CASCADE',
                },
              },
            },
            indexes: [],
            triggers: [],
            foreignKeys: [],
            dependencies: [targetTable],
            version: '2413',
          },
        },
        '@test/cycle',
      );
    registerCycle(
      'SetupLeft',
      'setup_left',
      'rightId',
      'SetupRight',
      'setup_right',
    );
    registerCycle(
      'SetupRight',
      'setup_right',
      'leftId',
      'SetupLeft',
      'setup_left',
    );

    const tables = new Set<string>();
    const constraints = new Set<string>();
    const statements: string[] = [];
    const db = {
      url: 'postgres://localhost/test',
      tableExists: async (name: string) => tables.has(name),
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        const create = sql.match(/^CREATE TABLE IF NOT EXISTS "([^"]+)"/);
        if (create) tables.add(create[1]);
        if (sql.includes('FROM pg_constraint')) {
          return {
            rows: constraints.has(String(params?.[1]))
              ? [{ convalidated: true }]
              : [],
          };
        }
        if (sql.includes(' AS orphan_key ')) return { rows: [] };
        const add = sql.match(/ADD CONSTRAINT "([^"]+)"/);
        if (add) constraints.add(add[1]);
        return { rows: [] };
      },
    };

    await ensureSchema(db as any, 'SetupLeft');
    expect(tables).toEqual(new Set(['setup_left', 'setup_right']));
    expect(constraints.size).toBe(2);
    expect(
      statements
        .filter((sql) => sql.startsWith('CREATE TABLE'))
        .every((sql) => !sql.includes('FOREIGN KEY')),
    ).toBe(true);
  });

  it('maps collection subclasses to their inherited STI item schema before table creation', async () => {
    ObjectRegistry.registerFromManifest(
      '@test/messages:MessageCollection',
      {
        className: 'MessageCollection',
        extends: 'SmrtCollection',
        extendsTypeArg: 'Message',
        fields: {},
        methods: {},
        decoratorConfig: {},
        schema: {
          tableName: 'message_collections',
          ddl: '',
          columns: {},
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/messages',
    );

    ObjectRegistry.registerFromManifest(
      '@test/messages:EmailCollection',
      {
        className: 'EmailCollection',
        extends: 'MessageCollection',
        extendsTypeArg: null,
        fields: {},
        methods: {},
        decoratorConfig: {
          tableName: 'messages',
        },
        schema: {
          tableName: 'messages',
          ddl: `CREATE TABLE IF NOT EXISTS "messages" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp
)`,
          columns: {
            id: { type: 'TEXT', notNull: true, primaryKey: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, default: '' },
            created_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
            updated_at: {
              type: 'TIMESTAMP',
              notNull: true,
              default: 'current_timestamp',
            },
          },
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/messages',
    );

    ObjectRegistry.registerFromManifest(
      '@test/messages:Message',
      {
        className: 'Message',
        fields: {
          subject: { type: 'text', required: false, default: '' },
          messageId: { type: 'text', required: false, default: '' },
        },
        methods: {},
        decoratorConfig: {
          tableName: 'messages',
          tableStrategy: 'sti',
        },
        schema: {
          tableName: 'messages',
          ddl: '',
          columns: {},
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/messages',
    );

    const definitions = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(definitions.message_collections).toBeUndefined();
    expect(definitions.messages.columns._meta_type).toBeDefined();
    expect(definitions.messages.columns._meta_data).toBeDefined();
    expect(definitions.messages.columns.subject).toBeDefined();
    expect(definitions.messages.columns.message_id).toBeDefined();

    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
    });

    const columnsResult = await db.query(`PRAGMA table_info('messages')`);
    const columns = Array.isArray(columnsResult)
      ? columnsResult
      : columnsResult.rows;
    const columnNames = columns.map((row: { name: string }) => row.name);

    expect(columnNames).toContain('_meta_type');
    expect(columnNames).toContain('_meta_data');
    expect(columnNames).toContain('subject');
    expect(columnNames).toContain('message_id');
  });

  it('prefers collection subclass item inference over inherited type args', async () => {
    ObjectRegistry.registerFromManifest(
      '@test/messages:AttachmentCollection',
      {
        className: 'AttachmentCollection',
        extends: 'SmrtCollection',
        extendsTypeArg: 'Attachment',
        fields: {},
        methods: {},
        decoratorConfig: {},
        schema: {
          tableName: 'attachment_collections',
          ddl: '',
          columns: {},
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/messages',
    );

    ObjectRegistry.registerFromManifest(
      '@test/messages:EmailAttachmentCollection',
      {
        className: 'EmailAttachmentCollection',
        extends: 'AttachmentCollection',
        fields: {},
        methods: {},
        decoratorConfig: {},
        schema: {
          tableName: 'email_attachment_collections',
          ddl: '',
          columns: {},
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/messages',
    );

    ObjectRegistry.registerFromManifest(
      '@test/messages:Attachment',
      {
        className: 'Attachment',
        fields: {
          messageId: { type: 'text', required: false, default: '' },
        },
        methods: {},
        decoratorConfig: {
          tableName: 'attachments',
        },
        schema: {
          tableName: 'attachments',
          ddl: '',
          columns: {},
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/messages',
    );

    ObjectRegistry.registerFromManifest(
      '@test/messages:EmailAttachment',
      {
        className: 'EmailAttachment',
        extends: 'Attachment',
        fields: {},
        methods: {},
        decoratorConfig: {
          tableName: 'email_attachments',
        },
        schema: {
          tableName: 'email_attachments',
          ddl: '',
          columns: {},
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/messages',
    );

    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['EmailAttachmentCollection'],
    });

    const emailAttachmentColumnsResult = await db.query(
      `PRAGMA table_info('email_attachments')`,
    );
    const emailAttachmentColumns = Array.isArray(emailAttachmentColumnsResult)
      ? emailAttachmentColumnsResult
      : emailAttachmentColumnsResult.rows;
    const attachmentColumnsResult = await db.query(
      `PRAGMA table_info('attachments')`,
    );
    const attachmentColumns = Array.isArray(attachmentColumnsResult)
      ? attachmentColumnsResult
      : attachmentColumnsResult.rows;

    expect(
      emailAttachmentColumns.map((row: { name: string }) => row.name),
    ).toContain('id');
    expect(attachmentColumns).toHaveLength(0);
  });
});
