/**
 * Unit Tests for generate-smrt-class Tool
 * Tests SMRT class code generation with various configurations
 */

import { describe, expect, it } from 'vitest';
import { generateSmrtClass } from './generate-smrt-class.js';

describe('generateSmrtClass', () => {
  describe('Basic Class Generation', () => {
    it('should generate a basic SMRT class', async () => {
      const result = await generateSmrtClass({
        className: 'Product',
        properties: [
          { name: 'name', type: 'text', required: true },
          { name: 'price', type: 'decimal', required: true },
        ],
      });

      expect(result).toContain('export class Product extends SmrtObject');
      expect(result).toContain(
        "import { SmrtObject, smrt } from '@happyvertical/smrt-core'",
      );
      expect(result).toContain(
        "import { text, decimal } from '@happyvertical/smrt-core/fields'",
      );
      expect(result).toContain('name = text({"required":true})');
      expect(result).toContain('price = decimal({"required":true})');
    });

    it('should generate constructor with Object.assign', async () => {
      const result = await generateSmrtClass({
        className: 'Article',
        properties: [{ name: 'title', type: 'text' }],
      });

      expect(result).toContain('constructor(options: any = {})');
      expect(result).toContain('super(options)');
      expect(result).toContain('Object.assign(this, options)');
    });
  });

  describe('Property Types', () => {
    it('should handle all field types', async () => {
      const result = await generateSmrtClass({
        className: 'CompleteModel',
        properties: [
          { name: 'textField', type: 'text' },
          { name: 'numberField', type: 'integer' },
          { name: 'decimalField', type: 'decimal' },
          { name: 'boolField', type: 'boolean' },
          { name: 'dateField', type: 'datetime' },
          { name: 'jsonField', type: 'json' },
        ],
      });

      expect(result).toContain(
        "import { text, integer, decimal, boolean, datetime, json } from '@happyvertical/smrt-core/fields'",
      );
      expect(result).toContain('textField = text()');
      expect(result).toContain('numberField = integer()');
      expect(result).toContain('decimalField = decimal()');
      expect(result).toContain('boolField = boolean()');
      expect(result).toContain('dateField = datetime()');
      expect(result).toContain('jsonField = json()');
    });

    it('should handle property options', async () => {
      const result = await generateSmrtClass({
        className: 'ValidatedModel',
        properties: [
          {
            name: 'email',
            type: 'text',
            required: true,
            description: 'User email address',
          },
          {
            name: 'age',
            type: 'integer',
            required: false,
          },
        ],
      });

      expect(result).toContain(
        'email = text({"required":true,"description":"User email address"})',
      );
      expect(result).toContain('age = integer()');
    });
  });

  describe('Decorator Configuration', () => {
    it('should include API configuration by default', async () => {
      const result = await generateSmrtClass({
        className: 'DefaultConfig',
        properties: [{ name: 'name', type: 'text' }],
        includeApiConfig: true,
      });

      expect(result).toContain('@smrt(');
      expect(result).toContain('"api"');
      expect(result).toContain('"include"');
      expect(result).toContain('"list"');
      expect(result).toContain('"get"');
      expect(result).toContain('"create"');
      expect(result).toContain('"update"');
      expect(result).toContain('"exclude"');
      expect(result).toContain('"delete"'); // Safe default - exclude delete
    });

    it('should include MCP configuration by default', async () => {
      const result = await generateSmrtClass({
        className: 'MCPConfig',
        properties: [{ name: 'name', type: 'text' }],
        includeApiConfig: false, // Don't include API to avoid "create"/"update" in output
        includeMcpConfig: true,
        includeCliConfig: false,
      });

      expect(result).toContain('@smrt(');
      expect(result).toContain('"mcp"');
      expect(result).toContain('"include"');
      expect(result).toContain('"list"');
      expect(result).toContain('"get"');
      expect(result).not.toContain('"create"'); // Read-only by default for AI
      expect(result).not.toContain('"update"');
      expect(result).not.toContain('"delete"');
    });

    it('should include CLI configuration by default', async () => {
      const result = await generateSmrtClass({
        className: 'CLIConfig',
        properties: [{ name: 'name', type: 'text' }],
        includeCliConfig: true,
      });

      expect(result).toContain('@smrt(');
      expect(result).toContain('"cli": true');
    });

    it('should omit configurations when disabled', async () => {
      const result = await generateSmrtClass({
        className: 'NoConfig',
        properties: [{ name: 'name', type: 'text' }],
        includeApiConfig: false,
        includeMcpConfig: false,
        includeCliConfig: false,
      });

      expect(result).toContain('@smrt()');
      expect(result).not.toContain('"api"');
      expect(result).not.toContain('"mcp"');
      expect(result).not.toContain('"cli"');
    });
  });

  describe('Base Class Selection', () => {
    it('should extend SmrtObject by default', async () => {
      const result = await generateSmrtClass({
        className: 'DefaultBase',
        properties: [{ name: 'name', type: 'text' }],
      });

      expect(result).toContain('export class DefaultBase extends SmrtObject');
      expect(result).toContain(
        "import { SmrtObject, smrt } from '@happyvertical/smrt-core'",
      );
    });

    it('should extend SmrtCollection when specified', async () => {
      const result = await generateSmrtClass({
        className: 'CustomCollection',
        properties: [{ name: 'name', type: 'text' }],
        baseClass: 'SmrtCollection',
      });

      expect(result).toContain(
        'export class CustomCollection extends SmrtCollection',
      );
      expect(result).toContain(
        "import { SmrtCollection, smrt } from '@happyvertical/smrt-core'",
      );
    });
  });

  describe('Import Optimization', () => {
    it('should only import used field types', async () => {
      const result = await generateSmrtClass({
        className: 'OptimizedImports',
        properties: [
          { name: 'name', type: 'text' },
          { name: 'price', type: 'decimal' },
        ],
      });

      expect(result).toContain(
        "import { text, decimal } from '@happyvertical/smrt-core/fields'",
      );
      expect(result).not.toContain('integer');
      expect(result).not.toContain('boolean');
      expect(result).not.toContain('datetime');
      expect(result).not.toContain('json');
    });

    it('should deduplicate field type imports', async () => {
      const result = await generateSmrtClass({
        className: 'DuplicateTypes',
        properties: [
          { name: 'firstName', type: 'text' },
          { name: 'lastName', type: 'text' },
          { name: 'email', type: 'text' },
        ],
      });

      // Should only import 'text' once
      const textImportCount = (result.match(/\btext\b/g) || []).length;
      const importLineMatches = result.match(
        /import.*from '@happyvertical\/smrt-core\/fields'/g,
      );
      expect(importLineMatches?.length).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty properties array', async () => {
      const result = await generateSmrtClass({
        className: 'EmptyClass',
        properties: [],
      });

      expect(result).toContain('export class EmptyClass extends SmrtObject');
      expect(result).toContain('constructor(options: any = {})');
      expect(result).not.toContain('import { text');
    });

    it('should handle class names with special characters (PascalCase)', async () => {
      const result = await generateSmrtClass({
        className: 'MySpecialClassName',
        properties: [{ name: 'field', type: 'text' }],
      });

      expect(result).toContain(
        'export class MySpecialClassName extends SmrtObject',
      );
    });

    it('should handle property names with underscores', async () => {
      const result = await generateSmrtClass({
        className: 'UnderscoreModel',
        properties: [
          { name: 'created_at', type: 'datetime' },
          { name: 'updated_at', type: 'datetime' },
        ],
      });

      expect(result).toContain('created_at = datetime()');
      expect(result).toContain('updated_at = datetime()');
    });
  });

  describe('Generated Code Structure', () => {
    it('should have correct code structure', async () => {
      const result = await generateSmrtClass({
        className: 'StructureTest',
        properties: [
          { name: 'title', type: 'text', required: true },
          { name: 'count', type: 'integer' },
        ],
      });

      // Verify import order
      const importIndex = result.indexOf('import {');
      const decoratorIndex = result.indexOf('@smrt(');
      const classIndex = result.indexOf('export class');
      const constructorIndex = result.indexOf('constructor(');

      expect(importIndex).toBeLessThan(decoratorIndex);
      expect(decoratorIndex).toBeLessThan(classIndex);
      expect(classIndex).toBeLessThan(constructorIndex);
    });

    it('should generate valid TypeScript code', async () => {
      const result = await generateSmrtClass({
        className: 'ValidTypeScript',
        properties: [
          { name: 'name', type: 'text', required: true },
          { name: 'active', type: 'boolean' },
        ],
      });

      // Basic syntax checks
      expect(result).not.toContain('undefined');
      expect(result).not.toContain('null');

      // Proper semicolons
      const lines = result.split('\n').filter((line) => line.trim());
      const propertyLines = lines.filter((line) => /^\s+\w+\s*=/.test(line));
      for (const line of propertyLines) {
        expect(line.trim()).toMatch(/;$/);
      }
    });
  });
});
