import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Field } from './fields/index';
import { SmrtObject } from './object';
import { ObjectRegistry, smrt } from './registry';
import { tableNameFromClass } from './utils';

// Test classes - Need @smrt() decorator for Phase 2 registration
// Phase 2: @smrt() decorator needed for test classes (not in AST manifest)

@smrt()
class TestCategory extends SmrtObject {
  name: string = '';
  description: string = '';
}

@smrt()
class TestCustomer extends SmrtObject {
  name: string = '';
  email: string = '';
}

@smrt()
class TestProduct extends SmrtObject {
  name: string = '';
  price: number = 0;
  categoryId: string = '';
}

@smrt()
class TestOrder extends SmrtObject {
  customerId: string = '';
  productId: string = '';
  total: number = 0;
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

      registerTestClass(TestProduct, fields);

      expect(ObjectRegistry.hasClass('TestProduct')).toBe(true);
      expect(ObjectRegistry.hasClass('testproduct')).toBe(true); // Case insensitive
    });

    it('should get class names', () => {
      // Register multiple test classes
      const productFields = new Map();
      productFields.set('name', new Field('text', { required: true }));
      productFields.set('price', new Field('decimal', {}));
      registerTestClass(TestProduct, productFields);

      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      const names = ObjectRegistry.getClassNames();
      expect(names).toContain('TestProduct');
      expect(names).toContain('TestCategory');
    });

    it('should handle case-insensitive lookups', () => {
      const fields = new Map();
      fields.set('name', new Field('text', {}));
      registerTestClass(TestProduct, fields);

      expect(ObjectRegistry.hasClass('TestProduct')).toBe(true);
      expect(ObjectRegistry.hasClass('testproduct')).toBe(true);
      expect(ObjectRegistry.hasClass('TESTPRODUCT')).toBe(true);
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

      registerTestClass(TestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('TestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata!.name).toBe('TestProduct');
      expect(metadata!.constructor).toBe(TestProduct);
      expect(metadata!.config.api).toEqual({
        include: ['list', 'get', 'create'],
      });
      expect(metadata!.config.mcp).toEqual({ include: ['list', 'get'] });
      expect(metadata!.config.cli).toBe(true);
    });

    it('should include field definitions', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(TestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('TestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata!.fields).toBeInstanceOf(Map);
      expect(metadata!.fields.has('name')).toBe(true);
      expect(metadata!.fields.has('price')).toBe(true);
      expect(metadata!.fields.has('categoryId')).toBe(true);

      const nameField = metadata!.fields.get('name');
      expect(nameField.type).toBe('text');
      expect(nameField.options.required).toBe(true);
      expect(nameField.options.maxLength).toBe(100);
    });

    it('should include schema definition', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(TestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('TestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata!.schema).toBeDefined();
      expect(metadata!.schema!.tableName).toBe('test_products');
      expect(metadata!.schema!.ddl).toContain('CREATE TABLE');
      expect(metadata!.schema!.triggers).toBeInstanceOf(Array);
    });

    it('should include validators', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(TestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('TestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata!.validators).toBeInstanceOf(Array);
      expect(metadata!.validators.length).toBeGreaterThan(0); // Has required field validators
    });

    it('should include relationships', () => {
      // Register TestCategory first (dependency)
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register TestProduct with foreign key to TestCategory
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
      registerTestClass(TestProduct, productFields);

      const metadata = ObjectRegistry.getObjectMetadata('TestProduct');

      expect(metadata).not.toBeNull();
      expect(metadata!.relationships).toBeInstanceOf(Array);

      const categoryRel = metadata!.relationships.find(
        (r) => r.fieldName === 'categoryId',
      );
      expect(categoryRel).toBeDefined();
      expect(categoryRel!.type).toBe('foreignKey');
      expect(categoryRel!.targetClass).toBe('TestCategory');
    });

    it('should include inverse relationships', () => {
      // Register TestCategory first (dependency)
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register TestProduct with foreign key to TestCategory
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
      registerTestClass(TestProduct, productFields);

      const metadata = ObjectRegistry.getObjectMetadata('TestCategory');

      expect(metadata).not.toBeNull();
      expect(metadata!.inverseRelationships).toBeInstanceOf(Array);

      // TestCategory should have inverse relationship from TestProduct.categoryId
      const inverseRel = metadata!.inverseRelationships.find(
        (r) => r.sourceClass === 'TestProduct' && r.fieldName === 'categoryId',
      );
      expect(inverseRel).toBeDefined();
      expect(inverseRel!.targetClass).toBe('TestCategory');
    });

    it('should work with case-insensitive class names', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(TestProduct, fields);

      const metadata1 = ObjectRegistry.getObjectMetadata('TestProduct');
      const metadata2 = ObjectRegistry.getObjectMetadata('testproduct');
      const metadata3 = ObjectRegistry.getObjectMetadata('TESTPRODUCT');

      expect(metadata1).not.toBeNull();
      expect(metadata2).not.toBeNull();
      expect(metadata3).not.toBeNull();
      expect(metadata1!.name).toBe(metadata2!.name);
      expect(metadata2!.name).toBe(metadata3!.name);
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

      // Register TestProduct
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
      registerTestClass(TestProduct, productFields);

      // Register TestOrder
      const orderFields = new Map();
      orderFields.set(
        'customerId',
        new Field('foreignKey', { related: 'TestCustomer' }),
      );
      orderFields.set(
        'productId',
        new Field('foreignKey', { related: 'TestProduct' }),
      );
      orderFields.set('total', new Field('decimal', { min: 0 }));
      registerTestClass(TestOrder, orderFields);

      const allMetadata = ObjectRegistry.getAllObjectMetadata();

      expect(allMetadata.length).toBe(3);
      expect(allMetadata.map((m) => m.name)).toContain('TestProduct');
      expect(allMetadata.map((m) => m.name)).toContain('TestCategory');
      expect(allMetadata.map((m) => m.name)).toContain('TestOrder');
    });

    it('should include complete metadata for each class', () => {
      // Register TestCategory
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register TestProduct
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
      registerTestClass(TestProduct, productFields);

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

      // Register TestProduct
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
      registerTestClass(TestProduct, productFields);

      // Register TestOrder
      const orderFields = new Map();
      orderFields.set(
        'customerId',
        new Field('foreignKey', { related: 'TestCustomer' }),
      );
      orderFields.set(
        'productId',
        new Field('foreignKey', { related: 'TestProduct' }),
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

      const testProduct = dashboardData.find((d) => d.name === 'TestProduct');
      expect(testProduct).toBeDefined();
      expect(testProduct!.fieldCount).toBe(3);
      expect(testProduct!.hasAPI).toBe(true);
      expect(testProduct!.hasCLI).toBe(true);
      expect(testProduct!.relationshipCount).toBe(1); // Has categoryId foreignKey

      const testCategory = dashboardData.find((d) => d.name === 'TestCategory');
      expect(testCategory).toBeDefined();
      expect(testCategory!.fieldCount).toBe(2);
      expect(testCategory!.hasAPI).toBe(true);
      expect(testCategory!.hasCLI).toBe(true);
      expect(testCategory!.relationshipCount).toBe(0);

      const testOrder = dashboardData.find((d) => d.name === 'TestOrder');
      expect(testOrder).toBeDefined();
      expect(testOrder!.fieldCount).toBe(3);
      expect(testOrder!.hasAPI).toBe(true);
      expect(testOrder!.hasCLI).toBe(true);
      expect(testOrder!.relationshipCount).toBe(2); // Has customerId and productId foreignKeys

      const testCustomer = dashboardData.find((d) => d.name === 'TestCustomer');
      expect(testCustomer).toBeDefined();
      expect(testCustomer!.fieldCount).toBe(2);
      expect(testCustomer!.hasAPI).toBe(true);
      expect(testCustomer!.hasCLI).toBe(true);
      expect(testCustomer!.relationshipCount).toBe(0);
    });

    it('should be useful for schema documentation generation', () => {
      // Register TestCategory
      const categoryFields = new Map();
      categoryFields.set('name', new Field('text', { required: true }));
      categoryFields.set('description', new Field('text', {}));
      registerTestClass(TestCategory, categoryFields);

      // Register TestProduct
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
      registerTestClass(TestProduct, productFields);

      const allMetadata = ObjectRegistry.getAllObjectMetadata();

      // Generate schema documentation
      const schemaDoc = allMetadata.map((meta) => ({
        name: meta.name,
        table: meta.schema?.tableName,
        fields: Array.from(meta.fields.entries()).map(([name, field]) => ({
          name,
          type: field.type,
          required: field.options?.required || false,
        })),
        relationships: meta.relationships.map((rel) => ({
          field: rel.fieldName,
          target: rel.targetClass,
          type: rel.type,
        })),
      }));

      expect(schemaDoc.length).toBe(2);

      // Check TestProduct schema
      const productDoc = schemaDoc.find((doc) => doc.name === 'TestProduct');
      expect(productDoc).toBeDefined();
      expect(productDoc!.table).toBe('test_products');
      expect(productDoc!.fields).toContainEqual({
        name: 'name',
        type: 'text',
        required: true,
      });
      expect(productDoc!.fields).toContainEqual({
        name: 'price',
        type: 'decimal',
        required: false,
      });
      expect(productDoc!.relationships).toContainEqual({
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

      registerTestClass(TestProduct, productFields);

      // Get via convenience method
      const metadata = ObjectRegistry.getObjectMetadata('TestProduct');

      // Get via direct queries
      const config = ObjectRegistry.getConfig('TestProduct');
      const fields = ObjectRegistry.getFields('TestProduct');
      const schema = ObjectRegistry.getSchema('TestProduct');
      const validators = ObjectRegistry.getValidators('TestProduct');
      const relationships = ObjectRegistry.getRelationships('TestProduct');

      // Compare
      expect(metadata!.config).toEqual(config);
      expect(metadata!.fields.size).toBe(fields.size);
      expect(metadata!.schema).toEqual(schema);
      expect(metadata!.validators).toEqual(validators);
      expect(metadata!.relationships).toEqual(relationships);
    });

    it('should return field map copies to prevent mutations', () => {
      const fields = new Map();
      fields.set('name', new Field('text', { required: true, maxLength: 100 }));
      fields.set('price', new Field('decimal', { min: 0 }));
      fields.set(
        'categoryId',
        new Field('foreignKey', { related: 'TestCategory' }),
      );

      registerTestClass(TestProduct, fields);

      const metadata = ObjectRegistry.getObjectMetadata('TestProduct');
      const originalSize = metadata!.fields.size;

      // Attempt to mutate
      metadata!.fields.set('newField', { type: 'text' });

      // Get fresh metadata
      const freshMetadata = ObjectRegistry.getObjectMetadata('TestProduct');

      expect(freshMetadata!.fields.size).toBe(originalSize);
      expect(freshMetadata!.fields.has('newField')).toBe(false);
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

      // Register TestProduct
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
      registerTestClass(TestProduct, productFields);

      // Register TestOrder
      const orderFields = new Map();
      orderFields.set(
        'customerId',
        new Field('foreignKey', { related: 'TestCustomer' }),
      );
      orderFields.set(
        'productId',
        new Field('foreignKey', { related: 'TestProduct' }),
      );
      orderFields.set('total', new Field('decimal', { min: 0 }));
      registerTestClass(TestOrder, orderFields);

      const graph = ObjectRegistry.getDependencyGraph();

      expect(graph.get('TestOrder')).toContain('TestCustomer');
      expect(graph.get('TestOrder')).toContain('TestProduct');
      expect(graph.get('TestProduct')).toContain('TestCategory');
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

      // Register TestProduct
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
      registerTestClass(TestProduct, productFields);

      // Register TestOrder
      const orderFields = new Map();
      orderFields.set(
        'customerId',
        new Field('foreignKey', { related: 'TestCustomer' }),
      );
      orderFields.set(
        'productId',
        new Field('foreignKey', { related: 'TestProduct' }),
      );
      orderFields.set('total', new Field('decimal', { min: 0 }));
      registerTestClass(TestOrder, orderFields);

      const order = ObjectRegistry.getInitializationOrder();

      // TestCategory and TestCustomer have no dependencies (can be in any order)
      // TestProduct depends on TestCategory
      // TestOrder depends on TestCustomer and TestProduct

      const categoryIndex = order.indexOf('TestCategory');
      const customerIndex = order.indexOf('TestCustomer');
      const productIndex = order.indexOf('TestProduct');
      const orderIndex = order.indexOf('TestOrder');

      expect(categoryIndex).toBeLessThan(productIndex);
      expect(productIndex).toBeLessThan(orderIndex);
      expect(customerIndex).toBeLessThan(orderIndex);
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
      expect(metadata!.schema!.tableName).toBe('table_name_tests');
    });

    it('should respect custom tableName in config', () => {
      @smrt({ tableName: 'my_custom_products' })
      class CustomTableProduct extends SmrtObject {
        name: string = '';
        price: number = 0;
      }

      const metadata = ObjectRegistry.getObjectMetadata('CustomTableProduct');
      expect(metadata!.schema!.tableName).toBe('my_custom_products');

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
});
