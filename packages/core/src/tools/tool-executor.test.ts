/**
 * Tests for tool call execution
 */

import { describe, expect, it } from 'vitest';
import {
  executeToolCall,
  executeToolCalls,
  formatToolResults,
  type ToolCall,
  validateToolCall,
} from './tool-executor';

describe('validateToolCall', () => {
  const allowedMethods = ['analyze', 'summarize', 'validate'];

  it('validates allowed methods', () => {
    expect(() => {
      validateToolCall('analyze', { type: 'detailed' }, allowedMethods);
    }).not.toThrow();
  });

  it('throws error for disallowed methods', () => {
    expect(() => {
      validateToolCall('delete', {}, allowedMethods);
    }).toThrow('Method must be one of: analyze, summarize, validate');
  });

  it('throws error for invalid arguments', () => {
    expect(() => {
      validateToolCall('analyze', null as any, allowedMethods);
    }).toThrow('Arguments must be a valid object');
  });
});

describe('executeToolCall', () => {
  it('executes method successfully', async () => {
    const instance = {
      analyze: async (args: any) => {
        return { result: `Analyzed with ${args.type}` };
      },
    };

    const toolCall: ToolCall = {
      id: 'call_123',
      type: 'function',
      function: {
        name: 'analyze',
        arguments: '{"type": "detailed"}',
      },
    };

    const result = await executeToolCall(instance, toolCall, ['analyze']);

    expect(result).toMatchObject({
      id: 'call_123',
      methodName: 'analyze',
      arguments: { type: 'detailed' },
      result: { result: 'Analyzed with detailed' },
      success: true,
    });
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('handles invalid JSON arguments', async () => {
    const instance = {
      analyze: async () => 'result',
    };

    const toolCall: ToolCall = {
      id: 'call_123',
      type: 'function',
      function: {
        name: 'analyze',
        arguments: 'invalid json',
      },
    };

    const result = await executeToolCall(instance, toolCall, ['analyze']);

    expect(result).toMatchObject({
      id: 'call_123',
      methodName: 'analyze',
      success: false,
      error: expect.stringContaining('valid JSON'),
    });
  });

  it('handles method not found', async () => {
    const instance = {};

    const toolCall: ToolCall = {
      id: 'call_123',
      type: 'function',
      function: {
        name: 'analyze',
        arguments: '{}',
      },
    };

    const result = await executeToolCall(instance, toolCall, ['analyze']);

    expect(result).toMatchObject({
      id: 'call_123',
      methodName: 'analyze',
      success: false,
      error: expect.stringContaining('not found'),
    });
  });

  it('handles method execution errors', async () => {
    const instance = {
      analyze: async () => {
        throw new Error('Analysis failed');
      },
    };

    const toolCall: ToolCall = {
      id: 'call_123',
      type: 'function',
      function: {
        name: 'analyze',
        arguments: '{}',
      },
    };

    const result = await executeToolCall(instance, toolCall, ['analyze']);

    expect(result).toMatchObject({
      id: 'call_123',
      methodName: 'analyze',
      success: false,
      error: 'Analysis failed',
    });
  });

  it('handles disallowed methods', async () => {
    const instance = {
      analyze: async () => 'result',
    };

    const toolCall: ToolCall = {
      id: 'call_123',
      type: 'function',
      function: {
        name: 'analyze',
        arguments: '{}',
      },
    };

    const result = await executeToolCall(instance, toolCall, ['summarize']);

    expect(result).toMatchObject({
      id: 'call_123',
      methodName: 'analyze',
      success: false,
      error: expect.stringContaining('Method must be one of'),
    });
  });
});

describe('executeToolCalls', () => {
  it('executes multiple tool calls sequentially', async () => {
    const instance = {
      analyze: async (args: any) => `Analyzed ${args.text}`,
      summarize: async (args: any) => `Summary of ${args.text}`,
    };

    const toolCalls: ToolCall[] = [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'analyze',
          arguments: '{"text": "content"}',
        },
      },
      {
        id: 'call_2',
        type: 'function',
        function: {
          name: 'summarize',
          arguments: '{"text": "content"}',
        },
      },
    ];

    const results = await executeToolCalls(instance, toolCalls, [
      'analyze',
      'summarize',
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      id: 'call_1',
      success: true,
      result: 'Analyzed content',
    });
    expect(results[1]).toMatchObject({
      id: 'call_2',
      success: true,
      result: 'Summary of content',
    });
  });

  it('continues execution after errors', async () => {
    const instance = {
      analyze: async () => {
        throw new Error('Failed');
      },
      summarize: async () => 'Success',
    };

    const toolCalls: ToolCall[] = [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'analyze',
          arguments: '{}',
        },
      },
      {
        id: 'call_2',
        type: 'function',
        function: {
          name: 'summarize',
          arguments: '{}',
        },
      },
    ];

    const results = await executeToolCalls(instance, toolCalls, [
      'analyze',
      'summarize',
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
  });
});

describe('formatToolResults', () => {
  it('formats successful results', () => {
    const results = [
      {
        id: 'call_1',
        methodName: 'analyze',
        arguments: {},
        result: { findings: 'positive' },
        success: true,
        duration: 100,
      },
    ];

    const formatted = formatToolResults(results);

    expect(formatted).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"findings":"positive"}',
      },
    ]);
  });

  it('formats error results', () => {
    const results = [
      {
        id: 'call_1',
        methodName: 'analyze',
        arguments: {},
        result: null,
        success: false,
        error: 'Method failed',
        duration: 50,
      },
    ];

    const formatted = formatToolResults(results);

    expect(formatted).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'Error: Method failed',
      },
    ]);
  });

  it('formats multiple results', () => {
    const results = [
      {
        id: 'call_1',
        methodName: 'analyze',
        arguments: {},
        result: 'success',
        success: true,
        duration: 100,
      },
      {
        id: 'call_2',
        methodName: 'summarize',
        arguments: {},
        result: null,
        success: false,
        error: 'Failed',
        duration: 50,
      },
    ];

    const formatted = formatToolResults(results);

    expect(formatted).toHaveLength(2);
    expect(formatted[0].content).toBe('"success"');
    expect(formatted[1].content).toBe('Error: Failed');
  });
});
