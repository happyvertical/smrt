# @happyvertical/smrt-core

## 0.15.0

### Minor Changes

- e46b272: # BREAKING: Decorator Migration - Field Helpers Removed

  This release introduces `@field()` decorators as the **only** pattern for defining SMRT object properties. **Field helper functions have been completely removed** from the codebase.

  ## ✨ New Features

  ### Property Decorators

  ```typescript
  import { SmrtObject, smrt, field } from "@happyvertical/smrt-core";

  @smrt()
  class Product extends SmrtObject {
    // Decorator for constrained fields
    @field({ required: true })
    name: string = "";

    // TypeScript types for simple fields
    description: string = "";
    price: number = 0.0; // DECIMAL (has decimal point)
    quantity: number = 0; // INTEGER (no decimal point)
    active: boolean = true;
    tags: string[] = [];
    createdAt: Date = new Date();
  }
  ```

  ### Benefits

  - **Better IDE Support**: Full IntelliSense and type checking
  - **Cleaner Syntax**: More readable and maintainable code
  - **TypeScript-First**: Leverages native TypeScript types
  - **Automatic Schema Generation**: AST scanner infers database types from TypeScript

  ## 🔄 Changes

  ### All Domain Packages Migrated

  - **@happyvertical/smrt-profiles**: All models now use decorators
  - **@happyvertical/smrt-places**: Migrated to decorators
  - **@happyvertical/smrt-events**: EventType and related models updated
  - **@happyvertical/smrt-tags**: Tag and TagAlias migrated
  - **@happyvertical/smrt-content**: Content model updated

  ### MCP Code Generators Updated

  - `generate-smrt-class` tool now generates decorator-based code by default
  - `generate-field-definitions` tool updated to use decorators
  - All generated code follows modern TypeScript patterns

  ### Core Improvements

  - AST scanner automatically marks `oneToMany`/`manyToMany` fields as transient
  - Optimized object initialization for decorator-based classes
  - Added `ObjectRegistry.hasFieldDecorators()` helper method

  ## 📚 Migration Guide

  ### Before (Field Helpers)

  ```typescript
  import {
    SmrtObject,
    smrt,
    text,
    integer,
    decimal,
  } from "@happyvertical/smrt-core";

  @smrt()
  class Product extends SmrtObject {
    name = text({ required: true });
    quantity = integer();
    price = decimal();
  }
  ```

  ### After (Decorators)

  ```typescript
  import { SmrtObject, smrt, field } from "@happyvertical/smrt-core";

  @smrt()
  class Product extends SmrtObject {
    @field({ required: true })
    name: string = "";

    quantity: number = 0; // INTEGER
    price: number = 0.0; // DECIMAL
  }
  ```

  ## 💥 BREAKING CHANGES

  **Field helpers have been completely removed:**

  - ❌ `text()`, `integer()`, `decimal()`, `boolean()`, `datetime()`, `json()` - DELETED
  - ❌ `import { text } from '@happyvertical/smrt-core/fields'` - Will throw error
  - ✅ Use `@field()` decorator or plain TypeScript properties instead

  **Why this is better:**

  - 🧹 **Cleaner codebase** - Removed 20KB+ of legacy code
  - 🚀 **Better performance** - No Field instance overhead
  - 🤖 **AI-friendly** - Less noise, clearer patterns for agentic coders
  - 📚 **Simpler mental model** - One way to define fields, not two

  ## 📖 Documentation

  All framework documentation has been updated to show decorators as the primary pattern, with field helpers documented as a legacy alternative.

  See [CLAUDE.md](./CLAUDE.md) for complete migration guide and best practices.

### Patch Changes

- @happyvertical/smrt-config@0.15.0
- @happyvertical/smrt-types@0.15.0

## 0.14.7

### Patch Changes

- @happyvertical/smrt-config@0.14.7
- @happyvertical/smrt-types@0.14.7

## 0.14.6

### Patch Changes

- @happyvertical/smrt-config@0.14.6
- @happyvertical/smrt-types@0.14.6

## 0.14.5

### Patch Changes

- @happyvertical/smrt-config@0.14.5
- @happyvertical/smrt-types@0.14.5

## 0.14.4

### Patch Changes

- 5435c00: - fix(core): enable preserveModules to match package.json exports
  - @happyvertical/smrt-config@0.14.4
  - @happyvertical/smrt-types@0.14.4

## 0.14.3

### Patch Changes

- f0051a4: - fix(core): enable preserveModules to match package.json exports
  - @happyvertical/smrt-config@0.14.3
  - @happyvertical/smrt-types@0.14.3

## 0.14.2

### Patch Changes

- dedf98e: - fix(ci): add 30-second delay before enabling auto-merge on version PR
- Updated dependencies [dedf98e]
  - @happyvertical/smrt-config@0.14.2
  - @happyvertical/smrt-types@0.14.2

## 0.14.1

### Patch Changes

- 294e58f: - fix(core): use sync config accessor instead of async loadConfig
  - @happyvertical/smrt-config@0.14.1
  - @happyvertical/smrt-types@0.14.1

## 0.14.0

### Minor Changes

- c45b560: - feat(all): implement multi-level class inheritance support (#247)

### Patch Changes

- Updated dependencies [c45b560]
  - @happyvertical/smrt-config@0.14.0
  - @happyvertical/smrt-types@0.14.0

## 0.13.7

### Patch Changes

- febac3c: - chore(core): update SDK dependency and remove DuckDB workaround
  - fix(core): implement lazy database table initialization to prevent prerendering crashes
  - fix(ci): resolve issue triage authentication error
- Updated dependencies [febac3c]
  - @happyvertical/smrt-types@0.13.7

## 0.13.6

### Patch Changes

- 5160664: - fix(ci): resolve issue triage authentication error
- Updated dependencies [5160664]
  - @happyvertical/smrt-types@0.13.6

## 0.13.5

### Patch Changes

- 7706d2b: Fix TypeScript build errors preventing successful compilation

  - **core**: Add explicit return type to `mockCollectionConstructors` method to resolve vitest type inference error
  - **smrt-dev-mcp**: Use type assertions for MCP tool arguments and remove unused variable
  - **assets**: Correct parameter order in `db.upsert` call (unique columns before data)
  - @happyvertical/smrt-types@0.13.5

## 0.13.4

### Patch Changes

- 3f46832: - chore(all): update @happyvertical dependencies
- Updated dependencies [3f46832]
  - @happyvertical/smrt-types@0.13.4

## 0.13.3

### Patch Changes

- @happyvertical/smrt-types@0.13.3

## 0.13.2

### Patch Changes

- e7fc0d0: - chore(all): update @happyvertical dependencies
- Updated dependencies [e7fc0d0]
  - @happyvertical/smrt-types@0.13.2

## 0.13.1

### Patch Changes

- @happyvertical/smrt-types@0.13.1

## 0.13.0

### Minor Changes

- 8b35bce: - feat(all): save aggregated manifest for CLI discovery (#215)

### Patch Changes

- f620cd9: fix(core): pass manifest object name to ObjectRegistry.register()

  Fixes method discovery by ensuring the registry uses the correct manifest key when looking up methods. Previously, `ObjectRegistry.register(Praeco)` used `Praeco.name` ('Praeco' with capital P) to discover manifest, but the manifest stores entries under lowercase keys like 'praeco'. This caused method lookup to fail and prevented custom CLI commands from being generated.

  Now the consumer plugin generates: `ObjectRegistry.register(Praeco, { name: 'praeco' })`

  This ensures `getMethods('praeco')` succeeds and CLI commands like `npx smrt praeco:research` are generated correctly.

- Updated dependencies [8b35bce]
  - @happyvertical/smrt-types@0.13.0

## 0.12.0

### Minor Changes

- 6d80cc4: - test(all): remove flaky default export test (#215)
  - feat(all): integrate dynamic class loader into CLI (#215)
  - feat(all): add dynamic class loader for external packages (#215)
  - feat(all): update consumer plugin to preserve package metadata (#215)
  - feat(all): enhance manifest schema with package metadata (#215)

### Patch Changes

- Updated dependencies [6d80cc4]
  - @happyvertical/smrt-types@0.12.0

## 0.11.1

### Patch Changes

- 538c597: - fix(all): use GH_TOKEN for package access in cascade workflow
- Updated dependencies [538c597]
  - @happyvertical/smrt-types@0.11.1

## 0.11.0

### Minor Changes

- 4bf5d82: - feat(all): add automated dependency cascade workflow

### Patch Changes

- Updated dependencies [4bf5d82]
  - @happyvertical/smrt-types@0.11.0

## 0.10.4

### Patch Changes

- 192a86f: test: add comprehensive tests for issue #208 with JSON, SQLite, and DuckDB adapters
  - @happyvertical/smrt-types@0.10.4

## 0.10.3

### Patch Changes

- 2e5cab1: - fix(core): handle undefined values in optional fields to prevent database errors
  - @happyvertical/smrt-types@0.10.3

## 0.10.2

### Patch Changes

- b3be399: - fix(all): exclude protected and private properties from database schema
- Updated dependencies [b3be399]
  - @happyvertical/smrt-types@0.10.2

## 0.10.1

### Patch Changes

- be1be8f: - fix(core): use SQL standard TIMESTAMP for DuckDB compatibility
  - @happyvertical/smrt-types@0.10.1

## 0.10.0

### Minor Changes

- c6d8f52: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [c6d8f52]
  - @happyvertical/smrt-types@0.10.0

## 0.9.0

### Minor Changes

- 85c671b: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [85c671b]
  - @happyvertical/smrt-types@0.9.0

## 0.8.1

### Patch Changes

- fb98c3a: - fix(cli,core): enable collection constructor discovery for bundled code
  - @happyvertical/smrt-types@0.8.1

## 0.8.0

### Patch Changes

- @happyvertical/smrt-types@0.8.0

## 0.7.0

### Minor Changes

- 51c388a: - feat(generators): expose custom methods by default without explicit include
  - fix(cli): load manifest at runtime to populate ObjectRegistry

### Patch Changes

- Updated dependencies [51c388a]
  - @happyvertical/smrt-types@0.7.0

## 0.6.0

### Minor Changes

- 7c1de77: - feat(core): add getMethods() API to ObjectRegistry for custom method discovery

  - feat(cli): automatically discover and generate CLI commands for custom methods defined on SMRT objects

  Custom methods defined on SMRT objects are now automatically discovered at build time and exposed through the CLI generator. This eliminates the need for manual CLI command configuration for custom methods.

  Example:

  ```typescript
  @smrt({ cli: { include: ["list", "get", "research"] } })
  class Agent extends SmrtObject {
    async research(options: { query: string; depth?: number }) {
      // Custom method automatically gets CLI command:
      // smrt agent:research <id> --query "topic" --depth 5
    }
  }
  ```

### Patch Changes

- f0d34b0: - docs(all): add comprehensive custom method discovery documentation
- Updated dependencies [f0d34b0]
- Updated dependencies [7c1de77]
  - @happyvertical/smrt-types@0.5.5

## 0.5.7

### Patch Changes

- f9019e6: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [f9019e6]
  - @happyvertical/smrt-types@0.5.4

## 0.5.6

### Patch Changes

- 708a6ab: - fix(core): resolve circular dependency in getPackageName

## 0.5.5

### Patch Changes

- 694e1da: - fix(manifest): capture package name during registration for external packages
- Updated dependencies [694e1da]
  - @happyvertical/smrt-types@0.5.3

## 0.5.4

### Patch Changes

- 1129a5a: fix(manifest): complete external package manifest loading

  - Check both src/manifest/test-manifest.json and dist/manifest.json for built packages
  - Use createRequire(process.cwd()) to resolve packages from calling app's context
  - Walk up from package main entry to find package.json and load manifest
  - Fixes manifest loading for external dependencies (e.g., @happyvertical/smrt-events)

  Resolves #159

## 0.5.3

### Patch Changes

- Updated dependencies [b1c4faa]
  - @happyvertical/smrt-types@0.5.2

## 0.5.2

### Patch Changes

- 905bdf4: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [905bdf4]
  - @happyvertical/smrt-types@0.5.1

## 0.5.1

### Patch Changes

- 3663a95: - fix(core): resolve manifest loading issues with published packages

## 0.5.0

### Minor Changes

- 007567e: - feat(all): add local SDK development setup scripts

### Patch Changes

- 6d322c8: - fix(core): increase timeout for LRU cache eviction test
- Updated dependencies [007567e]
  - @happyvertical/smrt-types@0.5.0

## 0.4.2

### Patch Changes

- dfce003: Enable GitHub Package Registry publishing for all SMRT packages

  - Add @happyvertical scope to .npmrc for GitHub Package Registry
  - Configure authentication with GITHUB_TOKEN
  - All packages now publish to https://npm.pkg.github.com/@happyvertical/*

- Updated dependencies [dfce003]
  - @happyvertical/smrt-types@0.4.2
