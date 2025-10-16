import { MethodDefinition } from '../scanner/types';
import { AITool } from '../../../ai/src';
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
export declare function convertTypeToJsonSchema(tsType: string): Record<string, any>;
/**
 * Determines if a method should be included as an AI-callable tool
 *
 * @param method - Method definition from AST scanner
 * @param config - AI configuration from @smrt decorator
 * @returns True if method should be callable by AI
 */
export declare function shouldIncludeMethod(method: MethodDefinition, config?: AiConfig): boolean;
/**
 * Generates an AITool definition from a method definition
 *
 * @param method - Method definition from AST scanner
 * @param config - AI configuration for custom descriptions
 * @returns AITool definition for LLM function calling
 */
export declare function generateToolFromMethod(method: MethodDefinition, config?: AiConfig): AITool;
/**
 * Generates tool manifest from method definitions
 *
 * @param methods - Array of method definitions from AST scanner
 * @param config - AI configuration from @smrt decorator
 * @returns Array of AITool definitions for LLM function calling
 */
export declare function generateToolManifest(methods: MethodDefinition[], config?: AiConfig): AITool[];
//# sourceMappingURL=tool-generator.d.ts.map