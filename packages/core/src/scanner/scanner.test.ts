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

    expect(contentObj?.methods.validateContent).toMatchObject({
      name: 'validateContent',
      isStatic: false,
      isPublic: false,
    });
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
});
