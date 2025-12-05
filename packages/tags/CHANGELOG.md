# @happyvertical/smrt-tags

## 0.17.22

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.22

## 0.17.21

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.21

## 0.17.20

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.20

## 0.17.19

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.19

## 0.17.18

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.18

## 0.17.17

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.17

## 0.17.16

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.16

## 0.17.15

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.15

## 0.17.14

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.14

## 0.17.13

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.13

## 0.17.12

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.12

## 0.17.11

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.11

## 0.17.10

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.10

## 0.17.9

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.9

## 0.17.8

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.8

## 0.17.7

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.7

## 0.17.6

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.6

## 0.17.5

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.5

## 0.17.4

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.4

## 0.17.3

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.3

## 0.17.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.2

## 0.17.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.17.1

## 0.17.0

### Patch Changes

- Updated dependencies [620e56b]
  - @happyvertical/smrt-core@0.17.0

## 0.16.5

### Patch Changes

- caf593b: feat(build): auto-generate test-manifest-stub.ts from dist/manifest.json

  Ensures test manifest stubs stay in sync with generated manifests.
  Fixes #373 - Event.seriesId now correctly marked as optional.

  - @happyvertical/smrt-core@0.16.5

## 0.16.4

### Patch Changes

- @happyvertical/smrt-core@0.16.4

## 0.16.3

### Patch Changes

- 721e5b9: - fix(ci): auto-generate changesets in PR workflow
  - fix(core): implement build-time field inheritance for STI classes
- Updated dependencies [721e5b9]
  - @happyvertical/smrt-core@0.16.3

## 0.16.2

### Patch Changes

- Updated dependencies [c2b3b49]
- Updated dependencies [c04f2ba]
- Updated dependencies [5fd254f]
- Updated dependencies [5643895]
  - @happyvertical/smrt-core@0.16.2

## 0.16.1

### Patch Changes

- Updated dependencies [fadeb11]
  - @happyvertical/smrt-core@0.16.1

## 0.16.0

### Patch Changes

- @happyvertical/smrt-core@0.16.0

## 0.15.5

### Patch Changes

- Updated dependencies [dc292b5]
  - @happyvertical/smrt-core@0.15.5

## 0.15.4

### Patch Changes

- Updated dependencies [c084e42]
  - @happyvertical/smrt-core@0.15.4

## 0.15.3

### Patch Changes

- Updated dependencies [802adf9]
  - @happyvertical/smrt-core@0.15.3

## 0.15.2

### Patch Changes

- Updated dependencies [05b705c]
  - @happyvertical/smrt-core@0.15.2

## 0.15.1

### Patch Changes

- Updated dependencies [370ed46]
  - @happyvertical/smrt-core@0.15.1

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

- Updated dependencies [e46b272]
  - @happyvertical/smrt-core@0.15.0

## 0.14.7

### Patch Changes

- 43b53ee: feat(all): add tableStrategy: 'sti' to all SMRT framework classes

  Enables Single Table Inheritance (STI) across all SMRT packages by adding `tableStrategy: 'sti'` to all @smrt() decorated classes. This allows subclasses to properly share parent tables instead of creating separate tables for each subclass.

  **Packages updated (17 classes total):**

  **assets** (3 classes):

  - AssetStatus
  - AssetType
  - AssetMetafield

  **events** (3 classes):

  - EventSeries
  - EventType
  - EventParticipant

  **places** (1 class):

  - PlaceType

  **tags** (1 class):

  - TagAlias

  **content** (3 classes):

  - Article (STI subclass - now explicit)
  - ContentDocument (STI subclass - now explicit)
  - Mirror (STI subclass - now explicit)

  **products** (1 class):

  - Category

  **profiles** (7 classes):

  - ProfileType
  - ProfileMetafield
  - ProfileMetadata
  - ProfileRelationshipType
  - Person (STI subclass - now explicit)
  - Organization (STI subclass - now explicit)
  - Bot (STI subclass - now explicit)

  **Impact:**

  - All base classes now support STI for subclasses
  - STI subclasses now explicitly declare `tableStrategy: 'sti'` for clarity
  - Consistent STI support across entire SMRT framework
  - Enables proper inheritance hierarchies throughout the ecosystem

  **Related issues:**

  - #310 - ProfileRelationshipTerm missing STI
  - #298 - STI subclass table creation issues
  - #301 - AST Scanner STI discovery

  This change provides a foundation for consistent STI usage across all SMRT-based applications and ensures subclasses can properly leverage single-table inheritance patterns.

  - @happyvertical/smrt-core@0.14.7

## 0.14.6

### Patch Changes

- @happyvertical/smrt-core@0.14.6

## 0.14.5

### Patch Changes

- @happyvertical/smrt-core@0.14.5

## 0.14.4

### Patch Changes

- Updated dependencies [5435c00]
  - @happyvertical/smrt-core@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [f0051a4]
  - @happyvertical/smrt-core@0.14.3

## 0.14.2

### Patch Changes

- dedf98e: - fix(ci): add 30-second delay before enabling auto-merge on version PR
- Updated dependencies [dedf98e]
  - @happyvertical/smrt-core@0.14.2

## 0.14.1

### Patch Changes

- Updated dependencies [294e58f]
  - @happyvertical/smrt-core@0.14.1

## 0.14.0

### Minor Changes

- c45b560: - feat(all): implement multi-level class inheritance support (#247)

### Patch Changes

- Updated dependencies [c45b560]
  - @happyvertical/smrt-core@0.14.0

## 0.13.7

### Patch Changes

- febac3c: - chore(core): update SDK dependency and remove DuckDB workaround
  - fix(core): implement lazy database table initialization to prevent prerendering crashes
  - fix(ci): resolve issue triage authentication error
- Updated dependencies [febac3c]
  - @happyvertical/smrt-core@0.13.7

## 0.13.6

### Patch Changes

- 5160664: - fix(ci): resolve issue triage authentication error
- Updated dependencies [5160664]
  - @happyvertical/smrt-core@0.13.6

## 0.13.5

### Patch Changes

- Updated dependencies [7706d2b]
  - @happyvertical/smrt-core@0.13.5

## 0.13.4

### Patch Changes

- 3f46832: - chore(all): update @happyvertical dependencies
- 505a835: Make pretest scripts resilient to CLI not being built yet

  The pretest script now checks if `../cli/dist/index.js` exists before trying to run it, allowing tests to pass in scenarios where packages aren't built yet (like the cascade handler workflow). This uses the pattern `[ -f file ] && command || true` which silently succeeds if the CLI isn't available, while still running manifest generation when it is.

- Updated dependencies [3f46832]
  - @happyvertical/smrt-core@0.13.4

## 0.13.3

### Patch Changes

- 9adec16: Add --passWithNoTests flag to test scripts for packages without test files

  Packages that don't yet have test files now use `vitest run --passWithNoTests` instead of `vitest run`, allowing CI to pass while we incrementally add tests. This fixes the test suite failures caused by vitest exiting with code 1 when no tests are found.

  - @happyvertical/smrt-core@0.13.3

## 0.13.2

### Patch Changes

- e7fc0d0: - chore(all): update @happyvertical dependencies
- Updated dependencies [e7fc0d0]
  - @happyvertical/smrt-core@0.13.2

## 0.13.1

### Patch Changes

- @happyvertical/smrt-core@0.13.1

## 0.13.0

### Minor Changes

- 8b35bce: - feat(all): save aggregated manifest for CLI discovery (#215)

### Patch Changes

- Updated dependencies [8b35bce]
- Updated dependencies [f620cd9]
  - @happyvertical/smrt-core@0.13.0

## 0.12.0

### Minor Changes

- 6d80cc4: - test(all): remove flaky default export test (#215)
  - feat(all): integrate dynamic class loader into CLI (#215)
  - feat(all): add dynamic class loader for external packages (#215)
  - feat(all): update consumer plugin to preserve package metadata (#215)
  - feat(all): enhance manifest schema with package metadata (#215)

### Patch Changes

- Updated dependencies [6d80cc4]
  - @happyvertical/smrt-core@0.12.0

## 0.11.1

### Patch Changes

- 538c597: - fix(all): use GH_TOKEN for package access in cascade workflow
- Updated dependencies [538c597]
  - @happyvertical/smrt-core@0.11.1

## 0.11.0

### Minor Changes

- 4bf5d82: - feat(all): add automated dependency cascade workflow

### Patch Changes

- Updated dependencies [4bf5d82]
  - @happyvertical/smrt-core@0.11.0

## 0.10.4

### Patch Changes

- Updated dependencies [192a86f]
  - @happyvertical/smrt-core@0.10.4

## 0.10.3

### Patch Changes

- Updated dependencies [2e5cab1]
  - @happyvertical/smrt-core@0.10.3

## 0.10.2

### Patch Changes

- b3be399: - fix(all): exclude protected and private properties from database schema
- Updated dependencies [b3be399]
  - @happyvertical/smrt-core@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies [be1be8f]
  - @happyvertical/smrt-core@0.10.1

## 0.10.0

### Minor Changes

- c6d8f52: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [c6d8f52]
  - @happyvertical/smrt-core@0.10.0

## 0.9.0

### Minor Changes

- 85c671b: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [85c671b]
  - @happyvertical/smrt-core@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [fb98c3a]
  - @happyvertical/smrt-core@0.8.1

## 0.8.0

### Patch Changes

- @happyvertical/smrt-core@0.8.0

## 0.7.0

### Minor Changes

- 51c388a: - feat(generators): expose custom methods by default without explicit include
  - fix(cli): load manifest at runtime to populate ObjectRegistry

### Patch Changes

- Updated dependencies [51c388a]
  - @happyvertical/smrt-core@0.7.0

## 0.5.8

### Patch Changes

- f0d34b0: - docs(all): add comprehensive custom method discovery documentation
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

- Updated dependencies [f0d34b0]
- Updated dependencies [7c1de77]
  - @happyvertical/smrt-core@0.6.0

## 0.5.7

### Patch Changes

- f9019e6: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [f9019e6]
  - @happyvertical/smrt-core@0.5.7

## 0.5.6

### Patch Changes

- Updated dependencies [708a6ab]
  - @happyvertical/smrt-core@0.5.6

## 0.5.5

### Patch Changes

- 694e1da: - fix(manifest): capture package name during registration for external packages
- Updated dependencies [694e1da]
  - @happyvertical/smrt-core@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies [1129a5a]
  - @happyvertical/smrt-core@0.5.4

## 0.5.3

### Patch Changes

- @happyvertical/smrt-core@0.5.3

## 0.5.2

### Patch Changes

- 905bdf4: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [905bdf4]
  - @happyvertical/smrt-core@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [3663a95]
  - @happyvertical/smrt-core@0.5.1

## 0.5.0

### Minor Changes

- 007567e: - feat(all): add local SDK development setup scripts

### Patch Changes

- Updated dependencies [6d322c8]
- Updated dependencies [007567e]
  - @happyvertical/smrt-core@0.5.0

## 0.4.2

### Patch Changes

- dfce003: Enable GitHub Package Registry publishing for all SMRT packages

  - Add @happyvertical scope to .npmrc for GitHub Package Registry
  - Configure authentication with GITHUB_TOKEN
  - All packages now publish to https://npm.pkg.github.com/@happyvertical/*

- Updated dependencies [dfce003]
  - @happyvertical/smrt-core@0.4.2
