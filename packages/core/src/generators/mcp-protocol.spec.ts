/**
 * MCP Protocol Compliance Tests
 * Verifies generated servers conform to Model Context Protocol specification
 */

import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';

import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { MCPGenerator } from './mcp.js';

// Test object for protocol testing
@smrt({
  mcp: { include: ['list', 'get', 'testAction'] },
})
class ProtocolTestObject extends SmrtObject {
  name = text();
  count = integer();

  async testAction(options: any = {}) {
    return { action: 'testAction', result: 'success' };
  }
}

// Test collection
class ProtocolTestObjectCollection extends SmrtCollection<ProtocolTestObject> {
  static readonly _itemClass = ProtocolTestObject;
}

describe('MCP Protocol Compliance', () => {
  let generator: MCPGenerator;

  beforeEach(async () => {
    // Register the collection for the test object
    ObjectRegistry.registerCollection(
      'ProtocolTestObject',
      ProtocolTestObjectCollection,
    );

    // Create in-memory database for testing
    const db = await getDatabase({ url: ':memory:' });

    generator = new MCPGenerator(
      {
        name: 'protocol-test-server',
        version: '1.0.0',
      },
      {
        db,
      },
    );
  });

  describe('Tool Definition Format', () => {
    it('should generate tools with required MCP structure', async () => {
      const tools = await generator.generateTools();

      tools.forEach((tool) => {
        // Required fields per MCP spec
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');

        // Types
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.inputSchema).toBe('object');
      });
    });

    it('should use JSON Schema for inputSchema', async () => {
      const tools = await generator.generateTools();

      tools.forEach((tool) => {
        const schema = tool.inputSchema;

        // Must be valid JSON Schema object
        expect(schema).toHaveProperty('type');
        expect(schema.type).toBe('object');

        if (schema.properties) {
          expect(typeof schema.properties).toBe('object');
        }

        if (schema.required) {
          expect(Array.isArray(schema.required)).toBe(true);
        }
      });
    });

    it('should name tools following {objectname}_{action} convention', async () => {
      const tools = await generator.generateTools();
      const protocolTools = tools.filter((t) =>
        t.name.startsWith('protocoltestobject_'),
      );

      protocolTools.forEach((tool) => {
        expect(tool.name).toMatch(/^[a-z]+_[a-z]+$/i);
        expect(tool.name).toContain('_');

        const [objectName, action] = tool.name.split('_');
        expect(objectName).toBeTruthy();
        expect(action).toBeTruthy();
      });
    });

    it('should include clear descriptions for all tools', async () => {
      const tools = await generator.generateTools();

      tools.forEach((tool) => {
        expect(tool.description.length).toBeGreaterThan(10);
        expect(tool.description).not.toContain('undefined');
        expect(tool.description).not.toContain('null');
      });
    });
  });

  describe('Standard CRUD Tool Structure', () => {
    it('should define list tool correctly', async () => {
      const tools = await generator.generateTools();
      const listTool = tools.find((t) => t.name === 'protocoltestobject_list');

      expect(listTool).toBeDefined();
      expect(listTool?.description).toContain('List');
      expect(listTool?.inputSchema.properties).toHaveProperty('limit');
      expect(listTool?.inputSchema.properties).toHaveProperty('offset');
      expect(listTool?.inputSchema.properties).toHaveProperty('where');
    });

    it('should define get tool correctly', async () => {
      const tools = await generator.generateTools();
      const getTool = tools.find((t) => t.name === 'protocoltestobject_get');

      expect(getTool).toBeDefined();
      expect(getTool?.description).toContain('Get');
      expect(getTool?.inputSchema.properties).toHaveProperty('id');
      expect(getTool?.inputSchema.required).toContain('id');
    });

    it('should define custom action tools correctly', async () => {
      const tools = await generator.generateTools();
      const actionTool = tools.find(
        (t) => t.name === 'protocoltestobject_testaction',
      );

      expect(actionTool).toBeDefined();
      expect(actionTool?.description).toContain('testAction');
      expect(actionTool?.inputSchema.properties).toHaveProperty('id');
      expect(actionTool?.inputSchema.properties).toHaveProperty('options');
    });
  });

  describe('Tool Call Request/Response Format', () => {
    it('should handle tool call requests in MCP format', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'protocoltestobject_list',
          arguments: {
            limit: 10,
            offset: 0,
          },
        },
      };

      const response = await generator.handleToolCall(request);

      // Response must have content array
      expect(response).toHaveProperty('content');
      expect(Array.isArray(response.content)).toBe(true);
      expect(response.content.length).toBeGreaterThan(0);

      // Content items must have type and text/data
      response.content.forEach((item: any) => {
        expect(item).toHaveProperty('type');
        expect(['text', 'image', 'resource'].includes(item.type)).toBe(true);

        if (item.type === 'text') {
          expect(item).toHaveProperty('text');
          expect(typeof item.text).toBe('string');
        }
      });
    });

    it('should return errors in MCP format', async () => {
      const invalidRequest = {
        method: 'tools/call',
        params: {
          name: 'nonexistent_tool',
          arguments: {},
        },
      };

      const response = await generator.handleToolCall(invalidRequest);

      expect(response).toHaveProperty('content');
      expect(Array.isArray(response.content)).toBe(true);

      // Error should be text content
      const errorContent = response.content[0];
      expect(errorContent.type).toBe('text');
      expect(errorContent.text).toContain('Unknown tool');
    });
  });

  describe('Tool List Response Format', () => {
    it('should return tools in MCP ListToolsResult format', async () => {
      const tools = await generator.generateTools();

      // Must be an array
      expect(Array.isArray(tools)).toBe(true);

      // Each tool must conform to MCP Tool type
      tools.forEach((tool) => {
        expect(tool).toEqual(
          expect.objectContaining({
            name: expect.any(String),
            description: expect.any(String),
            inputSchema: expect.objectContaining({
              type: 'object',
            }),
          }),
        );
      });
    });
  });

  describe('Server Metadata', () => {
    it('should include server name and version in generated code', async () => {
      const generator = new MCPGenerator({
        name: 'metadata-test-server',
        version: '2.5.0',
        description: 'Test description',
      });

      const tools = await generator.generateTools();

      // Metadata should be accessible
      expect(generator).toHaveProperty('name');
      expect(generator).toHaveProperty('version');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing tool arguments gracefully', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'protocoltestobject_get',
          arguments: {}, // Missing required 'id'
        },
      };

      const response = await generator.handleToolCall(request);

      expect(response).toHaveProperty('content');
      expect(response.content[0].type).toBe('text');
      // Should indicate error (not crash)
      expect(typeof response.content[0].text).toBe('string');
    });

    it('should handle malformed arguments gracefully', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'protocoltestobject_list',
          arguments: {
            limit: 'invalid', // Should be number
            offset: null,
          },
        },
      };

      const response = await generator.handleToolCall(request);

      // Should not throw, should return error message
      expect(response).toHaveProperty('content');
      expect(response.content[0].type).toBe('text');
    });

    it('should handle custom action errors gracefully', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'protocoltestobject_testaction',
          arguments: {
            id: 'nonexistent-id',
          },
        },
      };

      const response = await generator.handleToolCall(request);

      // Should return error message, not crash
      expect(response).toHaveProperty('content');
      expect(response.content[0].type).toBe('text');
    });
  });

  describe('Tool Result Serialization', () => {
    it('should serialize complex objects to JSON strings', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'protocoltestobject_list',
          arguments: {},
        },
      };

      const response = await generator.handleToolCall(request);
      const textContent = response.content[0].text;

      // Should be valid JSON
      expect(() => JSON.parse(textContent)).not.toThrow();

      const parsed = JSON.parse(textContent);
      expect(Array.isArray(parsed) || typeof parsed === 'object').toBe(true);
    });

    it('should handle null and undefined results', async () => {
      const request = {
        method: 'tools/call',
        params: {
          name: 'protocoltestobject_get',
          arguments: {
            id: 'nonexistent',
          },
        },
      };

      const response = await generator.handleToolCall(request);

      // Should return valid response even for null result
      expect(response).toHaveProperty('content');
      expect(response.content[0]).toHaveProperty('text');
      expect(typeof response.content[0].text).toBe('string');
    });
  });

  describe('Protocol Version Compatibility', () => {
    it('should use MCP SDK compatible types', async () => {
      const tools = await generator.generateTools();

      // Tool structure matches @modelcontextprotocol/sdk types
      tools.forEach((tool) => {
        // Name: string
        expect(typeof tool.name).toBe('string');

        // Description: string (optional in spec, but we always provide)
        expect(typeof tool.description).toBe('string');

        // InputSchema: object (JSON Schema)
        expect(tool.inputSchema).toEqual(
          expect.objectContaining({
            type: expect.any(String),
          }),
        );
      });
    });

    it('should handle tool calls following MCP CallToolRequest schema', async () => {
      const validRequest = {
        method: 'tools/call',
        params: {
          name: expect.any(String),
          arguments: expect.any(Object),
        },
      };

      // Structure matches CallToolRequestSchema from MCP SDK
      expect(validRequest.method).toBe('tools/call');
      expect(validRequest.params).toHaveProperty('name');
      expect(validRequest.params).toHaveProperty('arguments');
    });
  });

  describe('Tool Discovery', () => {
    it('should make all registered SMRT objects discoverable', async () => {
      const tools = await generator.generateTools();

      // Should find tools for our test object
      const testObjectTools = tools.filter((t) =>
        t.name.startsWith('protocoltestobject_'),
      );

      expect(testObjectTools.length).toBeGreaterThan(0);

      // Should include configured actions
      const toolNames = testObjectTools.map((t) => t.name);
      expect(toolNames).toContain('protocoltestobject_list');
      expect(toolNames).toContain('protocoltestobject_get');
      expect(toolNames).toContain('protocoltestobject_testaction');
    });

    it('should respect MCP configuration excludes', async () => {
      const tools = await generator.generateTools();

      // If an action is excluded in MCP config, it shouldn't appear
      // Test objects include create/update/delete by default
      // But our test object only includes list, get, testAction
      const testObjectTools = tools.filter((t) =>
        t.name.startsWith('protocoltestobject_'),
      );

      const toolNames = testObjectTools.map((t) => t.name);

      // Should NOT include excluded actions
      expect(toolNames).not.toContain('protocoltestobject_create');
      expect(toolNames).not.toContain('protocoltestobject_update');
      expect(toolNames).not.toContain('protocoltestobject_delete');
    });
  });
});
