/**
 * AI Function Calling Tools Module
 *
 * Public API for AI tool generation and execution
 */

export {
  convertTypeToJsonSchema,
  shouldIncludeMethod,
  generateToolFromMethod,
  generateToolManifest,
  type AiConfig,
} from './tool-generator';

export {
  validateToolCall,
  executeToolCall,
  executeToolCalls,
  formatToolResults,
  type ToolCall,
  type ToolCallResult,
} from './tool-executor';
