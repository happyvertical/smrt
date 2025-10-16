/**
 * Tests for MCP generator with custom action support
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MCPGenerator } from './mcp';
import { ObjectRegistry } from '../registry';
import { SmrtObject } from '../object';

// Mock decorator function for testing
function smrt(config?: any) {
  return (target: any) => {
    ObjectRegistry.register(target, config);
    return target;
  };
}

// Test class with custom actions
@smrt({
  mcp: {
    include: ['list', 'get', 'research', 'report', 'analyze'],
  },
})
class TestAgent extends SmrtObject {
  name = '';
  source = '';

  constructor(options: any) {
    super(options);
    // Avoid overwriting getter-only properties
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }

  // Custom action methods
  async research(options: any = {}): Promise<any> {
    return {
      action: 'research',
      source: this.source,
      results: options.query
        ? `Research results for: ${options.query}`
        : 'General research complete',
      timestamp: new Date(),
    };
  }

  async report(options: any = {}): Promise<any> {
    return {
      action: 'report',
      type: options.type || 'summary',
      content: `Generated ${options.type || 'summary'} report for ${this.name}`,
      timestamp: new Date(),
    };
  }

  async analyze(options: any = {}): Promise<any> {
    return {
      action: 'analyze',
      analysis: `Analysis of ${this.name}: ${options.criteria || 'general analysis'}`,
      confidence: 0.85,
      timestamp: new Date(),
    };
  }
}

// Test class with invalid custom action (method doesn't exist)
@smrt({
  mcp: {
    include: ['list', 'get', 'nonexistent'],
  },
})
class InvalidActionAgent extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    // Avoid overwriting getter-only properties
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }
}

// Test class with excluded custom actions
@smrt({
  mcp: {
    include: ['list', 'get', 'research', 'report'],
    exclude: ['report'], // Exclude report even though it's included
  },
})
class ExcludedActionAgent extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    // Avoid overwriting getter-only properties
    const { db, ai, fs, ...safeOptions } = options;
    Object.assign(this, safeOptions);
  }

  async research(): Promise<any> {
    return { action: 'research' };
  }

  async report(): Promise<any> {
    return { action: 'report' };
  }
}

describe('MCPGenerator with Custom Actions', () => {
  let generator: MCPGenerator;

  beforeEach(() => {
    generator = new MCPGenerator();
  });

  afterEach(() => {
    // Note: Don't clear registry as classes are only registered once during import
    // ObjectRegistry.clear();
  });

  describe('Tool Generation', () => {
    it('should generate tools for custom actions', () => {
      const tools = generator.generateTools();

      // Find tools for our test agent
      const agentTools = tools.filter((tool) =>
        tool.name.startsWith('testagent_'),
      );

      // Should have standard CRUD tools plus custom actions
      const toolNames = agentTools.map((tool) => tool.name);
      expect(toolNames).toContain('testagent_list');
      expect(toolNames).toContain('testagent_get');
      expect(toolNames).toContain('testagent_research');
      expect(toolNames).toContain('testagent_report');
      expect(toolNames).toContain('testagent_analyze');
    });

    it('should have correct schema for custom action tools', () => {
      const tools = generator.generateTools();
      const researchTool = tools.find(
        (tool) => tool.name === 'testagent_research',
      );

      expect(researchTool).toBeDefined();
      expect(researchTool?.description).toBe(
        'Execute research action on TestAgent',
      );
      expect(researchTool?.inputSchema.type).toBe('object');
      expect(researchTool?.inputSchema.properties.id).toBeDefined();
      expect(researchTool?.inputSchema.properties.options).toBeDefined();
    });

    it('should warn about invalid custom actions', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      generator.generateTools();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Custom action 'nonexistent' specified in MCP config for InvalidActionAgent, but method nonexistent() not found on class",
        ),
      );

      consoleSpy.mockRestore();
    });

    it('should respect exclude configuration for custom actions', () => {
      const tools = generator.generateTools();
      const excludedAgentTools = tools.filter((tool) =>
        tool.name.startsWith('excludedactionagent_'),
      );

      const toolNames = excludedAgentTools.map((tool) => tool.name);
      expect(toolNames).toContain('excludedactionagent_research');
      expect(toolNames).not.toContain('excludedactionagent_report'); // Should be excluded
    });
  });

  describe('Custom Action Execution', () => {
    it('should execute custom actions on object instances', async () => {
      // Mock collection and object
      const mockObject = new TestAgent({
        db: null,
        ai: null,
        fs: null,
        id: 'test-id',
        name: 'Test Agent',
        source: 'test-source',
      });

      const mockCollection = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      // Test the private executeCustomAction method via handleToolCall
      const request = {
        method: 'tools/call',
        params: {
          name: 'testagent_research',
          arguments: {
            id: 'test-id',
            options: { query: 'test query' },
          },
        },
      };

      // Mock the getCollection method to return our mock collection
      const originalGetCollection = (generator as any).getCollection;
      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue(mockCollection);
      (generator as any).collections = new Map([['TestAgent', mockCollection]]);

      const response = await generator.handleToolCall(request);

      expect(response.content[0].type).toBe('text');
      const result = JSON.parse(response.content[0].text);
      expect(result.action).toBe('research');
      expect(result.results).toBe('Research results for: test query');

      // Restore original method
      (generator as any).getCollection = originalGetCollection;
    });

    it('should handle custom actions without ID (collection-level)', async () => {
      // Mock collection with custom method
      const mockCollection = {
        research: vi
          .fn()
          .mockResolvedValue({ action: 'research', level: 'collection' }),
      };

      const request = {
        method: 'tools/call',
        params: {
          name: 'testagent_research',
          arguments: {
            options: { query: 'collection query' },
          },
        },
      };

      // Mock the getCollection method
      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue(mockCollection);
      (generator as any).collections = new Map([['TestAgent', mockCollection]]);

      const response = await generator.handleToolCall(request);

      expect(response.content[0].type).toBe('text');
      const result = JSON.parse(response.content[0].text);
      expect(result.action).toBe('research');
      expect(result.level).toBe('collection');
    });

    it('should handle errors in custom action execution', async () => {
      const mockObject = new TestAgent({
        db: null,
        ai: null,
        fs: null,
        id: 'test-id',
        name: 'Test Agent',
      });

      // Override the research method to throw an error
      mockObject.research = vi
        .fn()
        .mockRejectedValue(new Error('Research failed'));

      const mockCollection = {
        get: vi.fn().mockResolvedValue(mockObject),
      };

      const request = {
        method: 'tools/call',
        params: {
          name: 'testagent_research',
          arguments: {
            id: 'test-id',
          },
        },
      };

      (generator as any).getCollection = vi
        .fn()
        .mockReturnValue(mockCollection);
      (generator as any).collections = new Map([['TestAgent', mockCollection]]);

      const response = await generator.handleToolCall(request);

      expect(response.content[0].type).toBe('text');
      expect(response.content[0].text).toContain(
        'Failed to execute custom action',
      );
      expect(response.content[0].text).toContain('Research failed');
    });
  });
});
