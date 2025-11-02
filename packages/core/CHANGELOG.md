# @happyvertical/smrt-core

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
