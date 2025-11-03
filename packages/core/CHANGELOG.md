# @happyvertical/smrt-core

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
