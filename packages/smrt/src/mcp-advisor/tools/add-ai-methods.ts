/**
 * Add AI-powered methods (is, do, tool) to existing SMRT class
 */

import type { AddAiMethodsInput, ToolResponse } from '../types.js';

/**
 * Generate AI method implementations
 */
export async function addAiMethods(
  input: AddAiMethodsInput,
): Promise<ToolResponse> {
  try {
    const { className, methods } = input;

    if (!methods || methods.length === 0) {
      throw new Error('At least one method is required');
    }

    const methodImplementations: string[] = [];

    for (const method of methods) {
      switch (method) {
        case 'is':
          methodImplementations.push(generateIsMethod());
          break;
        case 'do':
          methodImplementations.push(generateDoMethod());
          break;
        case 'tool':
          methodImplementations.push(generateToolMethod(className));
          break;
        default:
          throw new Error(`Unknown method type: ${method}`);
      }
    }

    const code = methodImplementations.join('\n\n');

    return {
      success: true,
      data: code,
      warnings: [],
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown error adding AI methods',
    };
  }
}

/**
 * Generate is() method implementation
 */
function generateIsMethod(): string {
  return `  /**
   * AI-powered validation against criteria
   *
   * @param criteria - Natural language criteria to validate against
   * @param options - Additional options for AI validation
   * @returns Boolean indicating whether object meets criteria
   */
  async is(criteria: string, options?: any): Promise<boolean> {
    if (!this.ai) {
      throw new Error('AI client not configured');
    }

    const context = JSON.stringify(this, null, 2);
    const prompt = \`Given this object:
\${context}

Does it meet the following criteria?
\${criteria}

Respond with only "true" or "false".\`;

    const response = await this.ai.message(prompt, {
      ...options,
      maxTokens: 10,
    });

    return response.toLowerCase().includes('true');
  }`;
}

/**
 * Generate do() method implementation
 */
function generateDoMethod(): string {
  return `  /**
   * AI-powered operation based on instructions
   *
   * @param instructions - Natural language instructions for the operation
   * @param options - Additional options for AI operation
   * @returns Result of the operation as string
   */
  async do(instructions: string, options?: any): Promise<string> {
    if (!this.ai) {
      throw new Error('AI client not configured');
    }

    const context = JSON.stringify(this, null, 2);
    const prompt = \`Given this object:
\${context}

Perform the following operation:
\${instructions}

Provide the result.\`;

    const response = await this.ai.message(prompt, options);

    return response;
  }`;
}

/**
 * Generate custom tool method implementation
 */
function generateToolMethod(className: string): string {
  return `  /**
   * Custom tool method for AI function calling
   *
   * @param options - Tool options
   * @returns Tool execution result
   */
  async analyze(options: { depth?: 'shallow' | 'deep' } = {}): Promise<{
    action: string;
    results: any;
    timestamp: Date;
  }> {
    if (!this.ai) {
      throw new Error('AI client not configured');
    }

    const depth = options.depth || 'shallow';
    const context = JSON.stringify(this, null, 2);

    const prompt = \`Analyze this ${className} with \${depth} depth:
\${context}

Provide a structured analysis.\`;

    const results = await this.ai.message(prompt);

    return {
      action: 'analyze',
      results,
      timestamp: new Date(),
    };
  }`;
}
