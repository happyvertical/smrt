# @happyvertical/smrt-cli

## 0.13.6

### Patch Changes

- 5160664: - fix(ci): resolve issue triage authentication error
- Updated dependencies [5160664]
  - @happyvertical/smrt-config@0.13.6
  - @happyvertical/smrt-core@0.13.6
  - @happyvertical/smrt-types@0.13.6

## 0.13.5

### Patch Changes

- Updated dependencies [7706d2b]
  - @happyvertical/smrt-core@0.13.5
  - @happyvertical/smrt-config@0.13.5
  - @happyvertical/smrt-types@0.13.5

## 0.13.4

### Patch Changes

- 3f46832: - chore(all): update @happyvertical dependencies
- Updated dependencies [3f46832]
  - @happyvertical/smrt-config@0.13.4
  - @happyvertical/smrt-core@0.13.4
  - @happyvertical/smrt-types@0.13.4

## 0.13.3

### Patch Changes

- @happyvertical/smrt-config@0.13.3
- @happyvertical/smrt-core@0.13.3
- @happyvertical/smrt-types@0.13.3

## 0.13.2

### Patch Changes

- e7fc0d0: - chore(all): update @happyvertical dependencies
- Updated dependencies [e7fc0d0]
  - @happyvertical/smrt-config@0.13.2
  - @happyvertical/smrt-core@0.13.2
  - @happyvertical/smrt-types@0.13.2

## 0.13.1

### Patch Changes

- 32e5709: fix(cli): support parameterless custom methods without `<id>` requirement

  Methods with no parameters (like `praeco.research()` and `praeco.report()`) no longer incorrectly require an `<id>` argument in CLI commands.

  **The Problem:**
  All custom methods were hardcoded to require an `<id>` parameter:

  ```bash
  npx smrt praeco:research <id>  # ❌ Error: requires ID but shouldn't
  ```

  **The Solution:**

  - Detects method parameter count from manifest (`methodDef.parameters.length`)
  - If parameterless → no `<id>` arg → calls `handleSingletonMethod()`
  - If has parameters → requires `<id>` arg → calls `handleCustomMethod()`

  **New `handleSingletonMethod()`:**

  - Creates fresh instance without database lookup
  - Calls `initialize()` if available
  - Executes method and returns JSON result

  **Examples:**

  ```bash
  npx smrt praeco:research  # ✅ Works now!
  npx smrt praeco:report    # ✅ Works now!
  npx smrt meeting:addDocument <id> <url>  # Still requires <id>
  ```

  This enables replacing workflow TypeScript files with CLI commands in CI/CD:

  ```yaml
  # Before: pnpm workflow:praeco
  # After:
  - run: npx smrt praeco:research
  - run: npx smrt praeco:report
  ```

  Fixes #221

  - @happyvertical/smrt-config@0.13.1
  - @happyvertical/smrt-core@0.13.1
  - @happyvertical/smrt-types@0.13.1

## 0.13.0

### Minor Changes

- 8b35bce: - feat(all): save aggregated manifest for CLI discovery (#215)

### Patch Changes

- 6a7690f: fix(cli): read version from package.json instead of hardcoded '1.0.0'

  The CLI was showing version '1.0.0' regardless of the actual package version. Now it reads the version dynamically from package.json using pure ESM (readFileSync + fileURLToPath), so `smrt version` will correctly show the actual package version (currently 0.12.0).

- c05290a: fix(cli): load manifest before importing register.js to enable method discovery

  **CRITICAL FIX for Phase 3 - Custom Method Commands**

  Custom method commands like `npx smrt praeco:research` were not appearing because the manifest wasn't loaded when `ObjectRegistry.register()` was called during module initialization.

  **The Problem:**

  1. CLI imports `.smrt/register.js`
  2. `register.js` executes: `ObjectRegistry.register(Praeco, { name: 'praeco' })`
  3. `ObjectRegistry.register()` calls `discoverManifestSync('praeco')` to load methods
  4. BUT manifest not loaded yet → returns `undefined` → no methods discovered!

  **The Solution:**
  Now `loadLocalTestManifestSync()` is called BEFORE importing `register.js`, ensuring the manifest is in memory when registration happens. This allows `ObjectRegistry.register()` to find the manifest entry and load method definitions.

  **Impact:**
  Commands like `npx smrt praeco:research <id> --query "..."` should now work after consumers rebuild with this version.

- Updated dependencies [8b35bce]
- Updated dependencies [f620cd9]
  - @happyvertical/smrt-config@0.13.0
  - @happyvertical/smrt-core@0.13.0
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
  - @happyvertical/smrt-config@0.12.0
  - @happyvertical/smrt-core@0.12.0
  - @happyvertical/smrt-types@0.12.0

## 0.11.1

### Patch Changes

- 538c597: - fix(all): use GH_TOKEN for package access in cascade workflow
- Updated dependencies [538c597]
  - @happyvertical/smrt-config@0.11.1
  - @happyvertical/smrt-core@0.11.1
  - @happyvertical/smrt-types@0.11.1

## 0.11.0

### Minor Changes

- 4bf5d82: - feat(all): add automated dependency cascade workflow

### Patch Changes

- Updated dependencies [4bf5d82]
  - @happyvertical/smrt-config@0.11.0
  - @happyvertical/smrt-core@0.11.0
  - @happyvertical/smrt-types@0.11.0

## 0.10.4

### Patch Changes

- Updated dependencies [192a86f]
  - @happyvertical/smrt-core@0.10.4
  - @happyvertical/smrt-config@0.10.4
  - @happyvertical/smrt-types@0.10.4

## 0.10.3

### Patch Changes

- Updated dependencies [2e5cab1]
  - @happyvertical/smrt-core@0.10.3
  - @happyvertical/smrt-config@0.10.3
  - @happyvertical/smrt-types@0.10.3

## 0.10.2

### Patch Changes

- b3be399: - fix(all): exclude protected and private properties from database schema
- Updated dependencies [b3be399]
  - @happyvertical/smrt-config@0.10.2
  - @happyvertical/smrt-core@0.10.2
  - @happyvertical/smrt-types@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies [be1be8f]
  - @happyvertical/smrt-core@0.10.1
  - @happyvertical/smrt-config@0.10.1
  - @happyvertical/smrt-types@0.10.1

## 0.10.0

### Minor Changes

- c6d8f52: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [c6d8f52]
  - @happyvertical/smrt-config@0.10.0
  - @happyvertical/smrt-core@0.10.0
  - @happyvertical/smrt-types@0.10.0

## 0.9.0

### Minor Changes

- 85c671b: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [85c671b]
  - @happyvertical/smrt-config@0.9.0
  - @happyvertical/smrt-core@0.9.0
  - @happyvertical/smrt-types@0.9.0

## 0.8.1

### Patch Changes

- fb98c3a: - fix(cli,core): enable collection constructor discovery for bundled code
- Updated dependencies [fb98c3a]
  - @happyvertical/smrt-core@0.8.1
  - @happyvertical/smrt-config@0.8.1
  - @happyvertical/smrt-types@0.8.1

## 0.8.0

### Minor Changes

- a095a1d: - feat(cli): integrate smrt-config for CLI configuration
  - feat(cli): dynamically import user's compiled classes for runtime execution

### Patch Changes

- @happyvertical/smrt-config@0.8.0
- @happyvertical/smrt-core@0.8.0
- @happyvertical/smrt-types@0.8.0

## 0.7.0

### Minor Changes

- 51c388a: - feat(generators): expose custom methods by default without explicit include
  - fix(cli): load manifest at runtime to populate ObjectRegistry

### Patch Changes

- Updated dependencies [51c388a]
  - @happyvertical/smrt-core@0.7.0
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
  - @happyvertical/smrt-core@0.6.0
  - @happyvertical/smrt-types@0.5.5

## 0.5.7

### Patch Changes

- f9019e6: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [f9019e6]
  - @happyvertical/smrt-core@0.5.7
  - @happyvertical/smrt-types@0.5.4

## 0.5.6

### Patch Changes

- Updated dependencies [708a6ab]
  - @happyvertical/smrt-core@0.5.6

## 0.5.5

### Patch Changes

- 694e1da: - fix(manifest): capture package name during registration for external packages
- Updated dependencies [694e1da]
  - @happyvertical/smrt-core@0.5.5
  - @happyvertical/smrt-types@0.5.3

## 0.5.4

### Patch Changes

- Updated dependencies [1129a5a]
  - @happyvertical/smrt-core@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [b1c4faa]
  - @happyvertical/smrt-types@0.5.2
  - @happyvertical/smrt-core@0.5.3

## 0.5.2

### Patch Changes

- 905bdf4: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [905bdf4]
  - @happyvertical/smrt-core@0.5.2
  - @happyvertical/smrt-types@0.5.1

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
  - @happyvertical/smrt-types@0.5.0

## 0.4.2

### Patch Changes

- dfce003: Enable GitHub Package Registry publishing for all SMRT packages

  - Add @happyvertical scope to .npmrc for GitHub Package Registry
  - Configure authentication with GITHUB_TOKEN
  - All packages now publish to https://npm.pkg.github.com/@happyvertical/*

- Updated dependencies [dfce003]
  - @happyvertical/smrt-types@0.4.2
  - @happyvertical/smrt-core@0.4.2
