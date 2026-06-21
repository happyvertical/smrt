/**
 * In-process unit tests for the mcp-advisor server module (index.ts).
 *
 * The module's `main()` only runs when it is the process entrypoint (guarded by
 * isEntrypoint()), so importing it here is side-effect free — no stdio server is
 * started. We test the exported `TOOLS` surface and the `handleToolCall` routing
 * switch directly. The end-to-end stdio transport is covered separately by
 * index.spec.ts.
 */

import { describe, expect, it } from 'vitest';
// Importing a fixture registers a real @smrt() class so registry-backed routes
// return data instead of throwing.
import { AdvisorRichProduct } from '../__tests__/fixtures/advisor-test-classes.js';
import { handleToolCall, TOOLS } from './index.js';

void AdvisorRichProduct;

describe('mcp-advisor index: TOOLS surface', () => {
  it('declares every advisor tool with a name, description and input schema', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual([
      'generate-smrt-class',
      'add-ai-methods',
      'generate-field-definitions',
      'generate-collection',
      'configure-decorators',
      'validate-smrt-object',
      'preview-api-endpoints',
      'preview-mcp-tools',
      'list-registered-objects',
      'get-object-schema',
      'get-object-config',
    ]);

    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeTypeOf('object');
    }
  });
});

describe('mcp-advisor index: handleToolCall routing', () => {
  it('routes generate-smrt-class', async () => {
    const result = await handleToolCall('generate-smrt-class', {
      className: 'Widget',
      properties: [{ name: 'name', type: 'text' }],
    });
    expect(result.success).toBe(true);
    expect(result.data).toContain('export class Widget extends SmrtObject');
  });

  it('routes add-ai-methods', async () => {
    const result = await handleToolCall('add-ai-methods', {
      className: 'Widget',
      methods: ['is'],
    });
    expect(result.success).toBe(true);
    expect(result.data).toContain('async is(');
  });

  it('routes generate-field-definitions', async () => {
    const result = await handleToolCall('generate-field-definitions', {
      fields: [{ name: 'title', type: 'text' }],
    });
    expect(result.success).toBe(true);
    expect(result.data).toContain("title: string = '';");
  });

  it('routes generate-collection', async () => {
    const result = await handleToolCall('generate-collection', {
      collectionName: 'WidgetCollection',
      itemClassName: 'Widget',
      itemClassPath: './widget.js',
    });
    expect(result.success).toBe(true);
    expect(result.data).toContain('static readonly _itemClass = Widget;');
  });

  it('routes configure-decorators', async () => {
    const result = await handleToolCall('configure-decorators', {
      className: 'Widget',
      cli: true,
    });
    expect(result.success).toBe(true);
    expect(result.data).toContain('cli: true');
  });

  it('routes validate-smrt-object (read failure path)', async () => {
    const result = await handleToolCall('validate-smrt-object', {
      filePath: '/no/such/advisor/file.ts',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('routes preview-api-endpoints', async () => {
    const result = await handleToolCall('preview-api-endpoints', {
      className: 'AdvisorRichProduct',
    });
    expect(result.basePath).toBe('/api/v1');
    expect(result.endpoints.length).toBeGreaterThan(0);
  });

  it('routes preview-mcp-tools', async () => {
    const result = await handleToolCall('preview-mcp-tools', {
      className: 'AdvisorRichProduct',
    });
    expect(result.className).toBe('AdvisorRichProduct');
    expect(Array.isArray(result.tools)).toBe(true);
  });

  it('routes list-registered-objects', async () => {
    const result = await handleToolCall('list-registered-objects', {});
    expect(Array.isArray(result.objects)).toBe(true);
    expect(result.total).toBe(result.objects.length);
  });

  it('routes get-object-schema', async () => {
    const result = await handleToolCall('get-object-schema', {
      className: 'AdvisorRichProduct',
    });
    expect(result.className).toBe('AdvisorRichProduct');
    expect(result.fields.length).toBe(3);
  });

  it('routes get-object-config', async () => {
    const result = await handleToolCall('get-object-config', {
      className: 'AdvisorRichProduct',
    });
    expect(result.className).toBe('AdvisorRichProduct');
    expect(result.decorator.cli).toBe(true);
  });

  it('throws for an unknown tool name', async () => {
    await expect(handleToolCall('no-such-tool', {})).rejects.toThrow(
      'Unknown tool: no-such-tool',
    );
  });
});
