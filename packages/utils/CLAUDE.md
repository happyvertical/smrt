# @have/utils: Foundational Utility Functions Package

## Purpose and Responsibilities

The `@have/utils` package provides foundational utility functions used throughout the HAVE SDK. It serves as the base dependency for most other packages and is designed to be the lowest-level package in the dependency hierarchy with **zero internal HAVE SDK dependencies**.

### Core Functionality

- **Unique ID generation**: CUID2 (default) and UUID generation for different use cases
- **String manipulation**: URL-safe slug generation, case conversions, and recursive key transformations
- **Date handling**: Date parsing from filenames, formatting, Amazon date strings, and date-fns integration
- **Path operations**: URL path extraction and temporary directory handling
- **Type checking**: Safe type guards with TypeScript type narrowing for arrays, objects, and URLs
- **Async utilities**: Polling functions with timeout support and sleep utilities
- **Error handling**: Structured error classes with context, timestamps, and error codes
- **Logging**: Configurable global logging system with console and no-op implementations
- **Text utilities**: Pluralization/singularization with English grammar rules

This package is intentionally lightweight, uses Node.js-only builds (no browser target), and focuses on providing pure, testable utility functions that form the foundation of the entire SDK.

### Architecture Notes

- **Build Target**: Node.js-only (ES2022+), no browser support
- **Module Format**: ESM only with preserved module structure for tree-shaking
- **Dependency Strategy**: Minimal external dependencies, zero internal SDK dependencies
- **Type Safety**: Full TypeScript support with generated declaration files

**Expert Agent Expertise**: When working with this package, always proactively check the latest documentation for foundational libraries (@paralleldrive/cuid2, date-fns, pluralize, uuid) as they frequently add new features, performance improvements, and API changes that can enhance utility implementations.

## Key APIs

### ID Generation

```typescript
import { makeId, createId, isCuid } from '@have/utils';

// Generate a CUID2 by default (more secure and collision-resistant than UUID)
const id = makeId(); // "ckx5f8h3z0000qzrmn831i7rn"

// Alternative: Direct CUID2 creation (re-exported from @paralleldrive/cuid2)
const cuidId = createId(); // Same as makeId() without type param

// Generate UUID when needed for RFC4122 compliance
const uuid = makeId('uuid'); // "f47ac10b-58cc-4372-a567-0e02b2c3d479"

// Validate CUID2 identifiers
if (isCuid(id)) {
  console.log('Valid CUID2');
}

// Implementation details:
// - CUID2 by default (better entropy, security, and collision resistance)
// - UUID fallback uses crypto.randomUUID() or manual implementation
// - CUID2 is sortable and more suitable for distributed systems
```

### Slug Generation

```typescript
import { makeSlug } from '@have/utils';

// Convert strings to URL-friendly slugs
const slug = makeSlug("My Example Title & Co."); // "my-example-title-38-co"
const blogSlug = makeSlug("Understanding AI/ML Models"); // "understanding-ai-ml-models"

// Handles international characters (extensive character mapping)
const intlSlug = makeSlug("Café España"); // "cafe-espana"

// Implementation details:
// - Converts to lowercase
// - Ampersands become "-38-" for uniqueness
// - International characters normalized (àáâäæã → a, etc.)
// - Special characters removed or replaced with hyphens
// - Multiple hyphens collapsed to single hyphen
// - Leading/trailing hyphens removed
```

### Path Utilities

```typescript
import { urlPath, urlFilename, getTempDirectory } from '@have/utils';

// Extract path components from URLs (hostname + pathname)
const urlPathString = urlPath("https://example.com/path/to/resource");
// Returns: "example.com/path/to/resource"

// Get filename from URL (last pathname segment)
const filename = urlFilename("https://example.com/path/to/file.pdf");
// Returns: "file.pdf"

const indexFile = urlFilename("https://example.com/path/");
// Returns: "index.html" (default when no filename present)

// Get temporary directory (Node.js environment variables)
const tempPath = getTempDirectory(); // "/tmp/.have-sdk"
const cacheDir = getTempDirectory("cache"); // "/tmp/.have-sdk/cache"

// Environment variable resolution order:
// process.env.TMPDIR → process.env.TMP → process.env.TEMP → "/tmp"
```

### String Case Conversions

```typescript
import { camelCase, snakeCase, keysToCamel, keysToSnake } from '@have/utils';

// Convert individual strings
const camelString = camelCase("some-string-here"); // "someStringHere"
const snakeString = snakeCase("someStringHere"); // "some_string_here"

// Transform object keys recursively
const apiResponse = {
  user_name: "john",
  user_details: {
    first_name: "John",
    last_name: "Doe",
    contact_info: ["email@example.com"]
  }
};

const camelCaseObj = keysToCamel(apiResponse);
// Result: { userName: "john", userDetails: { firstName: "John", ... } }

const snakeCaseObj = keysToSnake({ userName: "john", userDetails: {...} });
// Converts back to snake_case structure
```

### Date Utilities

```typescript
import { dateInString, prettyDate, parseAmazonDateString } from '@have/utils';

// Extract dates from filenames (useful for processing files)
const date = dateInString("Report_January_15_2023.pdf");
// Returns: Date object for January 15, 2023

const date2 = dateInString("financial-report-dec-2023.pdf");
// Returns: Date object for December 2023

// Format dates in human-readable format
const formatted = prettyDate("2023-01-15T12:00:00Z");
// Returns: "January 15, 2023" (localized)

// Parse Amazon date strings (for AWS integrations)
const awsDate = parseAmazonDateString('20220223T215409Z');
// Returns: Date object for February 23, 2022, 21:54:09 UTC
```

### Async Utilities

```typescript
import { waitFor, sleep } from '@have/utils';

// Wait for a condition with timeout and custom delay
await waitFor(
  async () => {
    const result = await checkSomeCondition();
    return result?.isReady ? result : undefined;
  },
  { timeout: 10000, delay: 500 }
);

// Simple sleep utility
await sleep(1000); // Wait 1 second

// Polling example for file operations
await waitFor(
  async () => {
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    return fileExists;
  },
  { timeout: 30000, delay: 1000 }
);
```

### Type Checking

```typescript
import { isArray, isPlainObject, isUrl } from '@have/utils';

// Safe type guards
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

// URL validation
const userInput = "https://example.com";
if (isUrl(userInput)) {
  // Safe to use as URL
  const url = new URL(userInput);
}
```

### Error Handling

```typescript
import { 
  ValidationError, 
  NetworkError, 
  TimeoutError, 
  ParsingError 
} from '@have/utils';

// Structured error handling with context
function validateUserInput(input: string) {
  if (!input || input.length < 3) {
    throw new ValidationError('Input too short', {
      input,
      minLength: 3,
      actualLength: input?.length || 0
    });
  }
}

// Network operations with context
async function fetchData(url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new NetworkError('HTTP error', {
        status: response.status,
        statusText: response.statusText,
        url
      });
    }
    return response.json();
  } catch (error) {
    if (error instanceof NetworkError) {
      console.error('Network issue:', error.toJSON());
    }
    throw error;
  }
}
```

### Logging

```typescript
import { getLogger, setLogger, disableLogging } from '@have/utils';

// Use default console logger
const logger = getLogger();
logger.info('Processing started', { userId: 123 });
logger.error('Process failed', { error: 'Connection timeout', retryCount: 3 });

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

### Utility Functions

```typescript
import { logTicker, domainToCamel } from '@have/utils';

// Visual progress indicator
let tick = null;
setInterval(() => {
  tick = logTicker(tick);
  process.stdout.write(`\rProcessing ${tick}`);
}, 500);
// Outputs: "Processing ." → "Processing .." → "Processing ..." → repeats

// Domain string conversion
const camelDomain = domainToCamel("api-service"); // "apiService"
```

## Dependencies

The package has carefully selected minimal external dependencies:

### External Dependencies
- **@paralleldrive/cuid2** (^2.2.2): Secure, collision-resistant ID generation
  - More secure and readable than UUIDs
  - Optimized for distributed systems and horizontal scaling
  - Cryptographically secure with multiple entropy sources

- **date-fns** (^3.3.1): Modern JavaScript date utility library
  - Comprehensive date manipulation and formatting
  - Tree-shakable for minimal bundle size
  - Better timezone support than native Date

- **pluralize** (^8.0.0): English word pluralization
  - Handles singular/plural transformations
  - Customizable rules for edge cases
  - Used for generating readable API responses

- **uuid** (^9.0.1): RFC4122 UUID generation
  - Industry standard for unique identifiers
  - Multiple UUID versions (v1, v4, v5, etc.)
  - Fallback option for environments needing RFC compliance

### Internal Dependencies
None - this package is the foundation layer with no internal HAVE SDK dependencies.

## Module Structure

The package uses a simple, flat export structure:

```
src/
├── index.ts                    # Main entry point (re-exports from shared/)
└── shared/
    ├── index.ts               # Re-exports all modules
    ├── universal.ts           # Core utilities (ID, strings, dates, async)
    ├── logger.ts              # Logging system
    └── types.ts               # Error classes and interfaces
```

### Key Implementation Details

**ID Generation** (`universal.ts`):
- `makeId()`: Defaults to CUID2, accepts 'cuid2' or 'uuid' parameter
- `createId()`: Direct re-export of cuid2CreateId from @paralleldrive/cuid2
- `isCuid()`: Validates CUID2 format
- UUID fallback: Uses `crypto.randomUUID()` or manual implementation

**String Utilities** (`universal.ts`):
- `makeSlug()`: Extensive international character mapping
- `camelCase()`: Handles kebab-case, snake_case, and spaces
- `snakeCase()`: Handles camelCase, kebab-case, and spaces
- `keysToCamel()` / `keysToSnake()`: Recursive object key transformation
- `domainToCamel()`: Convenience wrapper for camelCase

**Date Utilities** (`universal.ts`):
- `dateInString()`: Extracts dates from filenames using month/year patterns
- `prettyDate()`: Uses Intl.DateTimeFormat for locale-aware formatting
- `parseAmazonDateString()`: Parses YYYYMMDDTHHMMSSZ format
- date-fns re-exports: `formatDate()`, `parseDate()`, `isValidDate()`, `addInterval()`

**Pluralization** (`universal.ts`):
- Re-exports from pluralize library: `pluralizeWord`, `singularize`, `isPlural`, `isSingular`

**Type Guards** (`universal.ts`):
- `isArray()`: TypeScript type narrowing to `unknown[]`
- `isPlainObject()`: Narrows to `Record<string, unknown>`
- `isUrl()`: Validates URL format using URL constructor

**Async Utilities** (`universal.ts`):
- `sleep()`: Promise-based delay
- `waitFor()`: Polls async function until defined value or timeout
- `logTicker()`: Cycles through character array for progress indicators

**Error System** (`types.ts`):
- Base class: `BaseError` with code, context, timestamp, and `toJSON()`
- Specific errors: `ValidationError`, `ApiError`, `FileError`, `NetworkError`, `DatabaseError`, `ParsingError`, `TimeoutError`
- Error codes enum: `ErrorCode` with standardized values

**Logging System** (`logger.ts`):
- Global logger pattern with `getLogger()` / `setLogger()`
- Implementations: `ConsoleLogger` (default), `NoOpLogger` (for disabling)
- Interface: `Logger` with debug, info, warn, error methods
- Helpers: `disableLogging()`, `enableLogging()`

## Development Guidelines

### Build Configuration

The package uses Vite with specific Node.js-only configuration:

- **Target**: ES2022, ESM format only
- **Module Preservation**: Maintains source structure for tree-shaking
- **External Dependencies**: All dependencies marked as external (not bundled)
- **Type Generation**: vite-plugin-dts with preserved structure
- **No Minification**: Library code kept readable

**Important**: This is a Node.js-only package. The previous browser/Node.js dual-target architecture has been removed.

### Adding New Utilities

When adding utilities:

1. **Node.js-first**: Write functions targeting Node.js environment (no browser support)
2. **Pure functions**: Prefer stateless functions for predictable behavior
3. **Type safety**: Provide full TypeScript types with JSDoc documentation
4. **Error handling**: Use structured error classes with context
5. **Test coverage**: Write comprehensive tests with edge cases

### ID Generation Strategy

**CUID2 vs UUID Guidelines**:
- **Use makeId() or createId() (CUID2 default)** for:
  - User-facing identifiers (shorter, more readable)
  - Distributed systems requiring collision resistance
  - When security and unpredictability are priorities
  - Database primary keys with sortable requirement
  - High-performance scenarios

- **Use makeId('uuid')** for:
  - Internal system identifiers needing RFC4122 compliance
  - Legacy system integration requiring UUID format
  - External APIs expecting UUID format
  - When standardization is more important than security

**Performance Note**: CUID2 provides better collision resistance and entropy than UUID v4.

### Error Handling Patterns

```typescript
// Always provide context in custom errors
throw new ValidationError('Invalid email format', {
  email: userInput,
  pattern: EMAIL_REGEX.toString(),
  validExamples: ['user@example.com', 'test@domain.org']
});

// Use specific error types for better error handling
try {
  const result = await parseData(input);
} catch (error) {
  if (error instanceof ParsingError) {
    // Handle parsing-specific issues
    logger.warn('Data parsing failed', error.context);
  } else if (error instanceof ValidationError) {
    // Handle validation issues
    return { success: false, errors: [error.message] };
  } else {
    // Handle unexpected errors
    throw error;
  }
}
```

### Testing

The package includes comprehensive tests using Vitest:

```bash
npm test              # Run tests once (uses vitest)
npm run test:watch    # Run tests in watch mode
npm run dev           # Run build:watch and test:watch in parallel
```

**Testing Guidelines**:
- Focus on Node.js environment (no browser testing needed)
- Include edge cases and error conditions
- Test async utilities with various timeout scenarios
- Verify type guards work correctly with TypeScript
- Test error context serialization

**Test Coverage** (from `index.spec.ts`):
- ID generation: CUID2 validation, UUID format verification
- Pluralization: pluralizeWord, singularize, isPlural, isSingular
- Date utilities: formatDate, parseDate, isValidDate, addInterval
- Async utilities: waitFor with timeouts, sleep
- Amazon date parsing

### Building

Build the package with Node.js-only output:

```bash
npm run build         # Build with Vite (ESM output)
npm run build:watch   # Build in watch mode
npm run clean         # Remove dist/ and docs/ directories
```

**Build Outputs**:
- `dist/`: Compiled JavaScript and TypeScript declarations
- Module structure preserved for tree-shaking
- Source maps generated for debugging

### Performance Considerations

- **Function purity**: Keep utilities stateless for predictable performance
- **Memoization**: Consider caching for expensive operations called frequently
- **Bundle size**: Minimize dependencies and prefer tree-shakable implementations
- **Memory usage**: Clean up resources in async utilities
- **Type guards**: Use efficient type checking methods

### Best Practices

- **Single responsibility**: Each utility should do one thing well
- **Predictable behavior**: Functions should handle edge cases gracefully
- **TypeScript first**: Provide strong types for all parameters and returns
- **Documentation**: Use JSDoc for complex functions and edge cases
- **Error messages**: Provide clear, actionable error messages with context
- **Version compatibility**: Consider backward compatibility when updating APIs

## Common Patterns and Gotchas

### Object Key Transformations

```typescript
// Recursive transformation of nested objects
const apiData = {
  user_id: 123,
  user_profile: {
    first_name: "John",
    contact_emails: ["john@example.com"]
  }
};

const normalized = keysToCamel(apiData);
// Result: { userId: 123, userProfile: { firstName: "John", contactEmails: [...] } }

// Arrays are preserved and processed recursively
const dataArray = [{ user_name: "jane" }, { user_name: "john" }];
keysToCamel(dataArray); // [{ userName: "jane" }, { userName: "john" }]
```

**Gotcha**: Primitive values pass through unchanged. Only objects and arrays are transformed.

### Date Extraction from Strings

```typescript
// Works with various filename formats
dateInString("report-january-15-2023.pdf");  // Date(2023, 0, 15)
dateInString("Statement_Dec_2022.pdf");       // Date(2022, 11, 1)
dateInString("Q4-2023-summary.pdf");          // null (no month name)

// Month names must be spelled out (full or abbreviated)
// Year must be in format "20XX"
// Day is optional (defaults to 1st)
```

**Gotcha**: Requires both year (20XX format) and month name. Returns null if either is missing.

### Wait For Pattern

```typescript
// Polling with timeout
const result = await waitFor(
  async () => {
    const status = await checkStatus();
    // Return undefined to continue polling
    // Return any other value to resolve
    return status.ready ? status : undefined;
  },
  { timeout: 10000, delay: 500 }
);

// No timeout (polls indefinitely until defined value)
await waitFor(asyncCheck, { timeout: 0, delay: 1000 });
```

**Gotcha**: Function must return `undefined` explicitly to continue polling. Returning `null`, `false`, or `0` will resolve the promise.

### Error Context Serialization

```typescript
try {
  throw new NetworkError('Connection failed', {
    url: 'https://api.example.com',
    attempt: 3,
    lastError: new Error('ECONNREFUSED')
  });
} catch (error) {
  if (error instanceof BaseError) {
    // Full error context as JSON
    console.log(JSON.stringify(error.toJSON()));

    // Access structured fields
    console.log(error.code);      // 'NETWORK_ERROR'
    console.log(error.context);   // { url, attempt, lastError }
    console.log(error.timestamp); // Date object
  }
}
```

**Gotcha**: Context can include any serializable data. Non-serializable objects (like Error instances) may not serialize cleanly to JSON.

### Logger Swapping

```typescript
// Default console logger
const logger = getLogger();
logger.info('Starting');

// Disable in production
if (process.env.NODE_ENV === 'production') {
  disableLogging();
}

// Custom implementation
class StructuredLogger implements Logger {
  info(msg: string, ctx?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: 'info', msg, ...ctx }));
  }
  // ... other methods
}

setLogger(new StructuredLogger());
```

**Gotcha**: Logger is global and affects all packages using `@have/utils`. Set it once at application startup.

### Slug Generation Edge Cases

```typescript
makeSlug("Hello & World");           // "hello-38-world" (& → -38-)
makeSlug("Multiple   Spaces");       // "multiple-spaces" (collapsed)
makeSlug("Trailing-Hyphens---");     // "trailing-hyphens" (trimmed)
makeSlug("Über Café");               // "uber-cafe" (normalized)
makeSlug("product/category");        // "product-category" (/ → -)
```

**Gotcha**: Ampersands become "-38-" for uniqueness. This is intentional to avoid ambiguity with HTML entities.

## Quick Reference

### Frequently Used Exports

```typescript
// ID Generation
import { makeId, createId, isCuid } from '@have/utils';

// String Manipulation
import { makeSlug, camelCase, snakeCase, keysToCamel, keysToSnake } from '@have/utils';

// Date Utilities
import { dateInString, prettyDate, formatDate, parseDate, addInterval } from '@have/utils';

// Path & URL
import { urlPath, urlFilename, getTempDirectory, isUrl } from '@have/utils';

// Type Guards
import { isArray, isPlainObject } from '@have/utils';

// Async Utilities
import { sleep, waitFor } from '@have/utils';

// Error Handling
import {
  ValidationError, ApiError, FileError, NetworkError,
  DatabaseError, ParsingError, TimeoutError
} from '@have/utils';

// Logging
import { getLogger, setLogger, disableLogging, enableLogging } from '@have/utils';

// Pluralization
import { pluralizeWord, singularize, isPlural, isSingular } from '@have/utils';
```

## API Documentation

The package generates comprehensive TypeDoc documentation in markdown format:

### Generating Documentation

```bash
npm run docs        # Generate markdown docs in packages/utils/docs/
npm run docs:watch  # Watch mode for development
```

**Documentation Location**: `packages/utils/docs/`

### Documentation Structure

- **Modules**: Organized by source file (universal, logger, types)
- **Functions**: Full JSDoc with parameters, returns, and examples
- **Classes**: Error classes with inheritance chain
- **Interfaces**: Logger interface with method signatures
- **Enums**: ErrorCode with all values

The documentation is generated with:
- Private and internal members excluded
- Type information preserved
- Cross-references to related functions
- Example usage from JSDoc comments

## Documentation Links

Always reference the latest documentation when planning utility implementations, as these libraries frequently add new features and performance improvements:

### Core Libraries

- **@paralleldrive/cuid2**: [NPM Package](https://www.npmjs.com/package/@paralleldrive/cuid2) | [GitHub](https://github.com/paralleldrive/cuid2)
  - Next-generation CUID with improved collision resistance
  - Check for new configuration options and security enhancements

- **date-fns**: [Official Documentation](https://date-fns.org/) | [GitHub](https://github.com/date-fns/date-fns)
  - Modern JavaScript date utility library
  - Monitor for new timezone handling features and locale support

- **pluralize**: [NPM Package](https://www.npmjs.com/package/pluralize) | [GitHub](https://github.com/plurals/pluralize)
  - English word pluralization utilities
  - Review for new language rules and custom rule support

- **uuid**: [NPM Package](https://www.npmjs.com/package/uuid) | [GitHub](https://github.com/uuidjs/uuid)
  - RFC4122 UUID generation
  - Check for new UUID versions and performance improvements

### Expert Agent Instructions

When working with @have/utils:

1. **Always check latest documentation** before implementing solutions using WebFetch tool
2. **Stay current with API changes** - utility libraries evolve to improve performance
3. **Review new features** that could simplify common operations
4. **Check for breaking changes** in major version updates
5. **Look for security updates** especially for ID generation libraries

Example workflow:
```typescript
// Before implementing a date solution, check latest docs
await WebFetch.get('https://date-fns.org/docs/latest');
// Then implement with current best practices
import { format, parseISO } from 'date-fns';
```

## Cross-Package Integration

As the foundational package, @have/utils is used throughout the SDK:

### Common Integration Patterns

```typescript
// @have/files: Path and ID utilities
import { makeSlug, urlFilename, makeId } from '@have/utils';
const filename = `${makeSlug(title)}_${makeId()}.${extension}`;

// @have/ai: Error handling and logging
import { NetworkError, TimeoutError, getLogger } from '@have/utils';
const logger = getLogger();
logger.info('AI request started', { model: 'gpt-4' });

// @have/spider: URL utilities and async operations
import { isUrl, waitFor, sleep, urlPath } from '@have/utils';
await waitFor(async () => await crawl(url), { timeout: 30000 });

// @have/sql: Key transformations for data normalization
import { keysToCamel, keysToSnake } from '@have/utils';
const row = keysToCamel(dbResult); // snake_case → camelCase

// @have/smrt: Comprehensive utility usage
import { createId, formatDate, ValidationError } from '@have/utils';
const collectionId = createId();
```

### Integration Best Practices

1. **Error Handling**: Use structured error classes for consistent error reporting
2. **Logging**: Set logger once at application startup for all packages
3. **Key Normalization**: Transform API/database keys consistently
4. **ID Generation**: Use CUID2 for user-facing IDs, UUID for RFC compliance
5. **Type Safety**: Leverage type guards for runtime type checking

### Performance Characteristics

- **Stateless Design**: All utilities are pure functions (no side effects)
- **Tree-Shakable**: ESM with preserved modules enables dead code elimination
- **Minimal Overhead**: No internal dependencies, lightweight external deps
- **Optimized Common Cases**: String operations and type guards are fast-path
- **Async Safety**: Proper cleanup and timeout handling in async utilities

### Dependency Graph Position

```
@have/utils (foundation - no internal deps)
    ↓
All other packages depend on utils:
- @have/files
- @have/sql
- @have/ocr
- @have/pdf
- @have/ai
- @have/spider
- @have/smrt (depends on all above)
```

This package provides the essential building blocks that enable all other HAVE SDK packages to function reliably with consistent behavior and error handling patterns.