/**
 * Unit tests for STI (Single Table Inheritance) schema generation
 *
 * Tests the SchemaGenerator.generateSTISchemaFromRegistry method directly
 * without relying on full class registration and manifest loading.
 */

import { describe, expect, it, vi } from 'vitest';

import { ObjectRegistry } from '../registry';
import { SchemaGenerator } from '../schema/generator';

// Mock ObjectRegistry methods for unit tests
vi.mock('../registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry')>();
  return {
    ...actual,
    ObjectRegistry: {
      ...actual.ObjectRegistry,
      getDescendants: vi.fn(),
      getAllFields: vi.fn(),
    },
  };
});

describe('STI Schema Generation (Unit)', () => {
  describe('generateSTISchemaFromRegistry', () => {
    it('should include type discriminator column', async () => {
      const generator = new SchemaGenerator();

      // Mock: Event base class with no descendants
      vi.mocked(ObjectRegistry.getDescendants).mockReturnValue([]);
      vi.mocked(ObjectRegistry.getAllFields).mockResolvedValue(
        new Map([['title', text({ description: 'Event title' })]]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', text()]]),
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

      vi.mocked(ObjectRegistry.getDescendants).mockReturnValue([]);
      vi.mocked(ObjectRegistry.getAllFields).mockResolvedValue(
        new Map([['title', text()]]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', text()]]),
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

      vi.mocked(ObjectRegistry.getDescendants).mockReturnValue([]);
      vi.mocked(ObjectRegistry.getAllFields).mockResolvedValue(
        new Map([
          ['title', text({ description: 'Event title' })],
          ['description', text({ description: 'Event description' })],
        ]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([
          ['title', text()],
          ['description', text()],
        ]),
      );

      expect(schema.columns.title).toBeDefined();
      expect(schema.columns.description).toBeDefined();
    });

    it('should create unique index on slug, context, and type', async () => {
      const generator = new SchemaGenerator();

      vi.mocked(ObjectRegistry.getDescendants).mockReturnValue([]);
      vi.mocked(ObjectRegistry.getAllFields).mockResolvedValue(
        new Map([['title', text()]]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', text()]]),
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

      vi.mocked(ObjectRegistry.getDescendants).mockReturnValue([]);
      vi.mocked(ObjectRegistry.getAllFields).mockResolvedValue(
        new Map([['title', text()]]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', text()]]),
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
      vi.mocked(ObjectRegistry.getDescendants).mockReturnValue([
        'Meeting',
        'HockeyGame',
      ]);

      // Mock field retrieval for each class
      vi.mocked(ObjectRegistry.getAllFields).mockImplementation(
        async (className) => {
          if (className === 'Event') {
            return new Map([['title', text()]]);
          }
          if (className === 'Meeting') {
            return new Map([
              ['title', text()], // Inherited
              ['roomNumber', text()],
            ]);
          }
          if (className === 'HockeyGame') {
            return new Map([
              ['title', text()], // Inherited
              ['homeTeam', text()],
            ]);
          }
          return new Map();
        },
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', text()]]),
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

      vi.mocked(ObjectRegistry.getDescendants).mockReturnValue(['Meeting']);
      vi.mocked(ObjectRegistry.getAllFields).mockImplementation(
        async (className) => {
          if (className === 'Event') {
            return new Map([['title', text({ required: true })]]);
          }
          if (className === 'Meeting') {
            return new Map([
              ['title', text({ required: true })],
              ['roomNumber', text({ required: true })],
            ]);
          }
          return new Map();
        },
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', text({ required: true })]]),
      );

      // All fields should be nullable in STI (even if required: true)
      // This is because not all types have all fields
      expect(schema.columns.room_number?.notNull).toBe(false);
    });

    it('should generate partial indexes for FK columns', async () => {
      const generator = new SchemaGenerator();

      vi.mocked(ObjectRegistry.getDescendants).mockReturnValue(['Meeting']);

      // Mock Meeting with FK
      vi.mocked(ObjectRegistry.getAllFields).mockImplementation(
        async (className) => {
          if (className === 'Event') {
            return new Map([['title', text()]]);
          }
          if (className === 'Meeting') {
            return new Map([
              ['title', text()],
              [
                'roomId',
                {
                  type: 'foreignKey',
                  options: { related: 'Room' },
                  getSqlType: () => 'TEXT',
                } as any,
              ],
            ]);
          }
          return new Map();
        },
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', text()]]),
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

      vi.mocked(ObjectRegistry.getDescendants).mockReturnValue([]);
      vi.mocked(ObjectRegistry.getAllFields).mockResolvedValue(
        new Map([['title', text()]]),
      );

      const schema = await generator.generateSTISchemaFromRegistry(
        'Event',
        'events',
        new Map([['title', text()]]),
      );

      // Should still generate valid schema
      expect(schema.tableName).toBe('events');
      expect(schema.columns._meta_type).toBeDefined();
      expect(schema.columns._meta_data).toBeDefined();
      expect(schema.columns.title).toBeDefined();
    });
  });

  describe('generateSQL with WHERE clauses', () => {
    it('should include WHERE clause in partial index SQL', () => {
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

      expect(sql).toContain(
        'CREATE INDEX IF NOT EXISTS idx_events_room_id_meeting',
      );
      expect(sql).toContain("WHERE _meta_type = 'Meeting'");
    });

    it('should not add WHERE clause when not specified', () => {
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

      expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_events_updated_at');
      expect(sql).not.toContain('WHERE');
    });
  });
});
