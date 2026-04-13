import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

describe('Issue #1120 - runtime schema rebuild preserves manifest FK actions', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('does not overwrite manifest foreign key actions when runtime fields are merged', () => {
    ObjectRegistry.registerFromManifest(
      '@test/pkg:RestrictiveChild',
      {
        className: 'RestrictiveChild',
        fields: {
          parentId: {
            type: 'foreignKey',
            related: 'Parent.id',
            nullable: false,
          },
        },
        methods: {},
        decoratorConfig: {
          tableName: 'restrictive_children',
        },
        schema: {
          tableName: 'restrictive_children',
          ddl: '',
          columns: {
            parent_id: {
              type: 'TEXT',
              notNull: true,
              foreignKey: {
                table: 'parents',
                column: 'id',
                onDelete: 'RESTRICT',
                onUpdate: 'CASCADE',
              },
            },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: 'test-version',
        },
      },
      '@test/pkg',
    );

    ObjectRegistry.registerFieldDecorator('RestrictiveChild', 'parentId', {
      type: 'foreignKey',
      related: 'Parent.id',
      required: true,
    });

    const definitions = ObjectRegistry.getAllSchemasAsDefinitions();

    expect(
      definitions.restrictive_children?.columns.parent_id?.foreignKey,
    ).toEqual({
      table: 'parents',
      column: 'id',
      onDelete: 'RESTRICT',
      onUpdate: 'CASCADE',
    });
  });
});
