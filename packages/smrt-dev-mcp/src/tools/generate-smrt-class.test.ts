/**
 * Unit Tests for generate-smrt-class Tool
 * Tests SMRT class code generation with decorators and TypeScript types
 */

import { describe, expect, it } from 'vitest';
import { generateSmrtClass } from './generate-smrt-class.js';

describe('generateSmrtClass', () => {
  describe('Basic Class Generation', () => {
    it('should generate a basic SMRT class with TypeScript types', async () => {
      const result = await generateSmrtClass({
        className: 'Product',
        properties: [
          { name: 'name', type: 'text', required: true },
          { name: 'price', type: 'decimal', required: true },
        ],
      });

      expect(result).toContain('export class Product extends SmrtObject');
      expect(result).toContain(
        "import { SmrtObject, smrt, field } from '@happyvertical/smrt-core'",
      );
      expect(result).toContain('name: string = ');
      expect(result).toContain('price: number = 0.0');
      expect(result).toContain('@field({"required":true})');
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
    it('should handle all field types with TypeScript syntax', async () => {
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

      expect(result).toContain('textField: string = ');
      expect(result).toContain('numberField: number = 0');
      expect(result).toContain('decimalField: number = 0.0');
      expect(result).toContain('boolField: boolean = false');
      expect(result).toContain('dateField: Date = new Date()');
      expect(result).toContain('jsonField: any = {}');
    });

    it('should handle property options with @field decorator', async () => {
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

      expect(result).toContain('/** User email address */');
      expect(result).toContain(
        '@field({"required":true,"description":"User email address"})',
      );
      expect(result).toContain('email: string = ');
      expect(result).toContain('age: number = 0');
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

  describe('Current Package Patterns', () => {
    it('should generate tenant-scoped package-ready objects', async () => {
      const result = await generateSmrtClass({
        className: 'ProjectTask',
        template: 'tenant-project-object',
        tableName: 'project_tasks',
        conflictColumns: ['tenant_id', 'slug'],
        properties: [
          { name: 'title', type: 'text', required: true },
          { name: 'priority', type: 'integer' },
        ],
      });

      expect(result).toContain(
        "import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy'",
      );
      expect(result).toContain('@TenantScoped(');
      expect(result).toContain('"mode": "required"');
      expect(result).toContain('@tenantId()');
      expect(result).toContain("tenantId: string = ''");
      expect(result).toContain('"tableName": "project_tasks"');
      expect(result).toContain('"conflictColumns"');
      expect(result).toContain('"tenant_id"');
    });

    it('should generate same-package and cross-package relationships', async () => {
      const result = await generateSmrtClass({
        className: 'Order',
        properties: [{ name: 'orderNumber', type: 'text', required: true }],
        relationships: [
          {
            name: 'customerId',
            type: 'foreignKey',
            related: 'Customer',
            required: true,
          },
          {
            name: 'profileId',
            type: 'crossPackageRef',
            related: '@happyvertical/smrt-profiles:Profile',
            nullable: true,
          },
        ],
      });

      expect(result).toContain('field, foreignKey, crossPackageRef');
      expect(result).toContain('@foreignKey("Customer", {"required":true})');
      expect(result).toContain("customerId: string = ''");
      expect(result).toContain(
        '@crossPackageRef("@happyvertical/smrt-profiles:Profile", {"nullable":true})',
      );
      expect(result).toContain('profileId: string | null = null');
    });

    it('should include a tenant id field by default for tenant-scoped generation', async () => {
      const result = await generateSmrtClass({
        className: 'TenantNote',
        tenantScoped: true,
        properties: [{ name: 'body', type: 'text' }],
      });

      expect(result).toContain(
        "import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy'",
      );
      expect(result).toContain('@tenantId()');
      expect(result).toContain("tenantId: string = ''");
    });

    it('should avoid unused tenantId imports when the tenant field is explicitly disabled', async () => {
      const result = await generateSmrtClass({
        className: 'TenantView',
        tenantScoped: true,
        includeTenantIdField: false,
        properties: [{ name: 'name', type: 'text' }],
      });

      expect(result).toContain(
        "import { TenantScoped } from '@happyvertical/smrt-tenancy'",
      );
      expect(result).not.toContain('tenantId }');
      expect(result).not.toContain('@tenantId()');
    });

    it('should include companion snippets when requested', async () => {
      const result = await generateSmrtClass({
        className: 'CatalogEntry',
        template: 'global-catalog',
        properties: [{ name: 'name', type: 'text' }],
        includeCompanionSnippets: true,
      });

      expect(result).toContain('Package wiring:');
      expect(result).toContain('Export CatalogEntry');
      expect(result).toContain('"slug"');
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
    it('should only import @field decorator when needed', async () => {
      const result = await generateSmrtClass({
        className: 'NoConstraints',
        properties: [
          { name: 'name', type: 'text' },
          { name: 'price', type: 'decimal' },
        ],
      });

      expect(result).not.toContain('import { field }');
    });

    it('should import @field decorator when constraints exist', async () => {
      const result = await generateSmrtClass({
        className: 'WithConstraints',
        properties: [
          { name: 'name', type: 'text', required: true },
          { name: 'price', type: 'decimal' },
        ],
      });

      expect(result).toContain(
        "import { SmrtObject, smrt, field } from '@happyvertical/smrt-core'",
      );
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
      expect(result).not.toContain('import { field }');
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

      expect(result).toContain('created_at: Date = new Date()');
      expect(result).toContain('updated_at: Date = new Date()');
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

      // Should have TypeScript type annotations
      expect(result).toContain('name: string');
      expect(result).toContain('active: boolean');
    });
  });

  describe('JSDoc Comments', () => {
    it('should add JSDoc comments for descriptions', async () => {
      const result = await generateSmrtClass({
        className: 'DocumentedClass',
        properties: [
          { name: 'name', type: 'text', description: 'The name of the object' },
          { name: 'count', type: 'integer', description: 'Item count' },
        ],
      });

      expect(result).toContain('/** The name of the object */');
      expect(result).toContain('/** Item count */');
    });

    it('should omit JSDoc when no description', async () => {
      const result = await generateSmrtClass({
        className: 'NoDescription',
        properties: [{ name: 'name', type: 'text' }],
      });

      expect(result).not.toContain('/**');
      expect(result).not.toContain('*/');
    });
  });
});
