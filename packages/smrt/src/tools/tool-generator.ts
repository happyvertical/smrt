/**
 * Tool Manifest Generation for AI Function Calling
 *
 * This module converts TypeScript method definitions from the AST scanner
 * into AI tool format at build time for use with LLM function calling.
 */

import type { MethodDefinition } from '../scanner/types';
import type { AITool } from '@have/ai';

/**
 * Configuration for AI-callable methods
 */
export interface AiConfig {
  /**
   * Methods that AI can call
   * - Array of method names, e.g., ['analyze', 'validate']
   * - 'public-async' to auto-include all public async methods
   * - 'all' to include all methods (not recommended)
   */
  callable?: string[] | 'public-async' | 'all';

  /**
   * Methods to exclude from AI calling (higher priority than callable)
   */
  exclude?: string[];

  /**
   * Additional tool descriptions to override method JSDoc
   */
  descriptions?: Record<string, string>;
}

/**
 * Converts a TypeScript type string to JSON Schema format
 *
 * @param tsType - TypeScript type string (e.g., 'string', 'number', '{ foo: string }')
 * @returns JSON Schema representation
 */
export function convertTypeToJsonSchema(tsType: string): Record<string, any> {
  // Remove whitespace
  const cleanType = tsType.trim();

  // Primitive types
  if (cleanType === 'string') {
    return { type: 'string' };
  }
  if (cleanType === 'number') {
    return { type: 'number' };
  }
  if (cleanType === 'boolean') {
    return { type: 'boolean' };
  }
  if (cleanType === 'null') {
    return { type: 'null' };
  }
  if (cleanType === 'any' || cleanType === 'unknown') {
    return {}; // No type constraint
  }

  // Array types
  if (cleanType.endsWith('[]')) {
    const itemType = cleanType.slice(0, -2);
    return {
      type: 'array',
      items: convertTypeToJsonSchema(itemType),
    };
  }

  // Array<T> syntax
  const arrayMatch = cleanType.match(/^Array<(.+)>$/);
  if (arrayMatch) {
    return {
      type: 'array',
      items: convertTypeToJsonSchema(arrayMatch[1]),
    };
  }

  // Union types with literal values (e.g., 'shallow' | 'deep')
  if (cleanType.includes('|')) {
    const options = cleanType.split('|').map((s) => s.trim());

    // Check if all options are string literals
    if (options.every((opt) => opt.startsWith("'") && opt.endsWith("'"))) {
      return {
        type: 'string',
        enum: options.map((opt) => opt.slice(1, -1)), // Remove quotes
      };
    }

    // Mixed union - use oneOf
    return {
      oneOf: options.map(convertTypeToJsonSchema),
    };
  }

  // Object types - basic support
  if (cleanType.startsWith('{') && cleanType.endsWith('}')) {
    return { type: 'object' };
  }

  // Record<string, any> and similar
  if (cleanType.startsWith('Record<')) {
    return { type: 'object' };
  }

  // Default fallback
  return { type: 'string', description: `TypeScript type: ${cleanType}` };
}

/**
 * Determines if a method should be included as an AI-callable tool
 *
 * @param method - Method definition from AST scanner
 * @param config - AI configuration from @smrt decorator
 * @returns True if method should be callable by AI
 */
export function shouldIncludeMethod(
  method: MethodDefinition,
  config?: AiConfig,
): boolean {
  // Skip if no AI config
  if (!config || !config.callable) {
    return false;
  }

  // Check exclusions first (higher priority)
  if (config.exclude?.includes(method.name)) {
    return false;
  }

  // Skip private methods always
  if (!method.isPublic) {
    return false;
  }

  // Skip static methods (tools operate on instances)
  if (method.isStatic) {
    return false;
  }

  // Handle 'all' mode
  if (config.callable === 'all') {
    return true;
  }

  // Handle 'public-async' mode
  if (config.callable === 'public-async') {
    return method.async;
  }

  // Handle explicit array of method names
  if (Array.isArray(config.callable)) {
    return config.callable.includes(method.name);
  }

  return false;
}

/**
 * Generates an AITool definition from a method definition
 *
 * @param method - Method definition from AST scanner
 * @param config - AI configuration for custom descriptions
 * @returns AITool definition for LLM function calling
 */
export function generateToolFromMethod(
  method: MethodDefinition,
  config?: AiConfig,
): AITool {
  // Build parameters JSON Schema
  const parameters: Record<string, any> = {
    type: 'object',
    properties: {},
    required: [],
  };

  for (const param of method.parameters) {
    // Convert parameter type to JSON Schema
    parameters.properties[param.name] = convertTypeToJsonSchema(param.type);

    // Add to required if not optional
    if (!param.optional) {
      parameters.required.push(param.name);
    }

    // Add default value if present
    if (param.default !== undefined) {
      parameters.properties[param.name].default = param.default;
    }
  }

  // Remove empty required array
  if (parameters.required.length === 0) {
    delete parameters.required;
  }

  // Get description (custom override or from JSDoc)
  const description =
    config?.descriptions?.[method.name] ||
    method.description ||
    `Call the ${method.name} method`;

  return {
    type: 'function',
    function: {
      name: method.name,
      description,
      parameters,
    },
  };
}

/**
 * Generates tool manifest from method definitions
 *
 * @param methods - Array of method definitions from AST scanner
 * @param config - AI configuration from @smrt decorator
 * @returns Array of AITool definitions for LLM function calling
 */
export function generateToolManifest(
  methods: MethodDefinition[],
  config?: AiConfig,
): AITool[] {
  const tools: AITool[] = [];

  for (const method of methods) {
    if (shouldIncludeMethod(method, config)) {
      const tool = generateToolFromMethod(method, config);
      tools.push(tool);
    }
  }

  return tools;
}
