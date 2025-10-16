# @have/logger

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Structured logging for HAVE SDK with signal adapter integration and configurable log levels.

## Overview

The `@have/logger` package provides a lightweight, structured logging system designed for the HAVE SDK. It offers a clean interface for logging with multiple severity levels, structured metadata support, and seamless integration with the SMRT framework's signal system for automatic operation tracking.

## Key Features

- **Simple API**: Four log levels (debug, info, warn, error) with consistent interface
- **Structured Logging**: Attach machine-readable metadata to every log entry
- **Level Filtering**: Only output logs that meet the configured severity threshold
- **Signal Integration**: Automatic logging of SMRT framework operations via LoggerAdapter
- **Zero Dependencies**: Minimal footprint with only internal HAVE SDK dependencies
- **TypeScript First**: Full type safety with TypeScript definitions
- **Configurable**: Enable/disable logging or adjust log levels at runtime
- **No-op Mode**: Completely disable logging with zero overhead

## Installation

```bash
# Install with npm
npm install @have/logger

# Or with pnpm
pnpm add @have/logger

# Or with yarn
yarn add @have/logger
```

## Quick Start

```typescript
import { createLogger } from '@have/logger';

// Create logger with info level (default)
const logger = createLogger(true);

// Log messages
logger.info('Application started');
logger.debug('Loading configuration'); // Not output (below 'info')
logger.warn('High memory usage detected', { memoryMB: 512 });
logger.error('Failed to connect to database', {
  error: 'ECONNREFUSED',
  host: 'localhost',
  port: 5432
});

// Disable logging completely
const noopLogger = createLogger(false);
noopLogger.info('This message is discarded'); // No output, zero overhead
```

## Usage

### Creating Loggers

The `createLogger` factory function provides multiple ways to create logger instances:

```typescript
import { createLogger } from '@have/logger';

// Simple boolean configuration
const logger1 = createLogger(true);  // Console logger with 'info' level
const logger2 = createLogger(false); // No-op logger (all logs discarded)

// Configure with specific log level
const debugLogger = createLogger({ level: 'debug' }); // Show everything
const infoLogger = createLogger({ level: 'info' });   // Info and above
const warnLogger = createLogger({ level: 'warn' });   // Warnings and errors
const errorLogger = createLogger({ level: 'error' }); // Errors only
```

### Log Levels

Log levels determine which messages are output based on severity:

| Level | Purpose | Example Use Cases |
|-------|---------|-------------------|
| **debug** | Verbose development information | Function entry/exit, variable values, detailed traces |
| **info** | Normal operational messages | Application startup, configuration loaded, requests processed |
| **warn** | Potential issues that don't prevent operation | Deprecated API usage, high resource usage, retryable errors |
| **error** | Failures and exceptions | Database connection failed, API errors, uncaught exceptions |

**Level Hierarchy**: `debug < info < warn < error`

When you set a log level, all messages at that level or higher are output:

```typescript
const logger = createLogger({ level: 'warn' });

logger.debug('Debug message');  // ❌ Not output (below 'warn')
logger.info('Info message');    // ❌ Not output (below 'warn')
logger.warn('Warning message'); // ✅ Output
logger.error('Error message');  // ✅ Output
```

### Basic Logging

Each log method accepts a message and optional context object:

```typescript
const logger = createLogger({ level: 'debug' });

// Simple messages
logger.debug('Entering processData()');
logger.info('Server started on port 3000');
logger.warn('API key not configured');
logger.error('Failed to save user');

// Messages with structured context
logger.info('User logged in', {
  userId: '123',
  email: 'user@example.com',
  ip: '192.168.1.1'
});

logger.error('Database query failed', {
  query: 'SELECT * FROM users',
  error: 'Connection timeout',
  duration: 5000
});

logger.debug('Cache hit', {
  key: 'user:123',
  ttl: 3600,
  size: 1024
});
```

**Output Format**:
```
[DEBUG] Entering processData()
[INFO] Server started on port 3000
[WARN] API key not configured
[ERROR] Failed to save user
[INFO] User logged in {"userId":"123","email":"user@example.com","ip":"192.168.1.1"}
[ERROR] Database query failed {"query":"SELECT * FROM users","error":"Connection timeout","duration":5000}
[DEBUG] Cache hit {"key":"user:123","ttl":3600,"size":1024}
```

### Direct Logger Instantiation

For more control, use the ConsoleLogger class directly:

```typescript
import { ConsoleLogger } from '@have/logger';

const logger = new ConsoleLogger('debug');

logger.info('Application started');
logger.debug('Detailed debugging information');
```

### Signal Adapter Integration

Integrate with the SMRT framework's signal system for automatic operation logging:

```typescript
import { createLogger, LoggerAdapter } from '@have/logger';
import { SignalBus } from '@have/smrt';

// Create logger
const logger = createLogger({ level: 'info' });

// Create signal adapter
const loggerAdapter = new LoggerAdapter(logger);

// Register with signal bus
const signalBus = new SignalBus();
signalBus.register(loggerAdapter);

// Now all SMRT operations automatically emit log messages
// Example signal logs:
// [DEBUG] Product.save() started {"id":"sig-123","objectId":"prod-456","className":"Product","method":"save"}
// [INFO] Product.save() completed in 42ms {"id":"sig-123","objectId":"prod-456","className":"Product","method":"save","duration":42,"result":"present"}
```

**Signal Type Mapping**:
| Signal Type | Log Level | Message Format |
|-------------|-----------|----------------|
| `start` | debug | `{className}.{method}() started` |
| `step` | debug | `{className}.{method}() step: {stepName}` |
| `end` | info | `{className}.{method}() completed in {duration}ms` |
| `error` | error | `{className}.{method}() failed: {errorMessage}` |

## Advanced Usage

### Structured Logging Best Practices

Use context objects to add machine-readable metadata:

```typescript
// ✅ GOOD - Structured context for easy parsing
logger.error('Payment failed', {
  userId: '123',
  orderId: 'ord-456',
  amount: 99.99,
  currency: 'USD',
  error: 'insufficient_funds',
  timestamp: new Date().toISOString()
});

// ❌ BAD - Unstructured string (hard to parse)
logger.error(`Payment failed for user 123, order ord-456, amount $99.99: insufficient_funds`);
```

**Benefits of Structured Logging**:
- Easy to parse by log aggregation tools (Elasticsearch, Splunk, etc.)
- Filterable by specific fields
- Queryable for analytics
- Machine-readable for automated alerting

### Conditional Logging

Avoid expensive operations for logs that won't be output:

```typescript
const logger = createLogger({ level: 'info' });

// ❌ BAD - Expensive operation runs even when debug is disabled
logger.debug('User data: ' + JSON.stringify(getUserData(), null, 2));

// ✅ GOOD - Only compute if debug level is enabled
if (logger.debug) {
  const userData = getUserData();
  logger.debug('User data', { userData });
}

// ✅ EVEN BETTER - Use lazy context evaluation
logger.debug('User data', () => ({ userData: getUserData() }));
```

### Error Logging

Log errors with full context for debugging:

```typescript
try {
  await database.query('SELECT * FROM users');
} catch (error) {
  logger.error('Database query failed', {
    error: {
      message: error.message,
      name: error.name,
      stack: error.stack
    },
    query: 'SELECT * FROM users',
    timestamp: Date.now()
  });
  throw error; // Re-throw if needed
}
```

### Environment-Based Configuration

Adjust log levels based on environment:

```typescript
const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug'
});

// Development: Shows all logs including debug
// Production: Only shows info, warn, and error
```

### Multiple Logger Instances

Create specialized loggers for different parts of your application:

```typescript
const httpLogger = createLogger({ level: 'info' });
const dbLogger = createLogger({ level: 'warn' }); // Only warnings and errors
const cacheLogger = createLogger({ level: 'debug' }); // Verbose debugging

httpLogger.info('HTTP request received', { method: 'GET', path: '/api/users' });
dbLogger.warn('Slow query detected', { duration: 1500, query: 'SELECT * FROM ...' });
cacheLogger.debug('Cache miss', { key: 'user:123' });
```

### Custom Logger Implementation

Implement the Logger interface for custom backends:

```typescript
import type { Logger } from '@have/logger';

class FileLogger implements Logger {
  constructor(private filePath: string) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.writeLog('DEBUG', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.writeLog('INFO', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.writeLog('WARN', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.writeLog('ERROR', message, context);
  }

  private writeLog(
    level: string,
    message: string,
    context?: Record<string, unknown>
  ): void {
    const entry = {
      level,
      message,
      context,
      timestamp: new Date().toISOString()
    };
    // Write to file, database, remote service, etc.
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
  }
}

// Use custom logger
const logger = new FileLogger('./app.log');
logger.info('Application started');
```

## Common Patterns

### Request Logging

Log HTTP requests with structured metadata:

```typescript
app.use((req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const level = res.statusCode >= 500 ? 'error' :
                 res.statusCode >= 400 ? 'warn' : 'info';

    logger[level](`${req.method} ${req.path}`, {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      userAgent: req.get('user-agent'),
      ip: req.ip
    });
  });

  next();
});
```

### Operation Tracking

Track multi-step operations:

```typescript
async function processOrder(orderId: string) {
  logger.info('Processing order', { orderId, step: 'start' });

  try {
    logger.debug('Validating order', { orderId, step: 'validate' });
    await validateOrder(orderId);

    logger.debug('Charging payment', { orderId, step: 'payment' });
    await chargePayment(orderId);

    logger.debug('Updating inventory', { orderId, step: 'inventory' });
    await updateInventory(orderId);

    logger.info('Order processed successfully', { orderId, step: 'complete' });
  } catch (error) {
    logger.error('Order processing failed', {
      orderId,
      step: 'error',
      error: error.message
    });
    throw error;
  }
}
```

### Performance Monitoring

Log performance metrics:

```typescript
async function expensiveOperation() {
  const startTime = Date.now();

  try {
    const result = await performOperation();
    const duration = Date.now() - startTime;

    if (duration > 1000) {
      logger.warn('Slow operation detected', {
        operation: 'expensiveOperation',
        duration,
        threshold: 1000
      });
    } else {
      logger.debug('Operation completed', {
        operation: 'expensiveOperation',
        duration
      });
    }

    return result;
  } catch (error) {
    logger.error('Operation failed', {
      operation: 'expensiveOperation',
      duration: Date.now() - startTime,
      error: error.message
    });
    throw error;
  }
}
```

### Aggregation-Friendly Logging

Structure logs for easy aggregation and analysis:

```typescript
// User action tracking
logger.info('user_action', {
  action: 'login',
  userId: '123',
  success: true,
  timestamp: Date.now()
});

// Business metrics
logger.info('business_metric', {
  metric: 'order_completed',
  value: 299.99,
  currency: 'USD',
  category: 'electronics',
  timestamp: Date.now()
});

// System metrics
logger.info('system_metric', {
  metric: 'memory_usage',
  value: 512,
  unit: 'MB',
  threshold: 1024,
  timestamp: Date.now()
});

// Easy to query in log aggregation systems:
// - Filter by action type: `action:login`
// - Sum order values: `SUM(value) WHERE metric:order_completed`
// - Alert on high memory: `value > threshold WHERE metric:memory_usage`
```

## Integration Examples

### Express.js Middleware

```typescript
import express from 'express';
import { createLogger } from '@have/logger';

const logger = createLogger({ level: 'info' });
const app = express();

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    logger.info('HTTP request', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: Date.now() - start
    });
  });

  next();
});

app.listen(3000, () => {
  logger.info('Server started', { port: 3000 });
});
```

### SMRT Framework

```typescript
import { SmrtObject } from '@have/smrt';
import { createLogger, LoggerAdapter } from '@have/logger';

// Create logger
const logger = createLogger({ level: 'debug' });

class Product extends SmrtObject {
  name: string = '';
  price: number = 0;

  async save() {
    logger.debug('Saving product', {
      id: this.id,
      name: this.name,
      price: this.price
    });

    const result = await super.save();

    logger.info('Product saved', {
      id: this.id,
      success: true
    });

    return result;
  }
}

// Automatic logging via signal adapter
const signalBus = new SignalBus();
signalBus.register(new LoggerAdapter(logger));
```

### Worker Threads

```typescript
import { Worker } from 'worker_threads';
import { createLogger } from '@have/logger';

const logger = createLogger({ level: 'info' });

const worker = new Worker('./worker.js');

worker.on('message', (message) => {
  logger.info('Worker message received', {
    type: message.type,
    data: message.data
  });
});

worker.on('error', (error) => {
  logger.error('Worker error', {
    error: error.message,
    stack: error.stack
  });
});

worker.on('exit', (code) => {
  logger.info('Worker exited', { code });
});
```

## TypeScript Support

Full TypeScript definitions with type safety:

```typescript
import type { Logger, LogLevel, LoggerConfig } from '@have/logger';

// Typed logger interface
const logger: Logger = createLogger({ level: 'info' });

// Typed log level
const level: LogLevel = 'debug';

// Typed configuration
const config: LoggerConfig = { level: 'warn' };
const boolConfig: LoggerConfig = true;

// Context type safety
interface UserContext {
  userId: string;
  email: string;
  role: 'admin' | 'user';
}

const context: UserContext = {
  userId: '123',
  email: 'user@example.com',
  role: 'admin'
};

logger.info('User logged in', context);
```

## Performance Considerations

1. **Use appropriate log levels**: Set higher thresholds in production
2. **Avoid expensive context computation**: Use lazy evaluation for debug logs
3. **Disable logging in hot paths**: Use no-op logger (`createLogger(false)`)
4. **Limit context size**: Don't log large objects or binary data
5. **Use structured context**: Better for parsing and querying than string concatenation

## Comparison with Other Logging Libraries

| Feature | @have/logger | winston | pino | bunyan |
|---------|--------------|---------|------|--------|
| Zero Config | ✅ | ❌ | ❌ | ❌ |
| TypeScript | ✅ | ⚠️ | ✅ | ⚠️ |
| Structured Logging | ✅ | ✅ | ✅ | ✅ |
| Signal Integration | ✅ | ❌ | ❌ | ❌ |
| Bundle Size | 2KB | 230KB | 14KB | 100KB |
| Performance | Fast | Medium | Fastest | Medium |
| Transports | Console only | Many | Many | Many |
| Learning Curve | Minimal | Steep | Medium | Medium |

**When to use @have/logger**:
- Building with HAVE SDK (native signal integration)
- Need simple, structured logging without complexity
- Want minimal bundle size and dependencies
- Prefer TypeScript-first design

**When to use alternatives**:
- Need advanced features (file rotation, remote transports, etc.)
- Require maximum performance (pino)
- Need extensive ecosystem (winston)

## API Reference

See the [API documentation](https://happyvertical.github.io/sdk/modules/_have_logger.html) for detailed information on all available methods and options.

## Contributing

Contributions are welcome! Please see the [SDK Contributing Guide](../../../CONTRIBUTING.md) for details.

## License

This package is part of the HAVE SDK and is licensed under the MIT License - see the [LICENSE](../../../LICENSE) file for details.
