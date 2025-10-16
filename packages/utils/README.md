# @have/utils

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Foundation utilities for ID generation, date parsing, URL handling, string conversion, error handling, and logging used across the HAVE SDK.

## Overview

The `@have/utils` package provides core utilities that serve as the foundation for all other HAVE SDK packages. It offers essential functionality with minimal dependencies, focusing on pure, testable functions that work reliably across different environments.

## Features

- **ID Generation**: CUID2 and UUID generation with validation
- **URL Utilities**: Filename extraction and path manipulation
- **String Conversion**: Case conversion (camelCase, snake_case) with object key transformation
- **Date Utilities**: Amazon date parsing, filename date extraction, and formatting
- **Type Guards**: Safe type checking for arrays, objects, and URLs
- **Async Utilities**: Polling with timeout and sleep functions
- **Error Handling**: Structured error classes with context
- **Logging**: Configurable logging system with console and no-op implementations
- **General Utilities**: Progress indicators and domain string conversion

## Installation

```bash
# Install with bun (recommended)
bun add @have/utils

# Or with npm
npm install @have/utils

# Or with yarn
yarn add @have/utils
```

## Usage

### ID Generation

```typescript
import { makeId, createId, isCuid } from '@have/utils';

// Generate CUID2 (default, more secure than UUID)
const id = makeId(); // "ckx5f8h3z0000qzrmn831i7rn"

// Generate UUID when needed for RFC4122 compliance
const uuid = makeId('uuid'); // "f47ac10b-58cc-4372-a567-0e02b2c3d479"

// Direct CUID2 generation
const cuid = createId(); // "ckx5f8h3z0000qzrmn831i7rn"

// Validate CUID2
if (isCuid(id)) {
  console.log('Valid CUID2 format');
}
```

### URL Utilities

```typescript
import { urlFilename, urlPath, makeSlug, isUrl } from '@have/utils';

// Extract filename from URL
const filename = urlFilename("https://example.com/path/file.pdf"); // "file.pdf"

// Convert URL to file path
const path = urlPath("https://example.com/path/to/resource");
// "example.com/path/to/resource"

// Create URL-friendly slugs
const slug = makeSlug("My Example Title & Co."); // "my-example-title-38-co"

// Validate URLs
if (isUrl(userInput)) {
  const url = new URL(userInput); // Safe to use
}
```

### String Case Conversion

```typescript
import {
  camelCase,
  snakeCase,
  keysToCamel,
  keysToSnake,
  domainToCamel
} from '@have/utils';

// Convert individual strings
const camelString = camelCase("hello-world"); // "helloWorld"
const snakeString = snakeCase("helloWorld"); // "hello_world"

// Transform object keys recursively
const apiResponse = {
  user_name: "john",
  user_details: { first_name: "John", last_name: "Doe" }
};

const camelCaseObj = keysToCamel(apiResponse);
// { userName: "john", userDetails: { firstName: "John", lastName: "Doe" } }

const snakeCaseObj = keysToSnake(camelCaseObj);
// Back to original snake_case structure

// Convert domain strings
const domain = domainToCamel("api-service"); // "apiService"
```

### Date Utilities

```typescript
import {
  dateInString,
  prettyDate,
  parseAmazonDateString,
  formatDate,
  parseDate,
  addInterval
} from '@have/utils';

// Extract dates from filenames
const date = dateInString("Report_January_15_2023.pdf");
// Returns Date object for January 15, 2023

// Human-readable formatting
const formatted = prettyDate("2023-01-15T12:00:00Z");
// "January 15, 2023" (localized)

// Parse Amazon date format
const awsDate = parseAmazonDateString('20220223T215409Z');
// Date object for February 23, 2022, 21:54:09 UTC

// Enhanced date formatting and manipulation (using date-fns)
const today = new Date();
const formatted2 = formatDate(today, 'yyyy-MM-dd'); // "2023-01-15"
const parsed = parseDate('2023-01-15'); // Date object
const nextWeek = addInterval(today, { days: 7 }); // Date 7 days from now
```

### Type Guards

```typescript
import { isArray, isPlainObject } from '@have/utils';

function processData(data: unknown) {
  if (isArray(data)) {
    // TypeScript knows data is unknown[]
    data.forEach(item => console.log(item));
  }

  if (isPlainObject(data)) {
    // TypeScript knows data is Record<string, unknown>
    Object.keys(data).forEach(key => console.log(key, data[key]));
  }
}
```

### Async Utilities

```typescript
import { waitFor, sleep } from '@have/utils';

// Wait for a condition with timeout
const result = await waitFor(
  async () => {
    const ready = await checkSomeCondition();
    return ready ? ready : undefined; // Return undefined to keep polling
  },
  { timeout: 10000, delay: 500 }
);

// Simple sleep utility
await sleep(1000); // Wait 1 second
```

### Error Handling

```typescript
import {
  ValidationError,
  NetworkError,
  TimeoutError,
  ParsingError,
  FileError,
  ApiError,
  DatabaseError
} from '@have/utils';

// Structured errors with context
function validateEmail(email: string) {
  if (!email.includes('@')) {
    throw new ValidationError('Invalid email format', {
      email,
      field: 'userEmail',
      validationRule: 'must contain @'
    });
  }
}

// Network operations with context
try {
  const response = await fetch(url);
  if (!response.ok) {
    throw new NetworkError('HTTP error', {
      status: response.status,
      statusText: response.statusText,
      url
    });
  }
} catch (error) {
  if (error instanceof NetworkError) {
    console.error('Network issue:', error.toJSON());
  }
}
```

### Logging

```typescript
import { getLogger, setLogger, disableLogging } from '@have/utils';

// Use default console logger
const logger = getLogger();
logger.info('Process started', { userId: 123 });
logger.error('Process failed', { error: 'timeout', attempt: 3 });

// Disable logging in production
if (process.env.NODE_ENV === 'production') {
  disableLogging();
}

// Custom logger implementation
class CustomLogger implements Logger {
  info(message: string, context?: Record<string, unknown>) {
    // Send to external logging service
    logService.send({ level: 'info', message, context });
  }
  // ... implement other methods
}

setLogger(new CustomLogger());
```

### Text Pluralization

```typescript
import { pluralizeWord, singularize, isPlural, isSingular } from '@have/utils';

// Pluralize English words
pluralizeWord("cat"); // "cats"
pluralizeWord("mouse"); // "mice"
singularize("cats"); // "cat"

// Check word forms
isPlural("cats"); // true
isSingular("cat"); // true
```

### Utility Functions

```typescript
import { logTicker, getTempDirectory } from '@have/utils';

// Visual progress indicator
let tick = null;
setInterval(() => {
  tick = logTicker(tick);
  process.stdout.write(`\\rProcessing ${tick}`);
}, 500);
// Outputs: "Processing ." → "Processing .." → "Processing ..." → repeats

// Cross-platform temp directory
const tempDir = getTempDirectory("my-cache");
// "/tmp/.have-sdk/my-cache" or platform equivalent
```

## API Reference

### Functions

**ID Generation**
- `makeId(type?: 'cuid2' | 'uuid')` - Generate CUID2 or UUID
- `createId()` - Generate CUID2 directly
- `isCuid(id: string)` - Validate CUID2 format

**URL Utilities**
- `urlFilename(url: string)` - Extract filename from URL
- `urlPath(url: string)` - Convert URL to file path
- `makeSlug(str: string)` - Create URL-friendly slug
- `isUrl(str: string)` - Validate URL format

**String Conversion**
- `camelCase(str: string)` - Convert to camelCase
- `snakeCase(str: string)` - Convert to snake_case
- `keysToCamel(obj: unknown)` - Transform object keys to camelCase
- `keysToSnake(obj: unknown)` - Transform object keys to snake_case
- `domainToCamel(domain: string)` - Convert domain string to camelCase

**Date Utilities**
- `dateInString(str: string)` - Extract date from filename/string
- `prettyDate(dateString: string)` - Human-readable date format
- `parseAmazonDateString(dateStr: string)` - Parse AWS date format
- `formatDate(date: Date | string, format?: string)` - Format date with pattern
- `parseDate(dateStr: string, format?: string)` - Parse date string
- `addInterval(date: Date, duration: Duration)` - Add time interval to date

**Type Guards**
- `isArray(obj: unknown)` - Check if value is array
- `isPlainObject(obj: unknown)` - Check if value is plain object

**Async Utilities**
- `waitFor(fn: () => Promise<any>, options?)` - Poll until condition met
- `sleep(duration: number)` - Promise-based delay

**Logging**
- `getLogger()` - Get current logger instance
- `setLogger(logger: Logger)` - Set custom logger
- `disableLogging()` - Disable all logging
- `enableLogging()` - Re-enable console logging

**Text Processing**
- `pluralizeWord(word: string)` - Pluralize English word
- `singularize(word: string)` - Convert to singular form
- `isPlural(word: string)` - Check if word is plural
- `isSingular(word: string)` - Check if word is singular

**Utilities**
- `logTicker(tick: string | null, options?)` - Progress indicator
- `getTempDirectory(subfolder?: string)` - Cross-platform temp path

### Error Classes

All error classes extend `BaseError` and include context and timestamps:

- `ValidationError` - Input validation failures
- `ApiError` - API request/response errors
- `FileError` - File system operation errors
- `NetworkError` - Network connectivity errors
- `DatabaseError` - Database operation errors
- `ParsingError` - Data parsing errors
- `TimeoutError` - Operation timeout errors

### Interfaces

- `Logger` - Logging interface (debug, info, warn, error methods)

## Dependencies

- `@paralleldrive/cuid2` - Secure, collision-resistant ID generation
- `date-fns` - Modern JavaScript date utility library
- `pluralize` - English word pluralization
- `uuid` - RFC4122 UUID generation (fallback)

## License

This package is part of the HAVE SDK and is licensed under the MIT License - see the [LICENSE](../../LICENSE) file for details.