/**
 * Tests for the mcp-advisor preview-mcp-tools tool.
 *
 * Registry-backed: delegates to the real MCPGenerator and filters its output to
 * the requested class. Covers the happy path (tools prefixed with the lowercased
 * class name) and the genuine error path for an unregistered class.
 */

import { describe, expect, it } from 'vitest';
import { AdvisorRichProduct } from '../../__tests__/fixtures/advisor-test-classes.js';
import { McpIntegrationTestProduct } from '../../__tests__/fixtures/mcp-integration-test-classes.js';
import { previewMcpTools } from './preview-mcp-tools.js';

void McpIntegrationTestProduct;
void AdvisorRichProduct;

describe('mcp-advisor: previewMcpTools', () => {
  it('returns the MCP tools generated for a registered class', async () => {
    const result = await previewMcpTools({
      className: 'McpIntegrationTestProduct',
    });

    expect(result.className).toBe('McpIntegrationTestProduct');
    expect(result.tools.length).toBeGreaterThan(0);
    // All returned tools are namespaced to the lowercased class name.
    expect(
      result.tools.every((t) =>
        t.name.startsWith('mcpintegrationtestproduct_'),
      ),
    ).toBe(true);
    // The fixture's mcp include list exposes list + get.
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('mcpintegrationtestproduct_list');
    expect(names).toContain('mcpintegrationtestproduct_get');
    // Each tool carries a JSON-schema input shape.
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeTypeOf('object');
    }
  });

  it('filters tools to the requested class only', async () => {
    const result = await previewMcpTools({ className: 'AdvisorRichProduct' });
    expect(
      result.tools.every((t) => t.name.startsWith('advisorrichproduct_')),
    ).toBe(true);
    // Should not bleed in tools from other registered classes.
    expect(
      result.tools.some((t) => t.name.startsWith('mcpintegrationtestproduct_')),
    ).toBe(false);
  });

  it('throws for an unregistered class', async () => {
    await expect(
      previewMcpTools({ className: 'NoSuchMcpClass' }),
    ).rejects.toThrow(/not found in ObjectRegistry/);
  });
});
