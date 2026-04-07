import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { ensureSchema } from '../schema/utils.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

describe('Issue #1070: ensureSchema uses merged STI table schema', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();

    ObjectRegistry.registerFromManifest(
      '@test/events:Event',
      {
        className: 'Event',
        extends: 'SmrtObject',
        decoratorConfig: {
          tableStrategy: 'sti',
          tableName: 'events',
        },
        fields: {
          tenantId: { type: 'text' },
          name: { type: 'text', default: '' },
          description: { type: 'text' },
          startDate: { type: 'datetime' },
          endDate: { type: 'datetime' },
          status: { type: 'text', default: 'scheduled' },
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
  "tenant_id" TEXT,
  "name" TEXT DEFAULT '',
  "description" TEXT,
  "start_date" TIMESTAMP,
  "end_date" TIMESTAMP,
  "status" TEXT DEFAULT 'scheduled'
)`,
          columns: {
            id: { type: 'TEXT', primaryKey: true, notNull: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, defaultValue: '' },
            _meta_type: { type: 'TEXT', notNull: true },
            _meta_data: { type: 'JSON' },
            created_at: {
              type: 'TIMESTAMP',
              notNull: true,
              defaultValue: 'current_timestamp',
            },
            updated_at: {
              type: 'TIMESTAMP',
              notNull: true,
              defaultValue: 'current_timestamp',
            },
            tenant_id: { type: 'TEXT' },
            name: { type: 'TEXT', defaultValue: '' },
            description: { type: 'TEXT' },
            start_date: { type: 'TIMESTAMP' },
            end_date: { type: 'TIMESTAMP' },
            status: { type: 'TEXT', defaultValue: 'scheduled' },
          },
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/events',
    );

    ObjectRegistry.registerFromManifest(
      '@test/praeco:Meeting',
      {
        className: 'Meeting',
        extends: 'Event',
        decoratorConfig: {
          tableStrategy: 'sti',
          tableName: 'events',
        },
        fields: {
          councilId: { type: 'text', default: '' },
          agendaUrl: { type: 'text', default: '' },
          minutesUrl: { type: 'text', default: '' },
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
  "tenant_id" TEXT,
  "name" TEXT DEFAULT '',
  "description" TEXT,
  "start_date" TIMESTAMP,
  "end_date" TIMESTAMP,
  "status" TEXT DEFAULT 'scheduled',
  "council_id" TEXT,
  "agenda_url" TEXT,
  "minutes_url" TEXT
)`,
          columns: {
            id: { type: 'TEXT', primaryKey: true, notNull: true },
            slug: { type: 'TEXT', notNull: true },
            context: { type: 'TEXT', notNull: true, defaultValue: '' },
            _meta_type: { type: 'TEXT', notNull: true },
            _meta_data: { type: 'JSON' },
            created_at: {
              type: 'TIMESTAMP',
              notNull: true,
              defaultValue: 'current_timestamp',
            },
            updated_at: {
              type: 'TIMESTAMP',
              notNull: true,
              defaultValue: 'current_timestamp',
            },
            tenant_id: { type: 'TEXT' },
            name: { type: 'TEXT', defaultValue: '' },
            description: { type: 'TEXT' },
            start_date: { type: 'TIMESTAMP' },
            end_date: { type: 'TIMESTAMP' },
            status: { type: 'TEXT', defaultValue: 'scheduled' },
            council_id: { type: 'TEXT' },
            agenda_url: { type: 'TEXT' },
            minutes_url: { type: 'TEXT' },
          },
          indexes: [],
          version: 'test-version',
        },
      },
      '@test/praeco',
    );
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('creates STI base tables with child columns in manifest-only mode', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    try {
      await ensureSchema(db, 'Event');

      const pragmaResult = await db.query(`PRAGMA table_info('events')`);
      const rows = Array.isArray(pragmaResult)
        ? pragmaResult
        : pragmaResult.rows;
      const columnNames = rows.map((row: { name: string }) => row.name);

      expect(columnNames).toContain('_meta_type');
      expect(columnNames).toContain('council_id');
      expect(columnNames).toContain('agenda_url');
      expect(columnNames).toContain('minutes_url');
    } finally {
      const closable = db as { close?: () => Promise<void> | void };
      await closable.close?.();
    }
  });
});
