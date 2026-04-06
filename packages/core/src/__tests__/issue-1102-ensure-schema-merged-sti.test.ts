/**
 * Issue #1102: ensureSchema() created base-only STI tables from manifest stubs.
 *
 * Problem:
 * - db:migrate correctly computes merged table schemas via getAllSchemasAsDefinitions()
 * - but new-table creation delegates to ensureSchema(className)
 * - ensureSchema() used the per-class schema for the requested class
 * - for STI/shared tables, that schema can omit child columns, so the created
 *   table is missing fields that db:migrate already knows should exist
 *
 * This regression proves ensureSchema() uses the merged table definition when
 * creating a shared STI table from manifest-registered classes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { ensureSchema } from '../schema/utils.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

describe('Issue #1102: ensureSchema() uses merged STI table definition', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('creates a shared STI table with child columns when called on the base class', async () => {
    ObjectRegistry.registerFromManifest(
      'Issue1102Event',
      {
        className: 'Issue1102Event',
        fields: {
          tenantId: { type: 'text', _meta: { isTenantIdField: true } },
          name: { type: 'text', _meta: {} },
          startDate: { type: 'timestamp', _meta: {} },
        },
        methods: {},
        decoratorConfig: { tableStrategy: 'sti' },
        schema: {
          tableName: 'issue1102_events',
          ddl: `CREATE TABLE IF NOT EXISTS "issue1102_events" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "_meta_type" TEXT NOT NULL DEFAULT '',
  "_meta_data" JSON,
  "tenant_id" TEXT,
  "name" TEXT DEFAULT '',
  "start_date" TIMESTAMP
);`,
          columns: {
            tenant_id: { type: 'TEXT' },
            name: { type: 'TEXT', defaultValue: '' },
            start_date: { type: 'TIMESTAMP' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      '@test/events',
    );

    ObjectRegistry.registerFromManifest(
      'Issue1102Meeting',
      {
        className: 'Issue1102Meeting',
        extends: 'Issue1102Event',
        fields: {
          tenantId: { type: 'text', _meta: { isTenantIdField: true } },
          name: { type: 'text', _meta: {} },
          startDate: { type: 'timestamp', _meta: {} },
          councilId: { type: 'text', _meta: {} },
          agendaUrl: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: { tableStrategy: 'sti' },
        schema: {
          tableName: 'issue1102_events',
          ddl: `CREATE TABLE IF NOT EXISTS "issue1102_events" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "_meta_type" TEXT NOT NULL DEFAULT '',
  "_meta_data" JSON,
  "tenant_id" TEXT,
  "council_id" TEXT DEFAULT '',
  "agenda_url" TEXT DEFAULT ''
);`,
          columns: {
            tenant_id: { type: 'TEXT' },
            council_id: { type: 'TEXT', defaultValue: '' },
            agenda_url: { type: 'TEXT', defaultValue: '' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      '@test/praeco',
    );

    const merged = ObjectRegistry.getAllSchemasAsDefinitions().issue1102_events;
    expect(merged).toBeDefined();
    expect(merged?.columns.name).toBeDefined();
    expect(merged?.columns.council_id).toBeDefined();
    expect(merged?.columns.agenda_url).toBeDefined();

    const query = vi.fn(async () => ({ rows: [] }));
    const db = {
      url: 'postgresql://test:test@127.0.0.1:5432/test',
      query,
      tableExists: vi.fn(async () => false),
    } as any;

    await ensureSchema(db, 'Issue1102Event');

    expect(query).toHaveBeenCalled();
    const createTableSQL = query.mock.calls[0]?.[0];
    expect(createTableSQL).toContain('"name"');
    expect(createTableSQL).toContain('"council_id"');
    expect(createTableSQL).toContain('"agenda_url"');
    expect(createTableSQL).toContain('"_meta_type"');
    expect(createTableSQL).toContain('"_meta_data"');
  });
});
