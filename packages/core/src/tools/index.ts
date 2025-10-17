/**
 * AI Function Calling Tools Module
 *
 * Public API for AI tool generation and execution
 */

export {
  executeToolCall,
  executeToolCalls,
  formatToolResults,
  type ToolCall,
  type ToolCallResult,
  validateToolCall,
} from './tool-executor';
export {
  type AiConfig,
  convertTypeToJsonSchema,
  generateToolFromMethod,
  generateToolManifest,
  shouldIncludeMethod,
} from './tool-generator';
