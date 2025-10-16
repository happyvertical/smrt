# @have/ai

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A standardized interface for AI model interactions across multiple providers in the HAVE SDK.

## Overview

The `@have/ai` package provides a unified interface for interacting with various AI models, making it easy to switch between providers without changing your application code. Supports **OpenAI**, **Anthropic Claude**, **Google Gemini**, **AWS Bedrock**, and **Hugging Face** with a consistent API.

## Features

- **Multi-Provider Support**: OpenAI, Anthropic, Google Gemini, AWS Bedrock, and Hugging Face
- **Unified Interface**: Consistent API across all providers
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Streaming Responses**: Real-time content streaming for all providers
- **Function Calling**: Tool usage and function calling support (where available)
- **Error Handling**: Standardized error types with retry logic
- **Auto-Detection**: Automatically detect provider from credentials
- **Embeddings**: Text embeddings support (OpenAI and other embedding providers)
- **Model Information**: Query available models and capabilities

## Installation

```bash
# Install with bun (recommended)
bun add @have/ai

# Or with npm
npm install @have/ai

# Or with yarn
yarn add @have/ai
```

## Quick Start

### Basic Usage (Auto-Detection)

```typescript
import { getAI } from '@have/ai';

// OpenAI (default)
const openai = await getAI({
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: 'gpt-4o'
});

// Chat completion
const response = await openai.chat([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is TypeScript?' }
]);

console.log(response.content);
console.log(`Tokens used: ${response.usage?.totalTokens}`);
```

### Multiple Providers

```typescript
import { getAI } from '@have/ai';

// OpenAI
const openai = await getAI({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: 'gpt-4o'
});

// Anthropic Claude
const claude = await getAI({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  defaultModel: 'claude-3-5-sonnet-20241022'
});

// Google Gemini
const gemini = await getAI({
  type: 'gemini',
  apiKey: process.env.GEMINI_API_KEY!,
  defaultModel: 'gemini-1.5-pro'
});

// AWS Bedrock
const bedrock = await getAI({
  type: 'bedrock',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  },
  defaultModel: 'anthropic.claude-3-sonnet-20240229-v1:0'
});
```

### Streaming Responses

```typescript
// Stream response in real-time
for await (const chunk of client.stream([
  { role: 'user', content: 'Write a story about AI' }
])) {
  process.stdout.write(chunk);
}
```

### Function Calling

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
          location: { type: 'string', description: 'City name' }
        },
        required: ['location']
      }
    }
  }],
  toolChoice: 'auto'
});

if (response.toolCalls) {
  console.log('Function called:', response.toolCalls[0].function.name);
}
```

### Embeddings

```typescript
// Generate text embeddings (OpenAI)
const embeddings = await client.embed([
  'First document text',
  'Second document text'
]);

console.log(`Generated ${embeddings.embeddings.length} embeddings`);
```

### Error Handling

```typescript
import {
  getAI,
  AIError,
  AuthenticationError,
  RateLimitError,
  ModelNotFoundError
} from '@have/ai';

try {
  const response = await client.chat([
    { role: 'user', content: 'Hello' }
  ]);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Invalid API key');
  } else if (error instanceof RateLimitError) {
    console.error('Rate limit exceeded, retry after:', error.message);
  } else if (error instanceof ModelNotFoundError) {
    console.error('Model not available:', error.model);
  } else if (error instanceof AIError) {
    console.error('AI Error:', error.code, error.message);
  }
}
```

### Provider Capabilities

```typescript
// Check what features are supported
const capabilities = await client.getCapabilities();

if (capabilities.functions) {
  console.log('Function calling is supported');
}

if (capabilities.vision) {
  console.log('Vision/multimodal input is supported');
}

// Get available models
const models = await client.getModels();
console.log('Available models:', models.map(m => m.id));
```

## Provider-Specific Features

### OpenAI
- **Models**: GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo
- **Features**: Chat, completions, embeddings, function calling, vision
- **Strengths**: Best function calling, JSON mode, wide model selection

### Anthropic Claude
- **Models**: Claude 3.5 Sonnet, Claude 3.5 Haiku, Claude 3 Opus
- **Features**: Chat, completions, streaming, vision (no embeddings)
- **Strengths**: Large context (200k tokens), safety-focused

### Google Gemini
- **Models**: Gemini 1.5 Pro, Gemini 1.5 Flash
- **Features**: Chat, completions, streaming, multimodal
- **Strengths**: Multimodal capabilities, cost-effective

### AWS Bedrock
- **Models**: Claude, Llama, Titan models available through AWS
- **Features**: Enterprise-grade security, region-specific deployment
- **Strengths**: AWS integration, compliance, scalability

### Hugging Face
- **Models**: Thousands of community and commercial models
- **Features**: Custom models, specialized use cases
- **Strengths**: Model variety, community ecosystem

## Advanced Usage

### Auto-Detection
```typescript
import { getAIAuto } from '@have/ai';

// Automatically detects provider from credentials
const client = await getAIAuto({
  apiKey: 'sk-...',  // Detected as OpenAI
  // apiToken: 'hf_...', // Would detect as Hugging Face
  // region: 'us-east-1', credentials: {...} // Would detect as Bedrock
});
```

### Multi-Provider Fallback
```typescript
const providers = [
  await getAI({ type: 'openai', apiKey: process.env.OPENAI_API_KEY! }),
  await getAI({ type: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! })
];

async function robustChat(messages: AIMessage[]) {
  for (const provider of providers) {
    try {
      return await provider.chat(messages);
    } catch (error) {
      console.warn('Provider failed, trying next:', error);
    }
  }
  throw new Error('All providers failed');
}
```

## TypeScript Support

The package is written in TypeScript and provides comprehensive type definitions:

```typescript
import type {
  AIInterface,
  AIMessage,
  AIResponse,
  ChatOptions,
  AICapabilities,
  TokenUsage
} from '@have/ai';
```

## API Reference

- **Factory Functions**: `getAI()`, `getAIAuto()`
- **Core Interface**: `AIInterface` with `chat()`, `complete()`, `embed()`, `stream()`
- **Error Types**: `AIError`, `AuthenticationError`, `RateLimitError`, etc.
- **Options**: Provider-specific configuration interfaces
- **Types**: Comprehensive TypeScript definitions

For complete API documentation, see the generated TypeDoc documentation in the `docs/` directory or visit the [HAVE SDK documentation site](https://happyvertical.github.io/sdk/).

## License

This package is part of the HAVE SDK and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.