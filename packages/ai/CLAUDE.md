# @have/ai: AI Model Interface Package

## Purpose and Responsibilities

The `@have/ai` package provides a standardized interface for interacting with various AI models across multiple providers. It is designed to:

- **Unify AI Provider APIs**: Provide a consistent interface across OpenAI, Google Gemini, Anthropic Claude, Hugging Face, and AWS Bedrock
- **Simplify Provider Switching**: Enable seamless switching between AI providers without code changes
- **Handle Multi-Modal Interactions**: Support text, chat, embeddings, and streaming responses
- **Manage Provider Configuration**: Handle authentication, base URLs, and provider-specific options
- **Provide Error Handling**: Standardize error handling across different AI provider APIs
- **Support Modern AI Features**: Function calling, tool usage, streaming responses, and token management
- **Optimize for Performance**: Connection pooling, retry logic, and rate limiting strategies
- **Enable Cost Monitoring**: Token usage tracking and provider capability comparison

This package serves as the AI interaction layer for building intelligent agents that can work with multiple AI providers seamlessly.

**Expert Agent Expertise**: When working with this package, always proactively check the latest documentation for AI provider SDKs (OpenAI, Anthropic, Google GenAI, AWS Bedrock) as they frequently add new models, features, and API changes that can enhance AI integrations and unlock new capabilities.

## Architecture Overview

The package is structured with clear separation of concerns:

### Core Components

1. **Factory Functions** (`shared/factory.ts`)
   - `getAI()` - Primary factory for creating provider instances with explicit type
   - `getAIAuto()` - Auto-detects provider from credentials (browser-compatible)
   - Type guards for provider options validation

2. **Provider Implementations** (`shared/providers/`)
   - Each provider implements the `AIInterface` interface
   - Located in: `openai.ts`, `anthropic.ts`, `gemini.ts`, `huggingface.ts`, `bedrock.ts`
   - All providers handle error mapping to standardized error types
   - Streaming support via async generators

3. **Type Definitions** (`shared/types.ts`)
   - `AIInterface` - Core interface all providers must implement
   - `AIMessage` - Message structure for chat interactions
   - `AIResponse` - Standardized response format
   - `ChatOptions`, `CompletionOptions`, `EmbeddingOptions` - Request configuration
   - Error classes: `AIError`, `AuthenticationError`, `RateLimitError`, etc.

4. **Legacy Client** (`shared/client.ts`)
   - Older `AIClient` and `OpenAIClient` classes (maintained for backward compatibility)
   - `AIThread` for conversation management with references
   - `AIMessage` class for message objects
   - **Note**: New code should use the factory pattern (`getAI()`) instead

### Key Design Patterns

**Provider Pattern**: Each AI service has its own provider class implementing `AIInterface`
```typescript
export class OpenAIProvider implements AIInterface {
  async chat(messages: AIMessage[], options?: ChatOptions): Promise<AIResponse>
  async complete(prompt: string, options?: CompletionOptions): Promise<AIResponse>
  async embed(text: string | string[], options?: EmbeddingOptions): Promise<EmbeddingResponse>
  async *stream(messages: AIMessage[], options?: ChatOptions): AsyncIterable<string>
  async countTokens(text: string): Promise<number>
  async getModels(): Promise<AIModel[]>
  async getCapabilities(): Promise<AICapabilities>
}
```

**Factory Pattern**: Dynamic provider loading using dynamic imports
```typescript
// Lazy loads only the provider you need
const provider = await getAI({ type: 'openai', apiKey: '...' });
```

**Error Mapping**: Each provider maps native API errors to standardized types
```typescript
private mapError(error: unknown): AIError {
  // Maps provider-specific errors to AIError, RateLimitError, etc.
}
```

## Key APIs

### Creating an AI Client

```typescript
import { getAI, getAIAuto } from '@have/ai';

// Create an OpenAI client (default provider)
const client = await getAI({
  type: 'openai', // optional, defaults to openai
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: 'https://api.openai.com/v1', // optional
  defaultModel: 'gpt-4o', // optional
  timeout: 30000, // optional, 30 seconds
  maxRetries: 3 // optional
});

// Create a Gemini client
const geminiClient = await getAI({
  type: 'gemini',
  apiKey: process.env.GEMINI_API_KEY!,
  projectId: 'your-project-id', // optional
  location: 'us-central1', // optional
  defaultModel: 'gemini-1.5-pro'
});

// Create an Anthropic client
const anthropicClient = await getAI({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  defaultModel: 'claude-3-5-sonnet-20241022',
  timeout: 60000 // Longer timeout for complex requests
});

// Create a Hugging Face client
const hfClient = await getAI({
  type: 'huggingface',
  apiToken: process.env.HUGGINGFACE_TOKEN!,
  model: 'microsoft/DialoGPT-medium', // required for HF
  useCache: true, // optional, use HF model cache
  waitForModel: true // optional, wait if model is loading
});

// Create an AWS Bedrock client
const bedrockClient = await getAI({
  type: 'bedrock',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: process.env.AWS_SESSION_TOKEN // optional
  },
  defaultModel: 'anthropic.claude-3-sonnet-20240229-v1:0'
});

// Auto-detect provider from credentials
const autoClient = await getAIAuto({
  apiKey: process.env.OPENAI_API_KEY, // Will auto-detect as OpenAI
  // apiToken: process.env.HUGGINGFACE_TOKEN, // Would auto-detect as HuggingFace
  // region: 'us-east-1', credentials: {...} // Would auto-detect as Bedrock
});
```

### Chat Completions

```typescript
import { getAI, type AIMessage, type ChatOptions } from '@have/ai';

const client = await getAI({ 
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: 'gpt-4o'
});

// Basic chat completion
const response = await client.chat([
  { role: 'user', content: 'What is the capital of France?' }
]);

console.log(response.content); // "Paris is the capital of France."
console.log(response.usage); // Token usage information
console.log(response.model); // Model used for generation

// Advanced chat with options
const chatResponse = await client.chat([
  { role: 'system', content: 'You are a helpful coding assistant.' },
  { role: 'user', content: 'Generate a TypeScript function to reverse a string' }
], {
  model: "gpt-4o",
  temperature: 0.7,
  maxTokens: 500,
  stop: ['\n\n'], // Stop at double newline
  responseFormat: { type: 'text' }, // or 'json_object' for structured output
  seed: 42 // For deterministic results
});

// Function calling example
const toolResponse = await client.chat([
  { role: 'user', content: 'What is the weather like in Tokyo?' }
], {
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a location',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
            unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
          },
          required: ['location']
        }
      }
    }
  ],
  toolChoice: 'auto' // or 'none', or specific function
});

if (toolResponse.toolCalls) {
  for (const toolCall of toolResponse.toolCalls) {
    console.log(`Function called: ${toolCall.function.name}`);
    console.log(`Arguments: ${toolCall.function.arguments}`);
  }
}
```

### Text Completions

```typescript
import { getAI } from '@have/ai';

const client = await getAI({ apiKey: 'your-api-key' });

// Basic completion
const result = await client.complete("What is the capital of France?");

// Completion with options
const resultWithOptions = await client.complete("Generate a poem about coding", {
  model: "gpt-4o",
  temperature: 0.7,
  maxTokens: 500
});

console.log(resultWithOptions.content);
```

### Embeddings

```typescript
import { getAI } from '@have/ai';

const client = await getAI({ apiKey: 'your-api-key' });

// Single text embedding
const embedding = await client.embed("Hello, world!");

// Multiple text embeddings
const embeddings = await client.embed([
  "First document",
  "Second document",
  "Third document"
]);

console.log(embeddings.embeddings); // Array of number arrays
```

### Streaming Responses

```typescript
import { getAI } from '@have/ai';

const client = await getAI({ apiKey: process.env.OPENAI_API_KEY! });

// Stream chat response for real-time output
for await (const chunk of client.stream([
  { role: 'user', content: 'Generate a long story about AI agents' }
], {
  model: 'gpt-4o',
  temperature: 0.8,
  maxTokens: 1000
})) {
  process.stdout.write(chunk);
}
console.log('\n\nStreaming complete!');

// Stream with progress callback (alternative approach)
const response = await client.chat([
  { role: 'user', content: 'Explain quantum computing in detail' }
], {
  stream: true,
  onProgress: (chunk: string) => {
    process.stdout.write(chunk);
  }
});

// Handle streaming errors gracefully
try {
  const stream = client.stream([
    { role: 'user', content: 'Tell me about recent AI developments' }
  ], {
    timeout: 10000 // 10 second timeout
  });

  for await (const chunk of stream) {
    if (chunk.includes('[ERROR]')) {
      console.error('Error detected in stream');
      break;
    }
    process.stdout.write(chunk);
  }
} catch (error) {
  console.error('Streaming failed:', error);
}
```

### Model Information and Capabilities

```typescript
import { getAI } from '@have/ai';

const client = await getAI({ 
  apiKey: process.env.OPENAI_API_KEY!,
  type: 'openai'
});

// Get available models
const models = await client.getModels();
console.log(models.map(m => ({
  id: m.id,
  name: m.name,
  contextLength: m.contextLength,
  supportsFunctions: m.supportsFunctions,
  supportsVision: m.supportsVision,
  inputCostPer1k: m.inputCostPer1k,
  outputCostPer1k: m.outputCostPer1k
})));

// Get provider capabilities
const capabilities = await client.getCapabilities();
console.log(capabilities);
// {
//   chat: true,
//   completion: true,
//   embeddings: true,
//   streaming: true,
//   functions: true,
//   vision: true,
//   fineTuning: false,
//   maxContextLength: 128000,
//   supportedOperations: ['chat', 'completion', 'embedding', 'streaming']
// }

// Count tokens before making requests
const tokenCount = await client.countTokens("How many tokens is this text?");
console.log(`Token count: ${tokenCount}`);
```

### Error Handling and Retry Logic

```typescript
import { 
  getAI, 
  AIError, 
  AuthenticationError, 
  RateLimitError, 
  ModelNotFoundError,
  ContextLengthError,
  ContentFilterError 
} from '@have/ai';

const client = await getAI({
  apiKey: process.env.OPENAI_API_KEY!,
  maxRetries: 3,
  timeout: 30000
});

try {
  const response = await client.chat([
    { role: 'user', content: 'Generate a response' }
  ]);
  console.log(response.content);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Authentication failed - check API key');
  } else if (error instanceof RateLimitError) {
    console.error('Rate limit exceeded - implementing backoff');
    // Implement exponential backoff
    await new Promise(resolve => setTimeout(resolve, 2000));
  } else if (error instanceof ModelNotFoundError) {
    console.error(`Model not available: ${error.model}`);
    // Fallback to different model
  } else if (error instanceof ContextLengthError) {
    console.error('Input too long - truncating or summarizing');
  } else if (error instanceof ContentFilterError) {
    console.error('Content filtered by safety systems');
  } else if (error instanceof AIError) {
    console.error(`AI Error [${error.code}]: ${error.message}`);
  } else {
    console.error('Unexpected error:', error);
  }
}
```

### Multi-Provider Usage Patterns

```typescript
import { getAI } from '@have/ai';

// Create multiple providers for redundancy
const providers = await Promise.all([
  getAI({ type: 'openai', apiKey: process.env.OPENAI_API_KEY! }),
  getAI({ type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! }),
  getAI({ type: 'gemini', apiKey: process.env.GEMINI_API_KEY! })
]);

// Function to try providers in order with fallback
async function robustChat(messages: AIMessage[]) {
  for (const [index, provider] of providers.entries()) {
    try {
      const response = await provider.chat(messages, {
        timeout: 10000,
        maxTokens: 1000
      });
      return response;
    } catch (error) {
      console.warn(`Provider ${index + 1} failed:`, error);
      if (index === providers.length - 1) {
        throw new Error('All providers failed');
      }
    }
  }
}

// Use the most cost-effective provider for simple tasks
async function smartProviderSelection(messages: AIMessage[]) {
  const tokenCount = await providers[0].countTokens(
    messages.map(m => m.content).join(' ')
  );
  
  if (tokenCount < 100) {
    // Use cheaper provider for simple queries
    return providers[2].chat(messages); // Gemini
  } else {
    // Use more capable provider for complex queries
    return providers[0].chat(messages); // OpenAI
  }
}
```

## Important Implementation Details

### Provider-Specific Message Formatting

Each provider has its own message format requirements:

- **OpenAI**: Uses `ChatCompletionMessageParam` with strict role types
- **Anthropic**: Requires alternating user/assistant messages (no consecutive user messages)
- **Gemini**: Different content structure for multi-modal inputs
- **Hugging Face**: Converts chat messages to prompt strings using `messagesToPrompt()`
- **Bedrock**: Varies by underlying model (Claude, Llama, etc.)

The `mapMessagesToOpenAI()` and similar methods handle these conversions internally.

### Token Counting

Token counting varies by provider:
- **OpenAI**: Approximation using character count (~4 chars per token) - no direct API
- **Anthropic**: Uses SDK's token counting when available
- **Gemini**: Uses model-specific tokenizers
- **Others**: May use approximations

For precise counting, use a dedicated tokenizer library like `tiktoken` for OpenAI.

### Streaming Implementation

All providers implement streaming via async generators:
```typescript
async *stream(messages: AIMessage[], options?: ChatOptions): AsyncIterable<string> {
  // Yields content chunks as they arrive
  for await (const chunk of providerStream) {
    yield chunk.content;
  }
}
```

Consumers use `for await...of`:
```typescript
for await (const chunk of provider.stream(messages)) {
  process.stdout.write(chunk);
}
```

### Error Handling Strategy

Each provider maps native errors to standardized types:
- HTTP 401 → `AuthenticationError`
- HTTP 429 → `RateLimitError` (includes retry-after when available)
- HTTP 404 → `ModelNotFoundError`
- HTTP 413 → `ContextLengthError`
- Content filter triggers → `ContentFilterError`
- Everything else → `AIError` with provider and code

This allows consistent error handling across providers:
```typescript
try {
  await provider.chat(messages);
} catch (error) {
  if (error instanceof RateLimitError) {
    // Handle rate limiting consistently across all providers
  }
}
```

### Model Information and Capabilities

Providers return different levels of detail for `getModels()`:
- **OpenAI**: Fetches live model list via API
- **Anthropic/Gemini/Bedrock**: Returns static model definitions (API doesn't provide list)
- **Hugging Face**: Returns generic model structure

Context lengths are hardcoded based on known model limits (update when new models are released).

### Function Calling / Tool Usage

**All major providers now support tool use with a unified interface!**

Function calling support:
- **OpenAI**: Full native support with `tools` and `tool_choice` parameters
- **Anthropic**: Full native support via Claude's tool use API (maps to `name`, `description`, `input_schema`)
- **Gemini**: Full native support via Google's function calling API (maps to `functionDeclarations`)
- **Bedrock**: Depends on underlying model (Claude models support tool use)
- **Hugging Face**: Generally not supported (model-dependent)

**Unified Tool Interface**: All providers use the standardized `AITool` interface from `ChatOptions`, which is automatically mapped to each provider's native format:

```typescript
const response = await client.chat([
  { role: 'user', content: 'What is the weather in Tokyo?' }
], {
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
        },
        required: ['location']
      }
    }
  }],
  toolChoice: 'auto' // Works across OpenAI, Anthropic, and Gemini
});

// Access tool calls from any provider
if (response.toolCalls) {
  for (const call of response.toolCalls) {
    console.log(`${call.function.name}: ${call.function.arguments}`);
  }
}
```

**Provider-Specific Mappings:**
- **OpenAI**: Direct pass-through of tools array, native `tool_choice` support
- **Anthropic**: Converts to `tools` array with `input_schema`, maps `tool_choice` to Anthropic's format
- **Gemini**: Wraps in `functionDeclarations` array, uses `functionCallingConfig` for tool choice

**Structured Output Support:**
All providers now support `responseFormat: { type: 'json_object' }`:
- **OpenAI**: Native JSON mode support
- **Anthropic**: Adds JSON instruction to system message (prompt-based)
- **Gemini**: Uses `responseMimeType: 'application/json'` (native support)

### Legacy Client Components

The package includes legacy components for backward compatibility:

**`AIClient` and `OpenAIClient`** (`shared/client.ts`):
- Older static factory pattern: `await AIClient.create(options)`
- Direct OpenAI-only implementation
- **Deprecated**: Use `getAI()` factory for new code

**`AIThread`** (`shared/thread.ts`):
- Manages conversation state with history and references
- Useful for building conversational agents
- Assembles messages with proper ordering (system → references → conversation)
- Still actively used in `@have/smrt` package

**`AIMessage` class** (`shared/message.ts`):
- Message object wrapper (different from `AIMessage` interface)
- Used with `AIThread` for conversation management
- Not needed when using factory pattern directly

### Gotchas and Common Issues

1. **Default Models**: Each provider has different defaults
   - OpenAI: `gpt-4o`
   - Anthropic: Must specify model explicitly
   - Gemini: Must specify model explicitly
   - Always set `defaultModel` in options for predictability

2. **Streaming with Options**: When using `onProgress` callback, the streaming happens internally
   ```typescript
   // This WAITS for completion while calling onProgress
   const response = await client.chat(messages, {
     onProgress: (chunk) => console.log(chunk)
   });

   // This streams chunks as they arrive
   for await (const chunk of client.stream(messages)) {
     console.log(chunk);
   }
   ```

3. **Message Role Requirements**:
   - Some providers require system messages first
   - Anthropic requires alternating user/assistant messages
   - Tool/function messages must follow assistant tool_calls

4. **Context Length Limits**:
   - Exceeding limits throws `ContextLengthError`
   - Check `getModels()` for model-specific limits
   - Consider truncation or summarization strategies

5. **Embeddings**:
   - Only OpenAI provider fully supports embeddings
   - Default model: `text-embedding-3-small`
   - Anthropic/Claude do not support embeddings

6. **Rate Limiting**:
   - `RateLimitError` includes retry-after when available
   - Implement exponential backoff with jitter
   - Provider SDKs may have built-in retry logic (check `maxRetries` option)

## Dependencies

The package has the following dependencies:

### Internal Dependencies
- `@have/utils`: For utility functions, validation, and error handling

### External Dependencies
- `openai`: Official OpenAI JavaScript/TypeScript SDK for GPT models
- `@google/genai`: Google's official unified SDK for Gemini and Vertex AI (replaces deprecated @google/generative-ai)
- `@anthropic-ai/sdk`: Anthropic's official SDK for Claude models
- `@aws-sdk/client-bedrock-runtime`: AWS SDK client for Bedrock runtime operations

### Development Dependencies
- `@types/node`: TypeScript definitions for Node.js
- `vitest`: Testing framework for unit and integration tests

## Development Guidelines

### Multi-Provider AI Integration Patterns

When working with multiple AI providers, follow these patterns:

#### Provider Factory Pattern
```typescript
// Unified client creation with consistent interface
const createProvider = async (type: string, config: any) => {
  return await getAI({ type, ...config });
};
```

#### Streaming Response Handling
```typescript
// Handle streaming for better user experience
async function handleStreamingResponse(provider: AIInterface, messages: AIMessage[]) {
  try {
    for await (const chunk of provider.stream(messages)) {
      process.stdout.write(chunk);
    }
  } catch (error) {
    console.error('Streaming failed, falling back to regular response');
    const response = await provider.chat(messages);
    console.log(response.content);
  }
}
```

#### Cost Optimization Strategies
```typescript
// Choose appropriate models based on task complexity
function selectOptimalModel(taskComplexity: 'simple' | 'medium' | 'complex') {
  const modelConfig = {
    simple: { type: 'gemini', model: 'gemini-pro' },
    medium: { type: 'anthropic', model: 'claude-3-haiku' },
    complex: { type: 'openai', model: 'gpt-4o' }
  };
  
  return modelConfig[taskComplexity];
}
```

## Common Patterns and Conventions

### Exports and Module Structure

The package exports everything from a single entry point (`index.ts`):
```typescript
// Public API - use these
export * from './shared/client';      // Legacy AIClient, OpenAIClient
export * from './shared/factory';     // getAI(), getAIAuto()
export { AIMessage as AIMessageClass } from './shared/message';
export * from './shared/thread';      // AIThread
export * from './shared/types';       // Interfaces and types
```

Provider implementations are in `shared/providers/` but not directly exported (use factory functions).

### Type-Safe Provider Options

Use discriminated unions for type-safe provider selection:
```typescript
// TypeScript knows available options based on 'type' field
const client = await getAI({
  type: 'anthropic',  // TypeScript narrows to AnthropicOptions
  apiKey: '...',
  anthropicVersion: '2023-06-01'  // Type-checked as valid for Anthropic
});
```

### Response Format Standardization

All providers return consistent `AIResponse` structure:
```typescript
interface AIResponse {
  content: string;              // Generated text
  usage?: TokenUsage;           // Token consumption
  model?: string;               // Model that generated response
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  toolCalls?: Array<{...}>;     // Function calls made by model
}
```

This ensures code written for one provider works with another.

### Async Generator Pattern for Streaming

Providers use async generators for streaming to provide clean iteration:
```typescript
// Provider implementation
async *stream(messages: AIMessage[], options?: ChatOptions): AsyncIterable<string> {
  const stream = await this.client.chat.completions.create({...});
  for await (const chunk of stream) {
    if (chunk.content) yield chunk.content;
  }
}

// Consumer usage
for await (const chunk of provider.stream(messages)) {
  // Process each chunk as it arrives
}
```

### Error Propagation

Errors bubble up with context:
1. Native provider error occurs
2. Provider's `mapError()` converts to standardized error
3. Consumer catches typed error with provider context
```typescript
throw new RateLimitError('openai', 60); // Provider, retry-after seconds
```

### Options Merging

Provider options merge with method options:
```typescript
const client = await getAI({
  type: 'openai',
  apiKey: '...',
  defaultModel: 'gpt-4o',      // Default for all requests
  temperature: 0.7             // Default temperature
});

// Method options override defaults
await client.chat(messages, {
  model: 'gpt-3.5-turbo',      // Overrides defaultModel
  temperature: 0.9             // Overrides default temperature
});
```

### Dynamic Provider Loading

The factory uses dynamic imports to load only needed providers:
```typescript
if (isOpenAIOptions(options)) {
  const { OpenAIProvider } = await import('./providers/openai.js');
  return new OpenAIProvider(options);
}
```

This keeps bundle size small when not all providers are used.

### Testing Patterns

Tests follow these conventions:

**Unit Tests**: Test provider initialization and interface compliance
```typescript
it('should initialize with valid options', () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key' });
  expect(provider).toBeInstanceOf(OpenAIProvider);
});
```

**Integration Tests**: Test real API calls (requires API keys)
```typescript
it('should complete chat request', async () => {
  const provider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!
  });
  const response = await provider.chat([...]);
  expect(response.content).toBeTruthy();
}, 30000); // Longer timeout for real API calls
```

**Provider-Specific Tests**: Test unique provider features
```typescript
it('should convert messages to prompt correctly', () => {
  // HuggingFace-specific test
  const prompt = (provider as any).messagesToPrompt(messages);
  expect(prompt).toBe('Human: Hello\nAssistant:');
});
```

### Naming Conventions

- **Interfaces**: PascalCase with `AI` prefix (`AIInterface`, `AIMessage`, `AIResponse`)
- **Options**: PascalCase with `Options` suffix (`ChatOptions`, `OpenAIOptions`)
- **Providers**: PascalCase with `Provider` suffix (`OpenAIProvider`, `GeminiProvider`)
- **Factory functions**: camelCase (`getAI`, `getAIAuto`)
- **Private methods**: camelCase with descriptive names (`mapMessagesToOpenAI`, `mapError`)

### Adding New AI Providers

To add support for a new AI provider:

1. **Create Provider Implementation**: Implement `AIInterface` in `src/shared/providers/`
2. **Add Type Definitions**: Add provider options to `types.ts`
3. **Update Factory**: Add type guards and factory logic in `factory.ts`
4. **Implement Tests**: Create comprehensive tests in `src/providers.test.ts`
5. **Update Documentation**: Add provider examples to this documentation

Example provider structure:
```typescript
export class NewProviderClient implements AIInterface {
  constructor(private options: NewProviderOptions) {}
  
  async chat(messages: AIMessage[], options?: ChatOptions): Promise<AIResponse> {
    // Implementation
  }
  
  async complete(prompt: string, options?: CompletionOptions): Promise<AIResponse> {
    // Implementation
  }
  
  // ... implement all AIInterface methods
}
```

### Testing Strategy

```bash
# Run all tests
bun test

# Run tests in watch mode for development
bun test:watch

# Run integration tests (requires API keys)
OPENAI_API_KEY=xxx ANTHROPIC_API_KEY=xxx bun test integration

# Run provider-specific tests
bun test providers.test.ts
```

**Testing Guidelines:**
- Mock external API calls in unit tests
- Use real API calls sparingly in integration tests
- Test error conditions and edge cases
- Validate response format compliance across providers
- Test streaming functionality and cancellation

### Building and Distribution

```bash
# Build for both browser and Node.js environments
bun run build

# Build individual targets
bun run build:browser  # Browser-compatible bundle
bun run build:node     # Node.js-specific bundle

# Watch mode for development
bun run build:watch

# Clean build artifacts
bun run clean
```

### Best Practices

#### Security and API Key Management
- **Never hard-code API keys** - use environment variables or secure key vaults
- **Implement API key rotation** - support dynamic credential updates
- **Validate inputs** to prevent prompt injection attacks
- **Use content filtering** when available from providers
- **Monitor API usage** for unusual patterns

#### Performance Optimization
- **Choose appropriate models** for task complexity and cost requirements
- **Implement response caching** to reduce duplicate requests
- **Use streaming** for long-form content generation
- **Batch requests** when possible to reduce overhead
- **Set reasonable timeouts** to prevent hanging requests
- **Implement connection pooling** for high-throughput scenarios

#### Rate Limiting and Retry Logic
- **Implement exponential backoff** for rate limiting
- **Respect provider rate limits** with proper delay mechanisms
- **Use jitter** in retry delays to avoid thundering herd
- **Monitor rate limit headers** when available
- **Implement circuit breakers** for repeated failures

#### Cost Management
- **Track token usage** across different models and providers
- **Implement usage quotas** and alerts for cost control
- **Use prompt optimization** to reduce token consumption
- **Choose cost-effective models** for each use case
- **Cache expensive operations** when appropriate
- **Monitor spending** across multiple providers

#### Error Handling Best Practices
- **Catch provider-specific errors** and normalize them
- **Implement graceful degradation** when providers fail
- **Log errors** with sufficient context for debugging
- **Provide meaningful error messages** to users
- **Handle partial failures** in multi-provider scenarios
- **Implement health checks** for provider availability

## Provider-Specific Considerations

### OpenAI
- **Function Calling**: Robust support for tools and function calling
- **JSON Mode**: Use `responseFormat: { type: 'json_object' }` for structured output
- **Model Context**: GPT-4o has 128k context, GPT-3.5-turbo has 16k context
- **Rate Limits**: Vary by model and subscription tier

### Google Gemini
- **Multi-modal**: Native support for text, image, and code input
- **Safety Settings**: Configure content filtering and safety thresholds
- **Project ID**: Required for some operations, optional for others
- **Model Variants**: Gemini Pro vs Gemini Flash for different use cases
- **Function Calling**: Full support with `functionDeclarations` and `functionCallingConfig`
- **JSON Mode**: Native `responseMimeType: 'application/json'` support

### Anthropic Claude
- **Constitutional AI**: Built-in safety and helpfulness guidelines
- **Message Format**: Specific requirements for message role sequence
- **Tool Use**: Full native support via Claude's tool use API with `input_schema`
- **Context Length**: Claude 3 models support up to 200k tokens
- **JSON Mode**: Implemented via system message instructions (prompt-based approach)

### AWS Bedrock
- **Model Access**: Request access to specific models before use
- **Regional Availability**: Not all models available in all regions
- **IAM Policies**: Proper permissions required for model access
- **Cost Structure**: Pay-per-use pricing with different rates per model

### Hugging Face
- **Model Availability**: Thousands of models available through the Hub
- **Custom Models**: Support for fine-tuned and custom models
- **Inference Endpoints**: Dedicated endpoints for production use
- **Community Models**: Access to community-contributed models

## API Documentation

The @have/ai package generates comprehensive API documentation in both HTML and markdown formats using TypeDoc:

### Generated Documentation Formats

**HTML Documentation** (recommended for browsing):
- Generated in `docs/` directory for public website
- Full API reference with interactive navigation
- Cross-linked type definitions and examples
- Accessible via development server at `http://localhost:3030/`

**Markdown Documentation** (great for development):
- Generated in `packages/ai/docs/` directory
- Markdown format perfect for IDE integration
- Accessible via development server at `http://localhost:3030/packages/ai/`

### Generating Documentation

```bash
# Generate documentation for this package
npm run docs

# Generate and watch for changes during development
npm run docs:watch

# Start development server to browse documentation
npm run dev  # Serves docs at http://localhost:3030
```

### Development Workflow

Documentation is automatically generated during the build process and can be viewed alongside development:

1. **During Development**: Use `npm run docs:watch` to regenerate docs as you code
2. **Local Browsing**: Access HTML docs at `http://localhost:3030/` or markdown at `http://localhost:3030/packages/ai/`
3. **IDE Integration**: Point your editor to `packages/ai/docs/` for offline markdown reference

The documentation includes complete API coverage, usage examples, and cross-references to related HAVE SDK packages.

## Documentation Links

Since AI provider SDKs change rapidly with new models and features, always check the latest documentation when planning solutions:

### OpenAI
- **Official SDK Repository**: https://github.com/openai/openai-node
- **Platform Documentation**: https://platform.openai.com/docs/libraries/typescript-javascript-library
- **API Reference**: https://platform.openai.com/docs/api-reference
- **Quickstart Guide**: https://platform.openai.com/docs/quickstart?context=node
- **NPM Package**: https://www.npmjs.com/package/openai

### Google Generative AI
- **New Unified SDK Repository**: https://github.com/googleapis/js-genai
- **Official Documentation**: https://cloud.google.com/vertex-ai/generative-ai/docs/sdks/overview
- **Gemini API Libraries**: https://ai.google.dev/gemini-api/docs/libraries
- **NPM Package**: https://www.npmjs.com/package/@google/genai
- **IMPORTANT**: @google/generative-ai is deprecated - use @google/genai instead

### Anthropic Claude
- **Official SDK Repository**: https://github.com/anthropics/anthropic-sdk-typescript
- **Platform Documentation**: https://docs.anthropic.com/en/docs/get-started
- **Client SDKs Guide**: https://docs.anthropic.com/en/api/client-sdks
- **Claude Code SDK**: https://docs.anthropic.com/en/docs/claude-code/sdk
- **NPM Package**: https://www.npmjs.com/package/@anthropic-ai/sdk

### AWS Bedrock Runtime
- **Official Documentation**: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/
- **Code Examples**: https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html
- **General Bedrock SDK Info**: https://docs.aws.amazon.com/bedrock/latest/userguide/sdk-general-information-section.html
- **NPM Package**: https://www.npmjs.com/package/@aws-sdk/client-bedrock-runtime

### Hugging Face
- **Inference API**: https://huggingface.co/docs/api-inference/
- **JavaScript Client**: https://huggingface.co/docs/huggingface.js/
- **Model Hub**: https://huggingface.co/models
- **NPM Package**: https://www.npmjs.com/package/@huggingface/inference

## Expert Agent Instructions

When working with @have/ai:

1. **Always check latest documentation** before implementing solutions using WebFetch tool
2. **Stay current with API changes** - AI provider APIs evolve rapidly with new models and features
3. **Review new features** that could improve performance, reduce costs, or unlock new capabilities
4. **Check for breaking changes** in major version updates of provider SDKs
5. **Look for new model releases** and capability updates
6. **Monitor deprecation notices** for models and API endpoints

Example workflow for staying current:
```typescript
// Before implementing a solution, check latest provider docs
// Then implement with current best practices and latest models
const client = await getAI({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: 'gpt-4o' // Use latest recommended model
});
```

This package provides the AI interaction foundation needed by intelligent agents to work effectively across multiple AI providers while maintaining consistency, performance, and cost efficiency.

## Quick Reference

### File Locations

```
packages/ai/src/
├── index.ts                    # Main entry point - exports everything
├── shared/
│   ├── factory.ts             # getAI(), getAIAuto() factory functions
│   ├── types.ts               # Core interfaces and types
│   ├── client.ts              # Legacy AIClient, OpenAIClient (backward compat)
│   ├── message.ts             # AIMessage class for AIThread
│   ├── thread.ts              # AIThread for conversation management
│   └── providers/
│       ├── openai.ts          # OpenAI provider implementation
│       ├── anthropic.ts       # Anthropic Claude provider
│       ├── gemini.ts          # Google Gemini provider
│       ├── huggingface.ts     # Hugging Face provider
│       └── bedrock.ts         # AWS Bedrock provider
├── integration.test.ts        # Integration tests (requires API keys)
├── providers.test.ts          # Unit tests for all providers
└── types.test.ts              # Type definition tests
```

### Key Types and Interfaces

```typescript
// Core provider interface
interface AIInterface {
  chat(messages: AIMessage[], options?: ChatOptions): Promise<AIResponse>
  complete(prompt: string, options?: CompletionOptions): Promise<AIResponse>
  embed(text: string | string[], options?: EmbeddingOptions): Promise<EmbeddingResponse>
  stream(messages: AIMessage[], options?: ChatOptions): AsyncIterable<string>
  countTokens(text: string): Promise<number>
  getModels(): Promise<AIModel[]>
  getCapabilities(): Promise<AICapabilities>
}

// Message structure
interface AIMessage {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool'
  content: string
  name?: string
  tool_calls?: Array<{...}>
}

// Standardized response
interface AIResponse {
  content: string
  usage?: TokenUsage
  model?: string
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  toolCalls?: Array<{...}>
}

// Provider options (discriminated union)
type GetAIOptions =
  | OpenAIOptions
  | GeminiOptions
  | AnthropicOptions
  | HuggingFaceOptions
  | BedrockOptions
```

### Common Commands

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test:watch

# Run integration tests (requires API keys)
OPENAI_API_KEY=xxx bun test integration

# Build package
bun run build

# Build in watch mode
bun run build:watch

# Generate documentation
npm run docs

# Clean build artifacts
npm run clean
```

### Quick Usage Examples

```typescript
// Basic usage
import { getAI } from '@have/ai';
const client = await getAI({ type: 'openai', apiKey: '...' });
const response = await client.chat([{ role: 'user', content: 'Hello' }]);

// Streaming
for await (const chunk of client.stream([{ role: 'user', content: 'Tell a story' }])) {
  process.stdout.write(chunk);
}

// Error handling
import { RateLimitError, AuthenticationError } from '@have/ai';
try {
  await client.chat(messages);
} catch (error) {
  if (error instanceof RateLimitError) {
    // Handle rate limiting
  } else if (error instanceof AuthenticationError) {
    // Handle authentication error
  }
}

// Function calling
const response = await client.chat(messages, {
  tools: [{ type: 'function', function: { name: 'get_weather', ... } }],
  toolChoice: 'auto'
});

// Legacy AIThread for conversations
import { AIThread } from '@have/ai';
const thread = await AIThread.create({ ai: { type: 'openai', apiKey: '...' } });
await thread.addSystem('You are a helpful assistant');
await thread.add({ role: 'user', content: 'Hello' });
const response = await thread.do('What is TypeScript?');
```

### Important Notes for Development

1. **Use Factory Pattern**: Prefer `getAI()` over direct instantiation or legacy `AIClient.create()`
2. **Provider Loading**: Factory uses dynamic imports - only loads providers you use
3. **Error Mapping**: All providers map to standardized error types for consistent handling
4. **Streaming**: Use async generators (`for await...of`) for real-time streaming
5. **Token Counting**: Approximations only - use dedicated tokenizers for precision
6. **Testing**: Unit tests use mock/fake data, integration tests require real API keys
7. **Type Safety**: Use discriminated unions - TypeScript narrows options based on `type` field
8. **Backward Compatibility**: Legacy `AIClient`, `AIThread`, `AIMessage` class still supported
9. **Dependencies**: Only depends on `@have/utils` internally + provider SDKs externally
10. **Documentation**: Auto-generated API docs in `docs/` using TypeDoc

### When to Use What

**Use `getAI()` + provider methods** when:
- Building new AI integrations
- Need multi-provider support
- Want modern async/await patterns
- Need streaming capabilities

**Use `AIThread`** when:
- Building conversational agents
- Need conversation state management
- Want to include reference materials
- Working with existing SMRT codebase

**Use legacy `AIClient`** when:
- Maintaining existing code
- Backward compatibility required
- Direct OpenAI-only usage

### Performance Considerations

- **Lazy Loading**: Providers loaded on-demand via dynamic imports
- **Streaming**: Reduces time-to-first-token for long responses
- **Token Counting**: Approximations avoid extra API calls
- **Error Handling**: Built-in retry logic (configure via `maxRetries` option)
- **Connection Pooling**: Provider SDKs handle connection reuse
- **Rate Limiting**: Respect provider limits, implement exponential backoff