# @smrt/types

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Shared TypeScript type definitions for the SMRT framework.

## Overview

The `@smrt/types` package provides foundational type definitions and interfaces used across the SMRT framework. It prevents circular dependencies by centralizing shared types that multiple packages need to reference, particularly for the Universal Signaling System that enables automatic method tracking and observability.

## Features

- **Signal Types**: Core types for the SMRT signaling system
- **Zero Dependencies**: Pure TypeScript definitions with no runtime dependencies
- **Type Safety**: Comprehensive type definitions for signal lifecycle and adapters
- **Observability**: Types for automatic method tracking, logging, metrics, and pub/sub
- **Extensible**: Adapter interface for custom signal processors

## Installation

```bash
# Install with npm
npm install @smrt/types

# Or with yarn
yarn add @smrt/types

# Or with bun
bun add @smrt/types
```

## Usage

### Signal Types

The package exports types for the Universal Signaling System, which provides automatic observability into SMRT method execution:

```typescript
import type { Signal, SignalType, SignalAdapter } from '@smrt/types';

// Signal lifecycle types
const signalType: SignalType = 'start'; // 'start' | 'step' | 'end' | 'error'

// Working with signals
function logSignal(signal: Signal) {
  console.log(`[${signal.type}] ${signal.className}.${signal.method}`);

  if (signal.type === 'end') {
    console.log(`Duration: ${signal.duration}ms`);
  }

  if (signal.type === 'error') {
    console.error(`Error: ${signal.error?.message}`);
  }
}
```

### Creating Signal Adapters

Implement the `SignalAdapter` interface to process signals for logging, metrics, pub/sub, or tracing:

```typescript
import type { SignalAdapter, Signal } from '@smrt/types';

class ConsoleLogAdapter implements SignalAdapter {
  async handle(signal: Signal): Promise<void> {
    const prefix = `[${signal.timestamp.toISOString()}] ${signal.className}.${signal.method}`;

    switch (signal.type) {
      case 'start':
        console.log(`${prefix} - Started`);
        break;
      case 'step':
        console.log(`${prefix} - ${signal.step}`);
        break;
      case 'end':
        console.log(`${prefix} - Completed in ${signal.duration}ms`);
        break;
      case 'error':
        console.error(`${prefix} - Error: ${signal.error?.message}`);
        break;
    }
  }
}

// Use with SMRT SignalBus
const adapter = new ConsoleLogAdapter();
// signalBus.register(adapter);
```

### Metrics Adapter Example

```typescript
import type { SignalAdapter, Signal } from '@smrt/types';

class MetricsAdapter implements SignalAdapter {
  private metrics = new Map<string, { count: number; totalDuration: number }>();

  async handle(signal: Signal): Promise<void> {
    if (signal.type === 'end') {
      const key = `${signal.className}.${signal.method}`;
      const existing = this.metrics.get(key) || { count: 0, totalDuration: 0 };

      this.metrics.set(key, {
        count: existing.count + 1,
        totalDuration: existing.totalDuration + (signal.duration || 0)
      });
    }
  }

  getStats(methodKey: string) {
    const stats = this.metrics.get(methodKey);
    if (!stats) return null;

    return {
      count: stats.count,
      avgDuration: stats.totalDuration / stats.count
    };
  }
}
```

### Pub/Sub Adapter Example

```typescript
import type { SignalAdapter, Signal } from '@smrt/types';

class PubSubAdapter implements SignalAdapter {
  constructor(private publishFn: (topic: string, data: any) => Promise<void>) {}

  async handle(signal: Signal): Promise<void> {
    const topic = `signals.${signal.className}.${signal.method}`;

    await this.publishFn(topic, {
      id: signal.id,
      type: signal.type,
      timestamp: signal.timestamp,
      duration: signal.duration,
      error: signal.error?.message
    });
  }
}

// Usage
const adapter = new PubSubAdapter(async (topic, data) => {
  // Publish to your message broker
  await redis.publish(topic, JSON.stringify(data));
});
```

## Signal Interface

The `Signal` interface provides comprehensive information about method execution:

```typescript
interface Signal {
  id: string;              // Unique execution ID
  objectId: string;        // SMRT object instance ID
  className: string;       // Name of the SMRT class
  method: string;          // Method being executed
  type: SignalType;        // Lifecycle stage
  step?: string;           // Optional step label
  args?: any[];            // Sanitized method arguments
  result?: any;            // Method result (on 'end')
  error?: Error;           // Error thrown (on 'error')
  duration?: number;       // Execution duration in ms
  timestamp: Date;         // When signal was emitted
  metadata?: Record<string, any>; // Additional context
}
```

## Signal Lifecycle

Signals are emitted at different stages of method execution:

1. **`start`**: Method execution begins
2. **`step`**: Optional manual progress updates (can be multiple)
3. **`end`**: Method completes successfully
4. **`error`**: Method throws an error

```typescript
import type { Signal } from '@smrt/types';

function handleMethodLifecycle(signal: Signal) {
  switch (signal.type) {
    case 'start':
      // Track method invocation
      console.log(`Starting ${signal.method}`);
      break;

    case 'step':
      // Track progress through method
      console.log(`Progress: ${signal.step}`);
      break;

    case 'end':
      // Record success metrics
      console.log(`Completed in ${signal.duration}ms`);
      break;

    case 'error':
      // Handle failures
      console.error(`Failed: ${signal.error?.message}`);
      break;
  }
}
```

## TypeScript Support

This package is written in TypeScript and provides comprehensive type definitions for all exports. Import types using the `type` keyword:

```typescript
import type { Signal, SignalAdapter, SignalType } from '@smrt/types';
```

## API Reference

For complete API documentation, see [/api/types/globals](/api/types/globals).

## License

This package is part of the SMRT framework and is licensed under the MIT License - see the [LICENSE](_media/LICENSE) file for details.
