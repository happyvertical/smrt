import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OverwriteTestObject,
  RegistryTestProduct,
  TestCategory,
  TestCustomer,
  TestOrder,
} from './__tests__/fixtures/registry-test-classes.js';
import { SmrtObject } from './object';
import { ObjectRegistry, smrt } from './registry';
import type { FieldDefinition } from './scanner/types.js';
import { tableNameFromClass } from './utils';

// Helper class to create field definitions for manual registration
class Field implements FieldDefinition {
  type: FieldDefinition['type'];
  _meta: Record<string, any>;
  related?: string;

  constructor(
    type: FieldDefinition['type'],
    options: Record<string, any> = {},
  ) {
    this.type = type;
    // Extract 'related' as a top-level property (not in _meta)
    if (options.related) {
      this.related = options.related;
      const { related, ...metaOptions } = options;
      this._meta = metaOptions;
    } else {
      this._meta = options;
    }
  }
}

// Helper to manually register test classes with field metadata
function registerTestClass(
  classConstructor: typeof SmrtObject,
  fields: Map<string, any>,
) {
  // First register the class normally
  ObjectRegistry.register(classConstructor, {
    api: { include: ['list', 'get', 'create'] },
    mcp: { include: ['list', 'get'] },
    cli: true,
  });

  // Then manually override the fields and recompile validators
  const registered = (ObjectRegistry as any).classes.get(classConstructor.name);
  if (registered) {
    registered.fields = fields;

    // Recompile validators based on new field definitions
    registered.validators = (ObjectRegistry as any).compileValidators(
      classConstructor.name,
      fields,
    );
  }
}

describe('ObjectRegistry', () => {
  beforeEach(() => {
    // Clear registry before each test
    ObjectRegistry.clear();
  });

  afterEach(() => {
    // Clean up after each test
    ObjectRegistry.clear();
  });

  describe('Basic Registration', () => {
    it('should register classes via @smrt decorator', () => {
      // Manually register test class
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(RegistryTestProduct, fields);

      expect(ObjectRegistry.hasClass('RegistryTestProduct')).toBe(true);
      expect(ObjectRegistry.hasClass('registrytestproduct')).toBe(true); // Case insensitive
    });

    it('should get class names', () => {
      // Register multiple test classes
      const productFields = new Map();
      productFields.set('name', new Field('text', { required: true }));
      productFields.set('price', new Field('decimal', {}));
      registerTestClass(RegistryTestProduct, productFields);

      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      const names = ObjectRegistry.getClassNames();
      expect(names).toContain('RegistryTestProduct');
      expect(names).toContain('TestCategory');
    });

    it('should handle case-insensitive lookups', () => {
      const fields = new Map();
      fields.set('name', new Field('text', {}));
      registerTestClass(RegistryTestProduct, fields);

      expect(ObjectRegistry.hasClass('RegistryTestProduct')).toBe(true);
      expect(ObjectRegistry.hasClass('registrytestproduct')).toBe(true);
      expect(ObjectRegistry.hasClass('REGISTRYTESTPRODUCT')).toBe(true);
    });
  });

  describe('getObjectMetadata', () => {
    it('should return null for non-existent class', () => {
      const metadata = ObjectRegistry.getObjectMetadata('NonExistent');
      expect(metadata).toBeNull();
    });

    it('should return complete metadata for registered class', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(RegistryTestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('RegistryTestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata?.name).toBe('RegistryTestProduct');
      expect(metadata?.constructor).toBe(RegistryTestProduct);
      expect(metadata?.config.api).toEqual({
        include: ['list', 'get', 'create'],
      });
      expect(metadata?.config.mcp).toEqual({ include: ['list', 'get'] });
      expect(metadata?.config.cli).toBe(true);
    });

    it('should include field definitions', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(RegistryTestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('RegistryTestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata?.fields).toBeInstanceOf(Map);
      expect(metadata?.fields.has('name')).toBe(true);
      expect(metadata?.fields.has('price')).toBe(true);
      expect(metadata?.fields.has('categoryId')).toBe(true);

      const nameField = metadata?.fields.get('name');
      expect(nameField.type).toBe('text');
      expect(nameField._meta.required).toBe(true);
      expect(nameField._meta.maxLength).toBe(100);
    });

    it('should include schema definition', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(RegistryTestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('RegistryTestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata?.schema).toBeDefined();
      expect(metadata?.schema?.tableName).toBe('registry_test_products');
      // Schema DDL is now generated lazily (deferred until needed)
      expect(metadata?.schema?.ddl).toBeDefined();
      expect(metadata?.schema?.triggers).toBeInstanceOf(Array);
    });

    it('should include validators', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(RegistryTestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('RegistryTestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata?.validators).toBeInstanceOf(Array);
      expect(metadata?.validators.length).toBeGreaterThan(0); // Has required field validators
    });

    it('should include relationships', () => {
      // Register TestCategory first (dependency)
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register RegistryTestProduct with foreign key to TestCategory
      const productFields = new Map();
      productFields.set(
        'name',
        new Field('text', { required: true, maxLength: 100 }),
      );
      productFields.set('price', new Field('decimal', { min: 0 }));
      productFields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );
      registerTestClass(RegistryTestProduct, productFields);

      const metadata = ObjectRegistry.getObjectMetadata('RegistryTestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata?.relationships).toBeInstanceOf(Array);

      const categoryRel = metadata?.relationships.find(
        (r) => r.fieldName === 'categoryId',
      );
      expect(categoryRel).toBeDefined();
      expect(categoryRel?.type).toBe('foreignKey');
      expect(categoryRel?.targetClass).toBe('TestCategory');
    });

    it('should include inverse relationships', () => {
      // Register TestCategory first (dependency)
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register RegistryTestProduct with foreign key to TestCategory
      const productFields = new Map();
      productFields.set(
        'name',
        new Field('text', { required: true, maxLength: 100 }),
      );
      productFields.set('price', new Field('decimal', { min: 0 }));
      productFields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );
      registerTestClass(RegistryTestProduct, productFields);

      const metadata = ObjectRegistry.getObjectMetadata('TestCategory');

      expect(metadata).not.toBeNull();
      expect(metadata?.inverseRelationships).toBeInstanceOf(Array);

      // TestCategory should have inverse relationship from RegistryTestProduct.categoryId
      const inverseRel = metadata?.inverseRelationships.find(
        (r) =>
          r.sourceClass === 'RegistryTestProduct' &&
          r.fieldName === 'categoryId',
      );
      expect(inverseRel).toBeDefined();
      expect(inverseRel?.targetClass).toBe('TestCategory');
    });

    it('should work with case-insensitive class names', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(RegistryTestProduct, fields);

      const metadata1 = ObjectRegistry.getObjectMetadata('RegistryTestProduct');
      const metadata2 = ObjectRegistry.getObjectMetadata('registrytestproduct');
      const metadata3 = ObjectRegistry.getObjectMetadata('REGISTRYTESTPRODUCT');

      expect(metadata1).not.toBeNull();
      expect(metadata2).not.toBeNull();
      expect(metadata3).not.toBeNull();
      expect(metadata1?.name).toBe(metadata2?.name);
      expect(metadata2?.name).toBe(metadata3?.name);
    });
  });

  describe('getAllObjectMetadata', () => {
    it('should return empty array when no classes registered', () => {
      const allMetadata = ObjectRegistry.getAllObjectMetadata();
      expect(allMetadata).toEqual([]);
    });

    it('should return metadata for all registered classes', () => {
      // Register TestCategory
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register RegistryTestProduct
      const productFields = new Map();
      productFields.set(
        'name',
        new Field('text', { required: true, maxLength: 100 }),
      );
      productFields.set('price', new Field('decimal', { min: 0 }));
      productFields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );
      registerTestClass(RegistryTestProduct, productFields);

      // Register TestOrder
      const orderFields = new Map();
      orderFields.set(
        'customerId',
        new Field('foreignKey', { related: 'TestCustomer' }),
      );
      orderFields.set(
        'productId',
        new Field('foreignKey', { related: 'RegistryTestProduct' }),
      );
      orderFields.set('total', new Field('decimal', { min: 0 }));
      registerTestClass(TestOrder, orderFields);

      const allMetadata = ObjectRegistry.getAllObjectMetadata();

      expect(allMetadata.length).toBe(3);
      expect(allMetadata.map((m) => m.name)).toContain('RegistryTestProduct');
      expect(allMetadata.map((m) => m.name)).toContain('TestCategory');
      expect(allMetadata.map((m) => m.name)).toContain('TestOrder');
    });

    it('should include complete metadata for each class', () => {
      // Register TestCategory
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register RegistryTestProduct
      const productFields = new Map();
      productFields.set(
        'name',
        new Field('text', { required: true, maxLength: 100 }),
      );
      productFields.set('price', new Field('decimal', { min: 0 }));
      productFields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );
      registerTestClass(RegistryTestProduct, productFields);

      const allMetadata = ObjectRegistry.getAllObjectMetadata();

      expect(allMetadata.length).toBe(2);

      for (const metadata of allMetadata) {
        expect(metadata.name).toBeDefined();
        expect(metadata.constructor).toBeDefined();
        expect(metadata.config).toBeDefined();
        expect(metadata.fields).toBeInstanceOf(Map);
        expect(metadata.schema).toBeDefined();
        expect(metadata.validators).toBeInstanceOf(Array);
        expect(metadata.relationships).toBeInstanceOf(Array);
        expect(metadata.inverseRelationships).toBeInstanceOf(Array);
      }
    });

    it('should be useful for admin dashboard generation', () => {
      // Register TestCategory
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register TestCustomer
      const customerFields = new Map();
      customerFields.set('name', new Field('text', { required: true }));
      customerFields.set('email', new Field('text', { required: true }));
      registerTestClass(TestCustomer, customerFields);

      // Register RegistryTestProduct
      const productFields = new Map();
      productFields.set(
        'name',
        new Field('text', { required: true, maxLength: 100 }),
      );
      productFields.set('price', new Field('decimal', { min: 0 }));
      productFields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );
      registerTestClass(RegistryTestProduct, productFields);

      // Register TestOrder
      const orderFields = new Map();
      orderFields.set(
        'customerId',
        new Field('foreignKey', { related: 'TestCustomer' }),
      );
      orderFields.set(
        'productId',
        new Field('foreignKey', { related: 'RegistryTestProduct' }),
      );
      orderFields.set('total', new Field('decimal', { min: 0 }));
      registerTestClass(TestOrder, orderFields);

      const allMetadata = ObjectRegistry.getAllObjectMetadata();

      // Generate admin dashboard data
      const dashboardData = allMetadata.map((meta) => ({
        name: meta.name,
        table: meta.schema?.tableName,
        fieldCount: meta.fields.size,
        hasAPI: !!meta.config.api,
        hasCLI: !!meta.config.cli,
        relationshipCount: meta.relationships.length,
      }));

      // Since we register all classes with the same config, they all have the same API/CLI settings
      // Verify all classes are registered with correct field counts and relationships
      expect(dashboardData.length).toBe(4);

      const testProduct = dashboardData.find(
        (d) => d.name === 'RegistryTestProduct',
      );
      expect(testProduct).toBeDefined();
      expect(testProduct?.fieldCount).toBe(3);
      expect(testProduct?.hasAPI).toBe(true);
      expect(testProduct?.hasCLI).toBe(true);
      expect(testProduct?.relationshipCount).toBe(1); // Has categoryId foreignKey

      const testCategory = dashboardData.find((d) => d.name === 'TestCategory');
      expect(testCategory).toBeDefined();
      expect(testCategory?.fieldCount).toBe(2);
      expect(testCategory?.hasAPI).toBe(true);
      expect(testCategory?.hasCLI).toBe(true);
      expect(testCategory?.relationshipCount).toBe(0);

      const testOrder = dashboardData.find((d) => d.name === 'TestOrder');
      expect(testOrder).toBeDefined();
      expect(testOrder?.fieldCount).toBe(3);
      expect(testOrder?.hasAPI).toBe(true);
      expect(testOrder?.hasCLI).toBe(true);
      expect(testOrder?.relationshipCount).toBe(2); // Has customerId and productId foreignKeys

      const testCustomer = dashboardData.find((d) => d.name === 'TestCustomer');
      expect(testCustomer).toBeDefined();
      expect(testCustomer?.fieldCount).toBe(2);
      expect(testCustomer?.hasAPI).toBe(true);
      expect(testCustomer?.hasCLI).toBe(true);
      expect(testCustomer?.relationshipCount).toBe(0);
    });

    it('should be useful for schema documentation generation', () => {
      // Register TestCategory
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register RegistryTestProduct
      const productFields = new Map();
      productFields.set(
        'name',
        new Field('text', { required: true, maxLength: 100 }),
      );
      productFields.set('price', new Field('decimal', { min: 0 }));
      productFields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );
      registerTestClass(RegistryTestProduct, productFields);

      const allMetadata = ObjectRegistry.getAllObjectMetadata();

      // Generate schema documentation
      const schemaDoc = allMetadata.map((meta) => ({
        name: meta.name,
        table: meta.schema?.tableName,
        fields: Array.from(meta.fields.entries()).map(([name, field]) => ({
          name,
          type: field.type,
          required: field._meta?.required || false,
        })),
        relationships: meta.relationships.map((rel) => ({
          field: rel.fieldName,
          target: rel.targetClass,
          type: rel.type,
        })),
      }));

      expect(schemaDoc.length).toBe(2);

      // Check RegistryTestProduct schema
      const productDoc = schemaDoc.find(
        (doc) => doc.name === 'RegistryTestProduct',
      );
      expect(productDoc).toBeDefined();
      expect(productDoc?.table).toBe('registry_test_products');
      expect(productDoc?.fields).toContainEqual({
        name: 'name',
        type: 'text',
        required: true,
      });
      expect(productDoc?.fields).toContainEqual({
        name: 'price',
        type: 'decimal',
        required: false,
      });
      expect(productDoc?.relationships).toContainEqual({
        field: 'categoryId',
        target: 'TestCategory',
        type: 'foreignKey',
      });
    });
  });

  describe('Convenience Method Integration', () => {
    it('should provide consistent data between getObjectMetadata and direct registry queries', () => {
      const productFields = new Map();
      productFields.set(
        'name',
        new Field('text', { required: true, maxLength: 100 }),
      );
      productFields.set('price', new Field('decimal', { min: 0 }));
      productFields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(RegistryTestProduct, productFields);

      // Get via convenience method
      const metadata = ObjectRegistry.getObjectMetadata('RegistryTestProduct');

      // Get via direct queries
      const config = ObjectRegistry.getConfig('RegistryTestProduct');
      const fields = ObjectRegistry.getFields('RegistryTestProduct');
      const schema = ObjectRegistry.getSchema('RegistryTestProduct');
      const validators = ObjectRegistry.getValidators('RegistryTestProduct');
      const relationships = ObjectRegistry.getRelationships(
        'RegistryTestProduct',
      );

      // Compare
      expect(metadata?.config).toEqual(config);
      expect(metadata?.fields.size).toBe(fields.size);
      expect(metadata?.schema).toEqual(schema);
      expect(metadata?.validators).toEqual(validators);
      expect(metadata?.relationships).toEqual(relationships);
    });

    it('should return field map copies to prevent mutations', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(RegistryTestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('RegistryTestProduct');
      const originalSize = metadata?.fields.size;

      // Attempt to mutate
      metadata?.fields.set('newField', { type: 'text' });

      // Get fresh metadata
      const freshMetadata = ObjectRegistry.getObjectMetadata(
        'RegistryTestProduct',
      );

      expect(freshMetadata?.fields.size).toBe(originalSize);
      expect(freshMetadata?.fields.has('newField')).toBe(false);
    });
  });

  describe('getMethods', () => {
    it('should return empty Map for class with no methods', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true }));
      registerTestClass(TestCategory, fields);

      const methods = ObjectRegistry.getMethods('TestCategory');
      expect(methods).toBeInstanceOf(Map);
      expect(methods.size).toBe(0);
    });

    it('should return method definitions from manifest', () => {
      // Register class with methods metadata
      const fields = new Map();
      fields.set('name', new Field('text', { required: true }));
      registerTestClass(RegistryTestProduct, fields);

      // Manually add method metadata (simulating what would come from manifest)
      const registered = (ObjectRegistry as any).classes.get(
        'RegistryTestProduct',
      );
      if (registered) {
        registered.methods.set('analyze', {
          name: 'analyze',
          async: true,
          isStatic: false,
          isPublic: true,
          returnType: 'Promise<any>',
          parameters: [
            { name: 'options', type: 'any', optional: true, default: {} },
          ],
          description: 'Analyze the product',
        });
        registered.methods.set('sync', {
          name: 'sync',
          async: true,
          isStatic: false,
          isPublic: true,
          returnType: 'Promise<void>',
          parameters: [],
          description: 'Sync product data',
        });
      }

      const methods = ObjectRegistry.getMethods('RegistryTestProduct');

      expect(methods).toBeInstanceOf(Map);
      expect(methods.size).toBe(2);
      expect(methods.has('analyze')).toBe(true);
      expect(methods.has('sync')).toBe(true);

      const analyzeMethod = methods.get('analyze');
      expect(analyzeMethod.name).toBe('analyze');
      expect(analyzeMethod.async).toBe(true);
      expect(analyzeMethod.isPublic).toBe(true);
      expect(analyzeMethod.returnType).toBe('Promise<any>');
      expect(analyzeMethod.parameters).toHaveLength(1);
      expect(analyzeMethod.parameters[0].name).toBe('options');

      const syncMethod = methods.get('sync');
      expect(syncMethod.name).toBe('sync');
      expect(syncMethod.async).toBe(true);
      expect(syncMethod.parameters).toHaveLength(0);
    });

    it('should return empty Map for non-existent class', () => {
      const methods = ObjectRegistry.getMethods('NonExistent');
      expect(methods).toBeInstanceOf(Map);
      expect(methods.size).toBe(0);
    });

    it('should include methods in getObjectMetadata', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true }));
      registerTestClass(RegistryTestProduct, fields);

      // Add method metadata
      const registered = (ObjectRegistry as any).classes.get(
        'RegistryTestProduct',
      );
      if (registered) {
        registered.methods.set('research', {
          name: 'research',
          async: true,
          isStatic: false,
          isPublic: true,
          returnType: 'Promise<string>',
          parameters: [{ name: 'query', type: 'string', optional: false }],
        });
      }

      const metadata = ObjectRegistry.getObjectMetadata('RegistryTestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata?.methods).toBeInstanceOf(Map);
      expect(metadata?.methods.size).toBeGreaterThanOrEqual(1);
      expect(metadata?.methods.has('research')).toBe(true);

      const researchMethod = metadata?.methods.get('research');
      expect(researchMethod.name).toBe('research');
      expect(researchMethod.async).toBe(true);
      expect(researchMethod.parameters[0].name).toBe('query');
    });
  });

  describe('Dependency Graph and Relationships', () => {
    it('should build correct dependency graph', () => {
      // Register TestCategory
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register TestCustomer
      const customerFields = new Map();
      customerFields.set('name', new Field('text', { required: true }));
      customerFields.set('email', new Field('text', { required: true }));
      registerTestClass(TestCustomer, customerFields);

      // Register RegistryTestProduct
      const productFields = new Map();
      productFields.set(
        'name',
        new Field('text', { required: true, maxLength: 100 }),
      );
      productFields.set('price', new Field('decimal', { min: 0 }));
      productFields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );
      registerTestClass(RegistryTestProduct, productFields);

      // Register TestOrder
      const orderFields = new Map();
      orderFields.set(
        'customerId',
        new Field('foreignKey', { related: 'TestCustomer' }),
      );
      orderFields.set(
        'productId',
        new Field('foreignKey', { related: 'RegistryTestProduct' }),
      );
      orderFields.set('total', new Field('decimal', { min: 0 }));
      registerTestClass(TestOrder, orderFields);

      const graph = ObjectRegistry.getDependencyGraph();

      expect(graph.get('TestOrder')).toContain('TestCustomer');
      expect(graph.get('TestOrder')).toContain('RegistryTestProduct');
      expect(graph.get('RegistryTestProduct')).toContain('TestCategory');
      expect(graph.get('TestCategory')).toEqual([]);
      expect(graph.get('TestCustomer')).toEqual([]);
    });

    it('should calculate correct initialization order', () => {
      // Register TestCategory
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register TestCustomer
      const customerFields = new Map();
      customerFields.set('name', new Field('text', { required: true }));
      customerFields.set('email', new Field('text', { required: true }));
      registerTestClass(TestCustomer, customerFields);

      // Register RegistryTestProduct
      const productFields = new Map();
      productFields.set(
        'name',
        new Field('text', { required: true, maxLength: 100 }),
      );
      productFields.set('price', new Field('decimal', { min: 0 }));
      productFields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );
      registerTestClass(RegistryTestProduct, productFields);

      // Register TestOrder
      const orderFields = new Map();
      orderFields.set(
        'customerId',
        new Field('foreignKey', { related: 'TestCustomer' }),
      );
      orderFields.set(
        'productId',
        new Field('foreignKey', { related: 'RegistryTestProduct' }),
      );
      orderFields.set('total', new Field('decimal', { min: 0 }));
      registerTestClass(TestOrder, orderFields);

      const order = ObjectRegistry.getInitializationOrder();

      // TestCategory and TestCustomer have no dependencies (can be in any order)
      // RegistryTestProduct depends on TestCategory
      // TestOrder depends on TestCustomer and RegistryTestProduct

      const categoryIndex = order.indexOf('TestCategory');
      const customerIndex = order.indexOf('TestCustomer');
      const productIndex = order.indexOf('RegistryTestProduct');
      const orderIndex = order.indexOf('TestOrder');

      expect(categoryIndex).toBeLessThan(productIndex);
      expect(productIndex).toBeLessThan(orderIndex);
      expect(customerIndex).toBeLessThan(orderIndex);
    });

    it('should handle self-referencing classes (Issue #728)', () => {
      // Self-referencing class like Tenant with parentTenantId -> Tenant
      class SelfRefClass extends SmrtObject {
        name: string = '';
        parentId?: string;
      }

      const fields = new Map();
      fields.set('name', new Field('text', { required: true }));
      fields.set(
        'parentId',
        new Field('foreignKey', { related: 'SelfRefClass', nullable: true }),
      );
      registerTestClass(SelfRefClass, fields);

      // Should NOT throw circular dependency error
      const order = ObjectRegistry.getInitializationOrder();

      // Self-referencing class should be in the order
      expect(order).toContain('SelfRefClass');

      // Verify dependency graph excludes self-reference
      const graph = ObjectRegistry.getDependencyGraph();
      expect(graph.get('SelfRefClass')).toEqual([]);
    });

    it('should handle unregistered parent classes gracefully (Issue #735)', () => {
      // Simulate a child class with an unregistered parent
      // This happens when parent is from an external package that hasn't been loaded
      @smrt()
      class ChildClass extends SmrtObject {
        name: string = '';
      }

      // Manually set extends to a non-existent parent (simulating external package parent)
      const registered = (ObjectRegistry as any).classes.get('ChildClass');
      expect(registered).toBeDefined();

      // Manually set extends to an unregistered class
      registered.extends = 'NonExistentParent';

      // Clear the inheritance cache so it recomputes
      registered.inheritanceChain = undefined;

      // getInheritanceChain should not throw, and should return a chain
      // that includes only the registered classes
      const chain = ObjectRegistry.getInheritanceChain('ChildClass');

      // Chain should contain at least the child class
      expect(chain).toContain('ChildClass');

      // Since NonExistentParent isn't in any manifest, chain should only have ChildClass
      expect(chain.length).toBe(1);
    });

    it('should skip framework base classes in inheritance chain (Issue #735)', () => {
      @smrt()
      class TestObject extends SmrtObject {
        name: string = '';
      }

      // Get the inheritance chain
      const chain = ObjectRegistry.getInheritanceChain('TestObject');

      // Should contain TestObject but not SmrtObject
      expect(chain).toContain('TestObject');
      expect(chain).not.toContain('SmrtObject');
      expect(chain).not.toContain('SmrtClass');
      expect(chain).not.toContain('SmrtCollection');
    });
  });

  describe('Table Name Capture (Issue #9 - Phase 1)', () => {
    it('should work with @smrt decorator syntax', () => {
      @smrt()
      class DecoratorTest extends SmrtObject {
        name: string = '';
      }

      // Verify SMRT_TABLE_NAME was set by decorator
      expect('SMRT_TABLE_NAME' in DecoratorTest).toBe(true);
      expect((DecoratorTest as any).SMRT_TABLE_NAME).toBe('decorator_tests');
    });

    it('should work with @smrt decorator and custom tableName', () => {
      @smrt({ tableName: 'super_custom_table' })
      class CustomDecoratorTest extends SmrtObject {
        name: string = '';
      }

      // Verify custom tableName was set
      expect((CustomDecoratorTest as any).SMRT_TABLE_NAME).toBe(
        'super_custom_table',
      );
    });

    it('should use captured table name from SMRT_TABLE_NAME property', () => {
      @smrt()
      class TableNameTest extends SmrtObject {
        name: string = '';
      }

      const metadata = ObjectRegistry.getObjectMetadata('TableNameTest');
      expect(metadata?.schema?.tableName).toBe('table_name_tests');
    });

    it('should respect custom tableName in config', () => {
      @smrt({ tableName: 'my_custom_products' })
      class CustomTableProduct extends SmrtObject {
        name: string = '';
        price: number = 0;
      }

      const metadata = ObjectRegistry.getObjectMetadata('CustomTableProduct');
      expect(metadata?.schema?.tableName).toBe('my_custom_products');

      // Check SMRT_TABLE_NAME property
      expect((CustomTableProduct as any).SMRT_TABLE_NAME).toBe(
        'my_custom_products',
      );
    });

    it('should survive minification (simulated)', () => {
      // Simulate what happens during minification - the class name changes
      // but SMRT_TABLE_NAME should remain

      @smrt()
      class OriginalClassName extends SmrtObject {
        name: string = '';
      }

      // Capture the SMRT_TABLE_NAME before "minification"
      const capturedTableName = (OriginalClassName as any).SMRT_TABLE_NAME;
      expect(capturedTableName).toBe('original_class_names');

      // Even if the class name gets mangled (simulated), the property remains
      // In real minification, OriginalClassName.name might become "a" or "b"
      // but SMRT_TABLE_NAME is a property value, not derived from the name
      Object.defineProperty(OriginalClassName, 'name', {
        value: 'a', // Simulated minified name
        configurable: true,
      });

      // The SMRT_TABLE_NAME should still be the original
      expect((OriginalClassName as any).SMRT_TABLE_NAME).toBe(
        'original_class_names',
      );
    });

    it('should use SMRT_TABLE_NAME in tableNameFromClass()', () => {
      @smrt()
      class TestForTableName extends SmrtObject {
        name: string = '';
      }

      const tableName = tableNameFromClass(TestForTableName);

      // Should read from SMRT_TABLE_NAME property, not derive from class name
      expect(tableName).toBe('test_for_table_names');
    });
  });

  describe('Mixed Field helpers and primitives (Issue #102, #103)', () => {
    // OBSOLETE after PR #129: Runtime primitive type inference was removed
    // PR #129 requires explicit Field helpers for all fields
    // These tests expected automatic inference from primitives, which no longer works
    it.skip('should detect base class fields even when using Field helpers - OBSOLETE after PR #129', () => {
      @smrt()
      class MixedFieldsObject extends SmrtObject {
        name = '';
        date = datetime({ nullable: true }); // Field helper
        // Base class fields (created_at, updated_at) are still inferred
      }

      const fields = ObjectRegistry.getFields('MixedFieldsObject');

      // Field helper should be present
      expect(fields.get('date')).toBeDefined();
      expect(fields.get('date')?.type).toBe('datetime');

      // Base class fields should ALSO be present (fixes all-or-nothing bug)
      expect(fields.get('name')).toBeDefined();
      expect(fields.get('created_at')).toBeDefined();
      expect(fields.get('created_at')?.type).toBe('datetime');
      expect(fields.get('updated_at')).toBeDefined();
      expect(fields.get('updated_at')?.type).toBe('datetime');
    });

    it.skip('should handle mix of Field helpers and custom primitives - OBSOLETE after PR #129', () => {
      @smrt()
      class ProductWithMixedFields extends SmrtObject {
        title = text({ required: true }); // Field helper
        price = decimal({ min: 0 }); // Field helper
        description = text(); // Primitive (should infer TEXT)
        stock: number = 0; // Primitive (should infer INTEGER)
        active: boolean = true; // Primitive (should infer BOOLEAN)
      }

      const fields = ObjectRegistry.getFields('ProductWithMixedFields');

      // Field helpers should be present with their configuration
      expect(fields.get('title')).toBeDefined();
      expect(fields.get('title')?.type).toBe('text');
      expect(fields.get('title')?.options?.required).toBe(true);

      expect(fields.get('price')).toBeDefined();
      expect(fields.get('price')?.type).toBe('decimal');

      // Primitives should be inferred (not skipped!)
      expect(fields.get('description')).toBeDefined();
      expect(fields.get('description')?.type).toBe('text');

      expect(fields.get('stock')).toBeDefined();
      expect(fields.get('stock')?.type).toBe('integer');

      expect(fields.get('active')).toBeDefined();
      expect(fields.get('active')?.type).toBe('boolean');
    });

    it('should not overwrite Field helpers with primitive inference', () => {
      // OverwriteTestObject is defined at top level, but AST scanner doesn't capture
      // all Field helper options (like maxLength). Use manual registration for precise control.
      const fields = new Map<string, any>();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));

      registerTestClass(OverwriteTestObject, fields);

      const registeredFields = ObjectRegistry.getFields('OverwriteTestObject');

      // Field helper configuration should be preserved
      expect(registeredFields.get('name')).toBeDefined();
      expect(registeredFields.get('name')?.type).toBe('text');
      expect(registeredFields.get('name')?._meta?.required).toBe(true);
      expect(registeredFields.get('name')?._meta?.maxLength).toBe(100);
    });

    it.skip('should handle nullable fields with Field helpers - OBSOLETE after PR #129', () => {
      @smrt()
      class MeetingWithNullableDate extends SmrtObject {
        date = datetime({ nullable: true }); // Explicit nullable
        title: string = ''; // Primitive
        location: string | null = null; // Nullable primitive (should infer)
      }

      const fields = ObjectRegistry.getFields('MeetingWithNullableDate');

      // Field helper for date
      expect(fields.get('date')).toBeDefined();
      expect(fields.get('date')?.type).toBe('datetime');
      expect(fields.get('date')?.options?.nullable).toBe(true);

      // Primitive fields should still be detected
      expect(fields.get('title')).toBeDefined();
      expect(fields.get('title')?.type).toBe('text');

      expect(fields.get('location')).toBeDefined();
      // Nullable string should be detected as text type
      expect(fields.get('location')?.type).toBe('text');
    });
  });
});
