/**
 * Tests for the mcp-advisor add-ai-methods tool.
 *
 * Pure generator: returns a `ToolResponse` whose `data` is the source for the
 * requested AI methods (is/do/tool). We assert each generated method body and
 * the error path for unknown / empty method lists.
 */

import { describe, expect, it } from 'vitest';
import { addAiMethods } from './add-ai-methods.js';

describe('mcp-advisor: addAiMethods', () => {
  it('generates the is() method', async () => {
    const result = await addAiMethods({
      className: 'Product',
      methods: ['is'],
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
    const code = result.data as string;
    expect(code).toContain(
      'async is(criteria: string, options?: any): Promise<boolean> {',
    );
    expect(code).toContain('if (!this.ai) {');
    expect(code).toContain("return response.toLowerCase().includes('true');");
  });

  it('generates the do() method', async () => {
    const result = await addAiMethods({
      className: 'Product',
      methods: ['do'],
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain(
      'async do(instructions: string, options?: any): Promise<string> {',
    );
    expect(code).toContain(
      'const response = await this.ai.message(prompt, options);',
    );
  });

  it('generates the tool/analyze method embedding the class name', async () => {
    const result = await addAiMethods({
      className: 'Invoice',
      methods: ['tool'],
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain(
      "async analyze(options: { depth?: 'shallow' | 'deep' } = {}):",
    );
    // The generated prompt interpolates the class name into the analyze body.
    expect(code).toContain('Analyze this Invoice with ');
    expect(code).toContain("action: 'analyze',");
  });

  it('generates and concatenates multiple methods', async () => {
    const result = await addAiMethods({
      className: 'Product',
      methods: ['is', 'do', 'tool'],
    });

    expect(result.success).toBe(true);
    const code = result.data as string;
    expect(code).toContain('async is(');
    expect(code).toContain('async do(');
    expect(code).toContain('async analyze(');
    // Methods are joined with a blank-line separator
    expect(code.split('async ').length).toBe(4);
  });

  it('returns an error for an empty method list', async () => {
    const result = await addAiMethods({ className: 'Product', methods: [] });

    expect(result.success).toBe(false);
    expect(result.error).toBe('At least one method is required');
  });

  it('returns an error for an unknown method type', async () => {
    const result = await addAiMethods({
      className: 'Product',
      // Deliberately invalid input to exercise the default-case error branch.
      methods: ['frobnicate' as unknown as 'is'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown method type: frobnicate');
  });
});
