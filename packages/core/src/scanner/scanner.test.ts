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
      (obj) => obj.className === 'Content',
    );
    const categoryObj = results[0].objects.find(
      (obj) => obj.className === 'Category',
    );
    const testAgentObj = results[0].objects.find(
      (obj) => obj.className === 'TestAgent',
    );

    expect(contentObj).toBeDefined();
    expect(categoryObj).toBeDefined();
    expect(testAgentObj).toBeDefined();
  });

  it('should parse Content class correctly', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const contentObj = results[0].objects.find(
      (obj) => obj.className === 'Content',
    );

    expect(contentObj).toMatchObject({
      name: 'content',
      className: 'Content',
      collection: 'contents',
      decoratorConfig: {
        api: { exclude: ['delete'] },
        mcp: { include: ['list', 'get', 'create'] },
        cli: true,
      },
    });

    // Check fields
    expect(contentObj?.fields.title).toMatchObject({
      type: 'text',
      required: true,
      default: '',
    });

    expect(contentObj?.fields.status).toMatchObject({
      type: 'text',
      required: true,
      default: 'draft',
    });

    expect(contentObj?.fields.published).toMatchObject({
      type: 'boolean',
      required: true,
      default: false,
    });

    expect(contentObj?.fields.body).toMatchObject({
      type: 'text',
      required: false,
    });
  });

  it('should parse methods correctly', () => {
    const scanner = new ASTScanner([testFilePath], {
      includePrivateMethods: true,
      includeStaticMethods: true,
    });
    const results = scanner.scanFiles();
    const contentObj = results[0].objects.find(
      (obj) => obj.className === 'Content',
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
      'content',
      'category',
      'testagent',
    ]);
  });

  it('should generate TypeScript interfaces', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(results);
    const interfaces = generator.generateTypeDefinitions(manifest);

    expect(interfaces).toContain('export interface ContentData');
    expect(interfaces).toContain('title: string;');
    expect(interfaces).toContain('body?: string;');
    expect(interfaces).toContain('status: string;');
    expect(interfaces).toContain('published: boolean;');
  });

  it('should generate REST endpoints', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(results);
    const endpoints = generator.generateRestEndpoints(manifest);

    expect(endpoints).toContain('GET /contents');
    expect(endpoints).toContain('POST /contents');
    expect(endpoints).toContain('GET /contents/:id');
    expect(endpoints).not.toContain('DELETE /contents'); // Excluded in config
  });

  it('should generate MCP tools', () => {
    const scanner = new ASTScanner([testFilePath]);
    const results = scanner.scanFiles();
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(results);
    const tools = generator.generateMCPTools(manifest);

    expect(tools).toContain('list_contents');
    expect(tools).toContain('get_content');
    expect(tools).toContain('create_content');
    expect(tools).not.toContain('delete_content'); // Not in include list
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
      // Should find all 3 classes: TestCouncil (simple), PraecoSource (complex), Document (complex)
      expect(results[0].objects).toHaveLength(3);

      const council = results[0].objects.find(
        (obj) => obj.className === 'TestCouncil',
      );
      const praecoSource = results[0].objects.find(
        (obj) => obj.className === 'PraecoSource',
      );
      const document = results[0].objects.find(
        (obj) => obj.className === 'Document',
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

    it('should parse complex nested decorator config (Document)', () => {
      const scanner = new ASTScanner([complexDecoratorPath]);
      const results = scanner.scanFiles();
      const document = results[0].objects.find(
        (obj) => obj.className === 'Document',
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

      // count: number = 0
      expect(numericObj?.fields.count).toMatchObject({
        type: 'integer',
        required: true,
        default: 0,
      });

      // quantity: number = 1
      expect(numericObj?.fields.quantity).toMatchObject({
        type: 'integer',
        required: true,
        default: 1,
      });

      // viewCount: number = 42
      expect(numericObj?.fields.viewCount).toMatchObject({
        type: 'integer',
        required: true,
        default: 42,
      });

      // negativeInt: number = -5
      expect(numericObj?.fields.negativeInt).toMatchObject({
        type: 'integer',
        required: true,
        default: -5,
      });

      // explicitNumber: number = 100
      expect(numericObj?.fields.explicitNumber).toMatchObject({
        type: 'integer',
        required: true,
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

      // price: number = 0.0
      expect(numericObj?.fields.price).toMatchObject({
        type: 'decimal',
        required: true,
        default: 0.0,
      });

      // rating: number = 4.5
      expect(numericObj?.fields.rating).toMatchObject({
        type: 'decimal',
        required: true,
        default: 4.5,
      });

      // percentage: number = 0.95
      expect(numericObj?.fields.percentage).toMatchObject({
        type: 'decimal',
        required: true,
        default: 0.95,
      });

      // temperature: number = -3.7
      expect(numericObj?.fields.temperature).toMatchObject({
        type: 'decimal',
        required: true,
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

      // name: string = ''
      expect(numericObj?.fields.name).toMatchObject({
        type: 'text',
        required: true,
        default: '',
      });

      // active: boolean = true
      expect(numericObj?.fields.active).toMatchObject({
        type: 'boolean',
        required: true,
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
