import { describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../scanner/manifest-generator';
import type {
  FieldDefinition,
  ManifestSchema,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import { SchemaGenerator } from '../schema/generator';
import type { SchemaDefinition } from '../schema/types';

function objectDef(
  className: string,
  fields: Record<string, FieldDefinition> = {},
  decoratorConfig: Record<string, unknown> = {},
  extendsName?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `packages/test/src/${className}.ts`,
    packageName: '@happyvertical/smrt-test',
    packageVersion: '0.0.0',
    fields,
    methods: {},
    decoratorConfig,
    extends: extendsName,
  } as SmartObjectDefinition;
}

function manifest(
  objects: Record<string, SmartObjectDefinition>,
): SmartObjectManifest {
  return {
    version: '1.0.0',
    timestamp: 0,
    packageName: '@happyvertical/smrt-test',
    objects,
  };
}

function schemaDefinitionFromManifest(
  schema: ManifestSchema,
): SchemaDefinition {
  return {
    tableName: schema.tableName,
    columns: Object.fromEntries(
      Object.entries(schema.columns).map(([name, column]) => [
        name,
        {
          type: column.type as SchemaDefinition['columns'][string]['type'],
          primaryKey: column.primaryKey,
          referenceKind: column.referenceKind,
          notNull: column.notNull,
          unique: column.unique,
          defaultValue: column.default,
        },
      ]),
    ),
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: schema.version,
  };
}

describe('R11 UUID schema generation', () => {
  it('emits UUID ids and relationship columns by default', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateCTISchemaFromManifest(
      'UuidSource',
      'uuid_sources',
      {
        parentId: { type: 'foreignKey', related: 'UuidTarget' },
        externalId: {
          type: 'crossPackageRef',
          related: '@happyvertical/smrt-other:ExternalTarget',
        },
      },
    );

    expect(schema.columns.id.type).toBe('UUID');
    expect(schema.columns.parent_id.type).toBe('UUID');
    expect(schema.columns.external_id.type).toBe('UUID');
    expect(schema.ddl).toContain('"id" UUID PRIMARY KEY');
    expect(schema.ddl).toContain('"parent_id" UUID');
    expect(schema.ddl).toContain('"external_id" UUID');

    const postgresDDL = generator.generateSQL(
      schemaDefinitionFromManifest(schema),
      'postgres',
    );
    expect(postgresDDL).toContain('"id" uuid PRIMARY KEY');
    expect(postgresDDL).toContain('"parent_id" uuid');
    expect(postgresDDL).toContain('"external_id" uuid');

    const sqliteDDL = generator.generateSQL(
      schemaDefinitionFromManifest(schema),
      'sqlite',
    );
    expect(sqliteDDL).toContain('"id" TEXT PRIMARY KEY');
    expect(sqliteDDL).toContain('"parent_id" TEXT');
  });

  it('honors idType text opt-out', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateCTISchemaFromManifest(
      'TextIdSource',
      'text_id_sources',
      {},
      { idType: 'text' },
    );

    expect(schema.columns.id.type).toBe('TEXT');
    expect(schema.ddl).toContain('"id" TEXT PRIMARY KEY');
  });

  it('matches same-package FK columns to the target id type', () => {
    const textTarget = objectDef('TextTarget', {}, { idType: 'text' });
    const uuidTarget = objectDef('UuidTarget');
    const source = objectDef('SourceModel', {
      textTargetId: { type: 'foreignKey', related: 'TextTarget' },
      uuidTargetId: { type: 'foreignKey', related: 'UuidTarget' },
      externalId: {
        type: 'crossPackageRef',
        related: '@happyvertical/smrt-other:ExternalTarget',
      },
    });
    const smrtManifest = manifest({
      TextTarget: textTarget,
      UuidTarget: uuidTarget,
      SourceModel: source,
    });

    new ManifestGenerator().generateSchemas(smrtManifest);

    expect(textTarget.schema?.columns.id.type).toBe('TEXT');
    expect(uuidTarget.schema?.columns.id.type).toBe('UUID');
    expect(source.schema?.columns.id.type).toBe('UUID');
    expect(source.schema?.columns.text_target_id.type).toBe('TEXT');
    expect(source.schema?.columns.uuid_target_id.type).toBe('UUID');
    expect(source.schema?.columns.external_id.type).toBe('UUID');
    expect(source.schema?.ddl).toContain('"text_target_id" TEXT');
    expect(source.schema?.ddl).toContain('"uuid_target_id" UUID');
  });

  it('uses canonical pluralization when resolving FK target tables', () => {
    const property = objectDef('Property', {}, { idType: 'text' });
    const listing = objectDef('Listing', {
      propertyId: { type: 'foreignKey', related: 'Property' },
    });
    const smrtManifest = manifest({ Property: property, Listing: listing });

    new ManifestGenerator().generateSchemas(smrtManifest);

    expect(property.schema?.tableName).toBe('properties');
    expect(listing.schema?.columns.property_id.type).toBe('TEXT');
    expect(listing.schema?.ddl).toContain('"property_id" TEXT');
  });

  it('normalizes inherited SmrtHierarchical parentId to a UUID self-FK', () => {
    const hierarchicalBase = objectDef('SmrtHierarchical', {
      parentId: { type: 'text', required: false },
    });
    const event = objectDef(
      'Event',
      { title: { type: 'text' } },
      { tableStrategy: 'sti' },
      'SmrtHierarchical',
    );
    const smrtManifest = manifest({
      SmrtHierarchical: hierarchicalBase,
      Event: event,
    });
    const generator = new ManifestGenerator();

    (generator as any).mergeInheritedFields(smrtManifest);
    generator.generateSchemas(smrtManifest);

    expect(event.fields.parentId.type).toBe('foreignKey');
    expect(event.fields.parentId.related).toBe('Event');
    expect(event.schema?.columns.parent_id.type).toBe('UUID');
    expect(event.schema?.ddl).toContain('"parent_id" UUID');
  });

  it('matches runtime FK columns to text id targets', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateSchemaFromRegistry(
      'RuntimeSource',
      'runtime_sources',
      new Map([
        [
          'textTargetId',
          { type: 'foreignKey', related: 'TextTarget', _meta: {} },
        ],
        [
          'uuidTargetId',
          { type: 'foreignKey', related: 'UuidTarget', _meta: {} },
        ],
      ]),
      {
        registry: {
          getConfig: (className) =>
            className === 'TextTarget' ? { idType: 'text' } : {},
          getDescendants: () => [],
          getAllFields: async () => new Map(),
        },
      },
    );

    expect(schema.columns.text_target_id.type).toBe('TEXT');
    expect(schema.columns.uuid_target_id.type).toBe('UUID');
  });

  it('honors cross-package text id hints', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateCTISchemaFromManifest(
      'SourceWithExternalTextId',
      'source_with_external_text_ids',
      {
        externalId: {
          type: 'crossPackageRef',
          related: '@happyvertical/smrt-external:ExternalTextId',
          _meta: { idType: 'text' },
        },
      },
    );

    expect(schema.columns.external_id.type).toBe('TEXT');
    expect(schema.ddl).toContain('"external_id" TEXT');
  });

  it('emits tenant scoped tenantId storage as UUID while keeping the field string-shaped', () => {
    const doc = objectDef(
      'TenantScopedDoc',
      {
        tenantId: { type: 'text', default: '' },
      },
      { tenantScoped: { mode: 'optional' } },
    );
    const smrtManifest = manifest({ TenantScopedDoc: doc });

    const generator = new ManifestGenerator();
    generator.injectTenantScopedFields(smrtManifest);
    generator.generateSchemas(smrtManifest);

    expect(doc.fields.tenantId).toEqual(
      expect.objectContaining({
        type: 'text',
        _meta: expect.objectContaining({
          sqlType: 'UUID',
          __tenancy: expect.objectContaining({
            isTenantIdField: true,
          }),
        }),
      }),
    );
    expect(doc.schema?.columns.tenant_id.type).toBe('UUID');
    expect(doc.schema?.columns.tenant_id.referenceKind).toBe('tenantId');
    expect(doc.schema?.columns.tenant_id.default).toBeUndefined();

    if (!doc.schema) {
      throw new Error('expected tenant scoped schema to be generated');
    }
    const postgresDDL = new SchemaGenerator().generateSQL(
      schemaDefinitionFromManifest(doc.schema),
      'postgres',
    );
    expect(postgresDDL).toContain('"tenant_id" uuid');
    expect(postgresDDL).not.toContain('"tenant_id" uuid DEFAULT');
  });
});
