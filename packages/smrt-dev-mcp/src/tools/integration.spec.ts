/**
 * Integration Tests for SMRT Dev MCP Tools
 * Tests code generation and introspection with real projects
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSmrtClass } from './generate-smrt-class.js';
import { introspectProject } from './introspect-project.js';

describe('SMRT Dev MCP Tools - Integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `smrt-dev-integration-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('Generate → Introspect Workflow', () => {
    it('should generate class and then introspect it', async () => {
      // Step 1: Generate SMRT class
      const generatedCode = await generateSmrtClass({
        className: 'Product',
        properties: [
          { name: 'name', type: 'text', required: true },
          { name: 'price', type: 'decimal', required: true },
          { name: 'stock', type: 'integer' },
        ],
        baseClass: 'SmrtObject',
        includeApiConfig: true,
        includeMcpConfig: true,
        includeCliConfig: true,
      });

      // Step 2: Write generated code to file
      await writeFile(join(tmpDir, 'product.ts'), generatedCode);

      // Step 3: Introspect the project
      const introspectionResult = await introspectProject({
        directory: tmpDir,
        includeFields: true,
        includeRelationships: true,
      });

      const parsed = JSON.parse(introspectionResult);

      // Step 4: Verify introspection found the generated class
      expect(parsed.objectCount).toBe(1);
      expect(parsed.objects[0].className).toBe('Product');
      expect(parsed.objects[0].filePath).toContain('product.ts');
      expect(parsed.objects[0].fields).toContain('name: text');
      expect(parsed.objects[0].fields).toContain('price: decimal');
      expect(parsed.objects[0].fields).toContain('stock: integer');
    });

    it('should generate multiple classes and introspect all', async () => {
      // Generate Product class
      const productCode = await generateSmrtClass({
        className: 'Product',
        properties: [
          { name: 'name', type: 'text' },
          { name: 'price', type: 'decimal' },
        ],
      });
      await writeFile(join(tmpDir, 'product.ts'), productCode);

      // Generate Category class
      const categoryCode = await generateSmrtClass({
        className: 'Category',
        properties: [
          { name: 'name', type: 'text' },
          { name: 'description', type: 'text' },
        ],
      });
      await writeFile(join(tmpDir, 'category.ts'), categoryCode);

      // Introspect
      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(2);

      const classNames = parsed.objects.map((obj: any) => obj.className);
      expect(classNames).toContain('Product');
      expect(classNames).toContain('Category');
    });
  });

  describe('Real Project Scenarios', () => {
    it('should handle complex project structure', async () => {
      // Create nested structure
      await mkdir(join(tmpDir, 'models'), { recursive: true });
      await mkdir(join(tmpDir, 'models', 'products'), { recursive: true });
      await mkdir(join(tmpDir, 'models', 'users'), { recursive: true });

      // Generate Product in models/products/
      const productCode = await generateSmrtClass({
        className: 'Product',
        properties: [
          { name: 'name', type: 'text', required: true },
          { name: 'price', type: 'decimal' },
        ],
      });
      await writeFile(
        join(tmpDir, 'models', 'products', 'product.ts'),
        productCode,
      );

      // Generate User in models/users/
      const userCode = await generateSmrtClass({
        className: 'User',
        properties: [
          { name: 'username', type: 'text', required: true },
          { name: 'email', type: 'text', required: true },
        ],
      });
      await writeFile(join(tmpDir, 'models', 'users', 'user.ts'), userCode);

      // Introspect
      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(2);
      expect(
        parsed.objects.some((obj: any) =>
          obj.filePath.includes('models/products/product.ts'),
        ),
      ).toBe(true);
      expect(
        parsed.objects.some((obj: any) =>
          obj.filePath.includes('models/users/user.ts'),
        ),
      ).toBe(true);
    });

    it('should generate classes with relationships', async () => {
      // Generate Order class with foreign key
      const orderCode = await generateSmrtClass({
        className: 'Order',
        properties: [
          { name: 'orderNumber', type: 'text', required: true },
          { name: 'total', type: 'decimal' },
        ],
      });

      // Manually add foreign key (generator doesn't support this yet)
      const orderCodeWithFK = orderCode.replace(
        'total = decimal();',
        'total = decimal();\n  customerId = foreignKey(Customer);',
      );

      // Add import for foreignKey
      const finalOrderCode = orderCodeWithFK.replace(
        "import { text, decimal } from '@happyvertical/smrt-core/fields'",
        "import { text, decimal, foreignKey } from '@happyvertical/smrt-core/fields'",
      );

      await writeFile(join(tmpDir, 'order.ts'), finalOrderCode);

      // Introspect with relationships
      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
        includeRelationships: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].relationships).toContain(
        'customerId -> Customer (foreignKey)',
      );
    });
  });

  describe('Configuration Variations', () => {
    it('should generate classes with different decorator configurations', async () => {
      // API-only configuration
      const apiOnlyCode = await generateSmrtClass({
        className: 'APIOnly',
        properties: [{ name: 'name', type: 'text' }],
        includeApiConfig: true,
        includeMcpConfig: false,
        includeCliConfig: false,
      });
      await writeFile(join(tmpDir, 'api-only.ts'), apiOnlyCode);

      // MCP-only configuration
      const mcpOnlyCode = await generateSmrtClass({
        className: 'MCPOnly',
        properties: [{ name: 'name', type: 'text' }],
        includeApiConfig: false,
        includeMcpConfig: true,
        includeCliConfig: false,
      });
      await writeFile(join(tmpDir, 'mcp-only.ts'), mcpOnlyCode);

      // Introspect
      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(2);

      // Both should have decorator config
      parsed.objects.forEach((obj: any) => {
        expect(obj.decoratorConfig).toBeDefined();
      });
    });

    it('should handle collection base class', async () => {
      const collectionCode = await generateSmrtClass({
        className: 'ProductCollection',
        properties: [],
        baseClass: 'SmrtCollection',
      });
      await writeFile(join(tmpDir, 'collection.ts'), collectionCode);

      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(1);
      expect(parsed.objects[0].className).toBe('ProductCollection');
    });
  });

  describe('Error Recovery', () => {
    it('should handle mix of valid and invalid files', async () => {
      // Generate valid class
      const validCode = await generateSmrtClass({
        className: 'ValidClass',
        properties: [{ name: 'name', type: 'text' }],
      });
      await writeFile(join(tmpDir, 'valid.ts'), validCode);

      // Create invalid TypeScript file
      await writeFile(
        join(tmpDir, 'invalid.ts'),
        'this is not valid typescript code',
      );

      // Introspect should find the valid one
      const result = await introspectProject({
        directory: tmpDir,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objectCount).toBe(1);
      expect(parsed.objects[0].className).toBe('ValidClass');
    });

    it('should handle generated code with various property types', async () => {
      const allTypesCode = await generateSmrtClass({
        className: 'AllTypes',
        properties: [
          { name: 'textField', type: 'text' },
          { name: 'intField', type: 'integer' },
          { name: 'decimalField', type: 'decimal' },
          { name: 'boolField', type: 'boolean' },
          { name: 'dateField', type: 'datetime' },
          { name: 'jsonField', type: 'json' },
        ],
      });
      await writeFile(join(tmpDir, 'all-types.ts'), allTypesCode);

      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
      });

      const parsed = JSON.parse(result);
      const fields = parsed.objects[0].fields;

      expect(fields).toContain('textField: text');
      expect(fields).toContain('intField: integer');
      expect(fields).toContain('decimalField: decimal');
      expect(fields).toContain('boolField: boolean');
      expect(fields).toContain('dateField: datetime');
      expect(fields).toContain('jsonField: json');
    });
  });

  describe('Round-Trip Code Generation', () => {
    it('should generate code that can be written and read back', async () => {
      // Original spec
      const originalSpec = {
        className: 'RoundTrip',
        properties: [
          {
            name: 'title',
            type: 'text' as const,
            required: true,
            description: 'The title',
          },
          { name: 'count', type: 'integer' as const, required: false },
          { name: 'active', type: 'boolean' as const, required: true },
        ],
        baseClass: 'SmrtObject' as const,
        includeApiConfig: true,
        includeMcpConfig: true,
        includeCliConfig: true,
      };

      // Generate
      const generatedCode = await generateSmrtClass(originalSpec);
      await writeFile(join(tmpDir, 'roundtrip.ts'), generatedCode);

      // Verify generated code is valid
      expect(generatedCode).toContain(
        'export class RoundTrip extends SmrtObject',
      );
      expect(generatedCode).toContain(
        'title = text({"required":true,"description":"The title"})',
      );
      expect(generatedCode).toContain('count = integer()');
      expect(generatedCode).toContain('active = boolean({"required":true})');

      // Read back via introspection
      const result = await introspectProject({
        directory: tmpDir,
        includeFields: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.objects[0].className).toBe('RoundTrip');
      expect(parsed.objects[0].fields).toContain('title: text');
      expect(parsed.objects[0].fields).toContain('count: integer');
      expect(parsed.objects[0].fields).toContain('active: boolean');
    });
  });

  describe('CLI Command Simulation', () => {
    it('should simulate smrt-dev-mcp generate workflow', async () => {
      // Simulate: smrt-dev-mcp generate-smrt-class Product --fields name:text,price:decimal
      const args = {
        className: 'Product',
        properties: [
          { name: 'name', type: 'text' as const, required: true },
          { name: 'price', type: 'decimal' as const, required: true },
        ],
      };

      const code = await generateSmrtClass(args);

      // Write to project
      const projectDir = join(tmpDir, 'my-project', 'src', 'models');
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, 'product.ts'), code);

      // Simulate: smrt-dev-mcp introspect-project my-project/
      const introspection = await introspectProject({
        directory: join(tmpDir, 'my-project'),
      });

      const parsed = JSON.parse(introspection);
      expect(parsed.objectCount).toBe(1);
      expect(parsed.objects[0].className).toBe('Product');
    });
  });
});
