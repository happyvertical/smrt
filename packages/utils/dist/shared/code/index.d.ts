/**
 * Code utilities for extraction, validation, and safe execution
 *
 * Provides tools for working with generated code (e.g., from AI responses):
 * - Extract code blocks from markdown and text
 * - Validate code for security and syntax
 * - Execute code safely in isolated sandboxes
 *
 * @module code
 */
export { extractCodeBlock, extractJSON, extractAllCodeBlocks, extractFunctionDefinition, } from './extraction';
export { createSandbox, executeCode, executeCodeAsync, executeInSandbox, executeInSandboxAsync, type SandboxOptions, type ExecuteOptions, } from './sandbox';
export { validateCode, isSafeCode, type ValidationOptions, type ValidationResult, } from './validation';
//# sourceMappingURL=index.d.ts.map