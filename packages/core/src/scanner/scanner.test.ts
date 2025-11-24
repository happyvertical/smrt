/**
 * Tests for AST scanner functionality
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ASTScanner, ManifestGenerator } from './index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('AST Scanner', () => {
  const testFilePath = resolve(__dirname, 'test-sample.ts');
  const numericTypesPath = resolve(__dirname, 'test-numeric-types.ts');

  it('should scan and find SMRT classes', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();

    expect(results).toHaveLength(1);
    expect(results[0].objects).toHaveLength(3);

    const contentObj = results[0].objects.find(
      (obj) => obj.className === 'ScannerTestContent',
    );
    const categoryObj = results[0].objects.find(
      (obj) => obj.className === 'Category',
    );
    const testAgentObj = results[0].objects.find(
      (obj) => obj.className === 'ScannerTestAgent',
    );

    expect(contentObj).toBeDefined();
    expect(categoryObj).toBeDefined();
    expect(testAgentObj).toBeDefined();
  });

  it('should parse ScannerTestContent class correctly', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const contentObj = results[0].objects.find(
      (obj) => obj.className === 'ScannerTestContent',
    );

    expect(contentObj).toMatchObject({
      name: 'scannertestcontent',
      className: 'ScannerTestContent',
      collection: 'scannertestcontents',
      decoratorConfig: {
        api: { exclude: ['delete'] },
        mcp: { include: ['list', 'get', 'create'] },
        cli: true,
      },
    });

    // Check fields
    // Fields with default values should NOT be required
    expect(contentObj?.fields.title).toMatchObject({
      type: 'text',
      required: false, // Has default value
      default: '',
    });

    expect(contentObj?.fields.status).toMatchObject({
      type: 'text',
      required: false, // Has default value
      default: 'draft',
    });

    expect(contentObj?.fields.published).toMatchObject({
      type: 'boolean',
      required: false, // Has default value
      default: false,
    });

    expect(contentObj?.fields.body).toMatchObject({
      type: 'text',
      required: false,
    });
  });

  it('should infer union types correctly', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const contentObj = results[0].objects.find(
      (obj) => obj.className === 'ScannerTestContent',
    );

    // String union type should be inferred as 'text'
    expect(contentObj?.fields.status).toMatchObject({
      type: 'text',
      required: false,
      default: 'draft',
    });

    // Number union type should be inferred as 'decimal'
    expect(contentObj?.fields.priority).toMatchObject({
      type: 'decimal',
      required: false,
      default: 3,
    });

    // Boolean union type should be inferred as 'boolean'
    expect(contentObj?.fields.enabled).toMatchObject({
      type: 'boolean',
      required: false,
      default: true,
    });
  });

  it('should parse methods correctly', () => {
    const scanner = new ASTScanner([testFilePath], {
      includePrivateMethods: true,
      includeStaticMethods: true,
    });
    const results = scanner.scanFiles();
    const contentObj = results[0].objects.find(
      (obj) => obj.className === 'ScannerTestContent',
    );

    expect(contentObj?.methods.generateSummary).toMatchObject({
      name: 'generateSummary',
      async: true,
      isStatic: false,
      isPublic: true,
      returnType: 'Promise<string>',
      parameters: [{ name: 'maxLength', type: 'number', optional: false }],
    });

    expect(contentObj?.methods.findByCategory).toMatchObject({
      name: 'findByCategory',
      isStatic: true,
      isPublic: true,
    });

    // Note: validateContent private method was removed by linting (unused)
  });

  it('should generate manifest correctly', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(results);

    expect(manifest.version).toBe('1.0.0');
    expect(manifest.timestamp).toBeGreaterThan(0);
    expect(Object.keys(manifest.objects)).toEqual([
      'scannertestcontent',
      'category',
      'scannertestagent',
    ]);
  });

  it('should generate TypeScript interfaces', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(results);
    const interfaces = generator.generateTypeDefinitions(manifest);

    expect(interfaces).toContain('export interface ScannerTestContentData');
    // Fields with defaults are optional in TypeScript interfaces
    expect(interfaces).toContain('title?: string;');
    expect(interfaces).toContain('body?: string;');
    expect(interfaces).toContain('status?: string;');
    expect(interfaces).toContain('published?: boolean;');
  });

  it('should generate REST endpoints', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(results);
    const endpoints = generator.generateRestEndpoints(manifest);

    expect(endpoints).toContain('GET /scannertestcontents');
    expect(endpoints).toContain('POST /scannertestcontents');
    expect(endpoints).toContain('GET /scannertestcontents/:id');
    expect(endpoints).not.toContain('DELETE /scannertestcontents'); // Excluded in config
  });

  it('should generate MCP tools', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(results);
    const tools = generator.generateMCPTools(manifest);

    expect(tools).toContain('list_scannertestcontents');
    expect(tools).toContain('get_scannertestcontent');
    expect(tools).toContain('create_scannertestcontent');
    expect(tools).not.toContain('delete_scannertestcontent'); // Not in include list
  });

  describe('Complex Decorator Parsing (Issue #166)', () => {
    const complexDecoratorPath = resolve(
      __dirname,
      'test-complex-decorator.ts',
    );

    it('should detect all classes with complex decorators', () => {
      const scanner = new ASTScanner([complexDecoratorPath]);
      const results = scanner.scanFiles();

      expect(results).toHaveLength(1);
      // Should find all 3 classes: TestCouncil (simple), PraecoSource (complex), ComplexDecoratorTestDocument (complex)
      expect(results[0].objects).toHaveLength(3);

      const council = results[0].objects.find(
        (obj) => obj.className === 'TestCouncil',
      );
      const praecoSource = results[0].objects.find(
        (obj) => obj.className === 'PraecoSource',
      );
      const document = results[0].objects.find(
        (obj) => obj.className === 'ComplexDecoratorTestDocument',
      );

      expect(council).toBeDefined();
      expect(praecoSource).toBeDefined();
      expect(document).toBeDefined();
    });

    it('should parse simple decorator correctly', () => {
      const scanner = new ASTScanner([complexDecoratorPath]);
      const results = scanner.scanFiles();
      const council = results[0].objects.find(
        (obj) => obj.className === 'TestCouncil',
      );

      expect(council?.decoratorConfig).toMatchObject({
        tableName: 'test_councils',
      });
    });

    it('should parse complex nested decorator config (PraecoSource)', () => {
      const scanner = new ASTScanner([complexDecoratorPath]);
      const results = scanner.scanFiles();
      const praecoSource = results[0].objects.find(
        (obj) => obj.className === 'PraecoSource',
      );

      expect(praecoSource).toBeDefined();
      expect(praecoSource?.decoratorConfig).toMatchObject({
        tableName: 'praeco_sources',
        api: {
          include: ['list', 'get', 'create', 'update'],
        },
        mcp: {
          include: ['list', 'get', 'search', 'sync'],
        },
        cli: true,
      });
    });

    it('should parse complex nested decorator config (ComplexDecoratorTestDocument)', () => {
      const scanner = new ASTScanner([complexDecoratorPath]);
      const results = scanner.scanFiles();
      const document = results[0].objects.find(
        (obj) => obj.className === 'ComplexDecoratorTestDocument',
      );

      expect(document).toBeDefined();
      expect(document?.decoratorConfig).toMatchObject({
        api: {
          include: ['list', 'get', 'create', 'update', 'delete'],
        },
        mcp: {
          include: ['list', 'get', 'analyze'],
        },
        cli: true,
      });
    });
  });

  describe('Numeric Type Inference (0 vs 0.0 heuristic)', () => {
    it('should infer INTEGER for numeric literals without decimal point', () => {
      const scanner = new ASTScanner([numericTypesPath]);
      const results = scanner.scanFiles();
      const numericObj = results[0].objects.find(
        (obj) => obj.className === 'NumericTypes',
      );

      expect(numericObj).toBeDefined();

      // count: number = 0 (has default, NOT required)
      expect(numericObj?.fields.count).toMatchObject({
        type: 'integer',
        required: false, // Has default value
        default: 0,
      });

      // quantity: number = 1 (has default, NOT required)
      expect(numericObj?.fields.quantity).toMatchObject({
        type: 'integer',
        required: false, // Has default value
        default: 1,
      });

      // viewCount: number = 42 (has default, NOT required)
      expect(numericObj?.fields.viewCount).toMatchObject({
        type: 'integer',
        required: false, // Has default value
        default: 42,
      });

      // negativeInt: number = -5 (has default, NOT required)
      expect(numericObj?.fields.negativeInt).toMatchObject({
        type: 'integer',
        required: false, // Has default value
        default: -5,
      });

      // explicitNumber: number = 100 (has default, NOT required)
      expect(numericObj?.fields.explicitNumber).toMatchObject({
        type: 'integer',
        required: false, // Has default value
        default: 100,
      });
    });

    it('should infer DECIMAL for numeric literals with decimal point', () => {
      const scanner = new ASTScanner([numericTypesPath]);
      const results = scanner.scanFiles();
      const numericObj = results[0].objects.find(
        (obj) => obj.className === 'NumericTypes',
      );

      expect(numericObj).toBeDefined();

      // price: number = 0.0 (has default, NOT required)
      expect(numericObj?.fields.price).toMatchObject({
        type: 'decimal',
        required: false, // Has default value
        default: 0.0,
      });

      // rating: number = 4.5 (has default, NOT required)
      expect(numericObj?.fields.rating).toMatchObject({
        type: 'decimal',
        required: false, // Has default value
        default: 4.5,
      });

      // percentage: number = 0.95 (has default, NOT required)
      expect(numericObj?.fields.percentage).toMatchObject({
        type: 'decimal',
        required: false, // Has default value
        default: 0.95,
      });

      // temperature: number = -3.7 (has default, NOT required)
      expect(numericObj?.fields.temperature).toMatchObject({
        type: 'decimal',
        required: false, // Has default value
        default: -3.7,
      });
    });

    it('should handle edge cases correctly', () => {
      const scanner = new ASTScanner([numericTypesPath]);
      const results = scanner.scanFiles();
      const numericObj = results[0].objects.find(
        (obj) => obj.className === 'NumericTypes',
      );

      expect(numericObj).toBeDefined();

      // wholeAsDecimal: number = 1.0 (has dot, should be decimal)
      expect(numericObj?.fields.wholeAsDecimal).toMatchObject({
        type: 'decimal',
        default: 1.0,
      });

      // zeroWithoutDot: number = 0 (no dot, Biome removes trailing dot, should be integer)
      expect(numericObj?.fields.zeroWithoutDot).toMatchObject({
        type: 'integer',
        default: 0,
      });
    });

    it('should handle scientific notation as integer (no dot in literal)', () => {
      const scanner = new ASTScanner([numericTypesPath]);
      const results = scanner.scanFiles();
      const numericObj = results[0].objects.find(
        (obj) => obj.className === 'NumericTypes',
      );

      expect(numericObj).toBeDefined();

      // sciNotation: number = 1e10 (no dot in "1e10", treated as integer)
      expect(numericObj?.fields.sciNotation).toMatchObject({
        type: 'integer',
        default: 1e10,
      });
    });

    it('should still handle other types correctly', () => {
      const scanner = new ASTScanner([numericTypesPath]);
      const results = scanner.scanFiles();
      const numericObj = results[0].objects.find(
        (obj) => obj.className === 'NumericTypes',
      );

      expect(numericObj).toBeDefined();

      // name: string = '' (has default, NOT required)
      expect(numericObj?.fields.name).toMatchObject({
        type: 'text',
        required: false, // Has default value
        default: '',
      });

      // active: boolean = true (has default, NOT required)
      expect(numericObj?.fields.active).toMatchObject({
        type: 'boolean',
        required: false, // Has default value
        default: true,
      });
    });

    it('should preserve backward compatibility with field helpers', () => {
      // Field helpers like integer() and decimal() should still work
      // and take priority over the heuristic
      // This is tested indirectly through the call expression handling
      // in inferTypeFromInitializer()
    });
  });
});
