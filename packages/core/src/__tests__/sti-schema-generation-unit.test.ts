/**
 * Unit tests for STI (Single Table Inheritance) schema generation
 *
 * Tests the SchemaGenerator.generateSTISchemaFromRegistry method directly
 * without relying on full class registration and manifest loading.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FieldDefinition } from '../scanner/types';
import { SchemaGenerator } from '../schema/generator';

// Helper to create field definitions for tests
function createField(
  type: FieldDefinition['type'],
  options: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    type,
    ...options,
  };
}

const registry = {
  getDescendants: vi.fn(),
  getAllFields: vi.fn(),
};

const registryConfig = { registry };

describe('STI Schema Generation (Unit)', () => {
  beforeEach(() => {
    registry.getDescendants.mockReset();
    registry.getAllFields.mockReset();
  });

  describe('generateSTISchemaFromRegistry', () => {
    it('should include type discriminator column', async () => {
      const generator = new SchemaGenerator();

      // Mock: Event base class with no descendants
      vi.mocked(registry.getDescendants).mockReturnValue([]);
      vi.mocked(registry.getAllFields).mockResolvedValue(
        new Map([
          ['title', createField('text', { description: 'Event title' })],
        ]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', createField('text')]]),
        registryConfig,
      );
      const sql = generator.generateSQL(schema);

      expect(sql).toContain('"_meta_type" TEXT NOT NULL');
      expect(schema.columns._meta_type).toEqual({
        type: 'TEXT',
        notNull: true,
        description: 'Class type discriminator for STI',
      });
    });

    it('should include meta JSON column', async () => {
      const generator = new SchemaGenerator();

      vi.mocked(registry.getDescendants).mockReturnValue([]);
      vi.mocked(registry.getAllFields).mockResolvedValue(
        new Map([['title', createField('text')]]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', createField('text')]]),
        registryConfig,
      );
      const sql = generator.generateSQL(schema);

      expect(sql).toContain('"_meta_data" JSON');
      expect(schema.columns._meta_data).toEqual({
        type: 'JSON',
        notNull: false,
        description: 'Flexible JSON storage for meta() fields',
      });
    });

    it('should include base class fields', async () => {
      const generator = new SchemaGenerator();

      vi.mocked(registry.getDescendants).mockReturnValue([]);
      vi.mocked(registry.getAllFields).mockResolvedValue(
        new Map([
          ['title', createField('text', { description: 'Event title' })],
          [
            'description',
            createField('text', { description: 'Event description' }),
          ],
        ]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([
          ['title', createField('text')],
          ['description', createField('text')],
        ]),
        registryConfig,
      );

      expect(schema.columns.title).toBeDefined();
      expect(schema.columns.description).toBeDefined();
    });

    it('should create unique index on slug, context, and type', async () => {
      const generator = new SchemaGenerator();

      vi.mocked(registry.getDescendants).mockReturnValue([]);
      vi.mocked(registry.getAllFields).mockResolvedValue(
        new Map([['title', createField('text')]]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', createField('text')]]),
        registryConfig,
      );

      const uniqueIndex = schema.indexes.find(
        (idx) => idx.name === 'events_slug_context_meta_type_idx',
      );

      expect(uniqueIndex).toBeDefined();
      expect(uniqueIndex?.columns).toEqual(['slug', 'context', '_meta_type']);
      expect(uniqueIndex?.unique).toBe(true);
    });

    it('should create index on type column for polymorphic queries', async () => {
      const generator = new SchemaGenerator();

      vi.mocked(registry.getDescendants).mockReturnValue([]);
      vi.mocked(registry.getAllFields).mockResolvedValue(
        new Map([['title', createField('text')]]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', createField('text')]]),
        registryConfig,
      );

      const typeIndex = schema.indexes.find(
        (idx) => idx.name === 'events_meta_type_idx',
      );

      expect(typeIndex).toBeDefined();
      expect(typeIndex?.columns).toEqual(['_meta_type']);
      expect(typeIndex?.description).toContain('type discriminator');
    });

    it('should aggregate fields from descendants', async () => {
      const generator = new SchemaGenerator();

      // Mock: Event has Meeting and HockeyGame descendants
      vi.mocked(registry.getDescendants).mockReturnValue([
        'Meeting',
        'HockeyGame',
      ]);

      // Mock field retrieval for each class
      vi.mocked(registry.getAllFields).mockImplementation(async (className) => {
        if (className === 'Event') {
          return new Map([['title', createField('text')]]);
        }
        if (className === 'Meeting') {
          return new Map([
            ['title', createField('text')], // Inherited
            ['roomNumber', createField('text')],
          ]);
        }
        if (className === 'HockeyGame') {
          return new Map([
            ['title', createField('text')], // Inherited
            ['homeTeam', createField('text')],
          ]);
        }
        return new Map();
      });

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', createField('text')]]),
        registryConfig,
      );

      // Should have base field
      expect(schema.columns.title).toBeDefined();

      // Should have Meeting field
      expect(schema.columns.room_number).toBeDefined();

      // Should have HockeyGame field
      expect(schema.columns.home_team).toBeDefined();
    });

    it('should make all non-base fields nullable', async () => {
      const generator = new SchemaGenerator();

      vi.mocked(registry.getDescendants).mockReturnValue(['Meeting']);
      vi.mocked(registry.getAllFields).mockImplementation(async (className) => {
        if (className === 'Event') {
          return new Map([['title', createField('text', { required: true })]]);
        }
        if (className === 'Meeting') {
          return new Map([
            ['title', createField('text', { required: true })],
            ['roomNumber', createField('text', { required: true })],
          ]);
        }
        return new Map();
      });

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', createField('text', { required: true })]]),
        registryConfig,
      );

      // All fields should be nullable in STI (even if required: true)
      // This is because not all types have all fields
      expect(schema.columns.room_number?.notNull).toBe(false);
    });

    it('should generate partial indexes for FK columns', async () => {
      const generator = new SchemaGenerator();

      vi.mocked(registry.getDescendants).mockReturnValue(['Meeting']);

      // Mock Meeting with FK
      vi.mocked(registry.getAllFields).mockImplementation(async (className) => {
        if (className === 'Event') {
          return new Map([['title', createField('text')]]);
        }
        if (className === 'Meeting') {
          return new Map([
            ['title', createField('text')],
            [
              'roomId',
              {
                type: 'foreignKey',
                related: 'Room',
                getSqlType: () => 'TEXT',
              } as any,
            ],
          ]);
        }
        return new Map();
      });

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', createField('text')]]),
        registryConfig,
      );

      // Should have partial index for room_id filtered by Meeting type
      const partialIndex = schema.indexes.find(
        (idx) => idx.name === 'idx_events_room_id_meeting',
      );

      expect(partialIndex).toBeDefined();
      expect(partialIndex?.where).toBe("_meta_type = 'Meeting'");
      expect(partialIndex?.columns).toEqual(['room_id']);
    });

    it('should handle class with no descendants', async () => {
      const generator = new SchemaGenerator();

      vi.mocked(registry.getDescendants).mockReturnValue([]);
      vi.mocked(registry.getAllFields).mockResolvedValue(
        new Map([['title', createField('text')]]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', createField('text')]]),
        registryConfig,
      );

      // Should still generate valid schema
      expect(schema.tableName).toBe('events');
      expect(schema.columns._meta_type).toBeDefined();
      expect(schema.columns._meta_data).toBeDefined();
      expect(schema.columns.title).toBeDefined();
    });
  });

  describe('generateSQL and indexes', () => {
    // NOTE: As of the SchemaManager refactor, generateSQL() returns only CREATE TABLE.
    // Indexes are stored separately in schema.indexes and handled by SchemaManager.
    // These tests verify the DDL contains only table creation, with indexes in a separate property.

    it('should not include indexes in DDL (indexes are stored separately)', () => {
      const generator = new SchemaGenerator();

      const schema = {
        tableName: 'events',
        columns: {
          id: { type: 'TEXT' as const, primaryKey: true, notNull: true },
          room_id: { type: 'TEXT' as const, notNull: false },
        },
        indexes: [
          {
            name: 'idx_events_room_id_meeting',
            columns: ['room_id'],
            where: "_meta_type = 'Meeting'",
            description: 'Partial index for Meeting rows',
          },
        ],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1',
      };

      const sql = generator.generateSQL(schema);

      // DDL should contain only CREATE TABLE, not indexes
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "events"');
      expect(sql).not.toContain('CREATE INDEX');

      // Indexes should be available in schema.indexes for separate handling
      expect(schema.indexes).toHaveLength(1);
      expect(schema.indexes[0].name).toBe('idx_events_room_id_meeting');
      expect(schema.indexes[0].where).toBe("_meta_type = 'Meeting'");
    });

    it('should generate DDL without index statements', () => {
      const generator = new SchemaGenerator();

      const schema = {
        tableName: 'events',
        columns: {
          id: { type: 'TEXT' as const, primaryKey: true, notNull: true },
          updated_at: { type: 'TIMESTAMP' as const, notNull: true },
        },
        indexes: [
          {
            name: 'idx_events_updated_at',
            columns: ['updated_at'],
            description: 'Regular index without WHERE',
          },
        ],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1',
      };

      const sql = generator.generateSQL(schema);

      // DDL should be CREATE TABLE only
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "events"');
      expect(sql).not.toContain('CREATE INDEX');
      expect(sql).not.toContain('WHERE');
    });
  });
});
