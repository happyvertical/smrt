/**
 * @have/ai - A standardized interface for AI model interactions
 *
 * This package provides a unified interface for interacting with various AI models.
 * Supports multiple providers: OpenAI, Gemini, Anthropic, Hugging Face, and AWS Bedrock.
 *
 * Key components:
 * - getAI() - Factory function for creating AI provider instances
 * - AIInterface - Standardized interface for all AI providers
 * - Provider-specific implementations for each supported service
 */

// Legacy exports for backward compatibility
export * from './shared/client';
export * from './shared/factory';
export { AIMessage as AIMessageClass } from './shared/message';
export * from './shared/thread';
export * from './shared/types';
