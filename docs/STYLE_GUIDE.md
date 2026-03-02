# TypeScript Style Guide

This style guide establishes naming conventions and coding standards for the HAppy VErtical SDK, based on the official TypeScript, Google, and Microsoft style guides.

## Core Principle

**Names should not encode type information that is already present in the type system.**

TypeScript provides strong type information through its type system, making decorative prefixes and suffixes redundant and potentially misleading.

## Naming Conventions

### Interfaces

**Convention**: `PascalCase` without prefixes

```typescript
// ✅ Good
interface CacheProvider {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

interface User {
  id: string;
  name: string;
}

// ❌ Bad
interface ICacheProvider { }  // Unnecessary "I" prefix
interface UserInterface { }   // Redundant "Interface" suffix
```

**Rationale**:
- The `I` prefix is a holdover from languages that don't have first-class interfaces (C#, Java)
- TypeScript's type system makes the distinction between interfaces and types unnecessary in names
- The official TypeScript lib.d.ts uses `Window`, `Document`, `Promise`, not `IWindow`, etc.
- Modern style guides (Google, Microsoft, ts.dev) explicitly recommend against prefixes

### Classes

**Convention**: `PascalCase`

```typescript
// ✅ Good
class HttpClient { }
class UserService { }
class DatabaseConnection { }

// ❌ Bad
class httpClient { }        // Wrong casing
class CHttpClient { }        // Unnecessary prefix
```

### Type Aliases

**Convention**: `PascalCase`

```typescript
// ✅ Good
type UserId = string;
type CacheOptions = MemoryOptions | FileOptions | RedisOptions;
type RequestHandler<T> = (req: Request) => Promise<T>;

// ❌ Bad
type userId = string;        // Wrong casing
type TUserId = string;       // Unnecessary prefix
```

### Enums

**Convention**: `PascalCase` for enum name, `CONSTANT_CASE` for values

```typescript
// ✅ Good
enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

enum Status {
  ACTIVE,
  INACTIVE,
  PENDING,
}

// ❌ Bad
enum logLevel { }            // Wrong casing
enum LogLevel {
  debug = 'debug',           // Wrong casing for values
}
```

### Functions and Methods

**Convention**: `camelCase`

```typescript
// ✅ Good
function getUserById(id: string): User { }
function calculateTotal(items: Item[]): number { }

class Service {
  getData(): Data { }
  processRequest(req: Request): void { }
}

// ❌ Bad
function GetUserById() { }   // Wrong casing
function get_user_by_id() { } // Snake case
```

### Variables and Parameters

**Convention**: `camelCase`

```typescript
// ✅ Good
const userName = 'John';
let itemCount = 0;
const maxRetries = 3;

function processUser(userId: string, userData: UserData) {
  const currentUser = getCurrentUser();
}

// ❌ Bad
const UserName = 'John';     // Wrong casing
const user_name = 'John';    // Snake case
const opt_timeout = 5000;    // Unnecessary prefix
```

### Constants (Module-Level)

**Convention**: `CONSTANT_CASE` for truly immutable values

```typescript
// ✅ Good
const MAX_RETRY_COUNT = 5;
const DEFAULT_TIMEOUT = 30000;
const API_BASE_URL = 'https://api.example.com';

// For configuration objects, use camelCase
const defaultOptions = {
  timeout: 5000,
  retries: 3,
};

// ❌ Bad
const maxRetryCount = 5;     // Use CONSTANT_CASE for top-level constants
const Max_Retry_Count = 5;   // Mixed case
```

### Type Parameters

**Convention**: Single uppercase letter or `PascalCase`

```typescript
// ✅ Good
function map<T, U>(items: T[], fn: (item: T) => U): U[] { }
function process<TInput, TOutput>(input: TInput): TOutput { }

interface Cache<TValue> {
  get(key: string): TValue | undefined;
}

// ❌ Bad
function map<t, u>() { }     // Wrong casing
interface Cache<valueType> { } // Wrong casing
```

### Private Fields

**Convention**: Use `private` keyword, not naming conventions

```typescript
// ✅ Good
class Service {
  private connection: Connection;
  private apiKey: string;

  public getData() { }
}

// ❌ Bad
class Service {
  _connection: Connection;   // Don't use underscore
  #apiKey: string;          // Avoid # private fields (use 'private' keyword)
}
```

### Boolean Variables

**Convention**: Use is/has/should prefix with `camelCase`

```typescript
// ✅ Good
const isValid = true;
const hasPermission = false;
const shouldRetry = true;
const canEdit = checkPermissions();

// ❌ Bad
const valid = true;          // Missing prefix
const permission = false;    // Ambiguous
```

## File Naming

**Convention**: `kebab-case` for files, matching the primary export

```typescript
// File: user-service.ts
export class UserService { }

// File: cache-provider.ts
export interface CacheProvider { }

// File: index.ts (barrel file)
export * from './user-service';
export * from './cache-provider';
```

## Import Aliases

**Convention**: `camelCase` for namespace imports

```typescript
// ✅ Good
import * as fs from 'node:fs';
import * as fooBar from './foo-bar';

// ❌ Bad
import * as FS from 'node:fs';
import * as foo_bar from './foo-bar';
```

## Migration Strategy

### For Existing Code

When renaming interfaces that are part of the public API:

1. **Major Version Bump Required**: Interface renames are breaking changes
2. **Update Exports**: Ensure all barrel files export the new names
3. **Update Imports**: Update all internal imports across packages
4. **Update Tests**: Update test files with new interface names
5. **Update Documentation**: Update README, SPEC, and JSDoc comments
6. **Run Full Test Suite**: Verify all changes compile and tests pass

### Example Migration

```typescript
// Before
export interface ICacheProvider {
  get<T>(key: string): Promise<T | undefined>;
}

class MemoryCache implements ICacheProvider {
  // implementation
}

// After
export interface CacheProvider {
  get<T>(key: string): Promise<T | undefined>;
}

class MemoryCache implements CacheProvider {
  // implementation
}
```

## Automated Enforcement

This style guide is enforced through Biome's `useNamingConvention` rule. See `biome.json` for configuration.

## References

- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- [TypeScript Official Style Guide (ts.dev)](https://ts.dev/style/)
- [Microsoft TypeScript Coding Guidelines](https://github.com/microsoft/TypeScript/wiki/Coding-guidelines)
- [Biome Naming Convention Rule](https://biomejs.dev/linter/rules/use-naming-convention/)

## Summary

| Type | Convention | Example |
|------|-----------|---------|
| Interfaces | `PascalCase` | `CacheProvider` |
| Classes | `PascalCase` | `HttpClient` |
| Type Aliases | `PascalCase` | `UserId` |
| Enums | `PascalCase` / `CONSTANT_CASE` | `enum Status { ACTIVE }` |
| Functions | `camelCase` | `getUserById` |
| Variables | `camelCase` | `userName` |
| Constants | `CONSTANT_CASE` | `MAX_SIZE` |
| Type Parameters | `T` or `PascalCase` | `<T>`, `<TValue>` |
| Files | `kebab-case` | `user-service.ts` |

---

*Last Updated: 2025-10-17*
