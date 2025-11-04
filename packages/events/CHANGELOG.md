# @happyvertical/smrt-events

## 0.10.1

### Patch Changes

- Updated dependencies [be1be8f]
  - @happyvertical/smrt-core@0.10.1
  - @happyvertical/smrt-places@0.10.1
  - @happyvertical/smrt-profiles@0.10.1

## 0.10.0

### Minor Changes

- c6d8f52: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [c6d8f52]
  - @happyvertical/smrt-core@0.10.0
  - @happyvertical/smrt-places@0.10.0
  - @happyvertical/smrt-profiles@0.10.0

## 0.9.0

### Minor Changes

- 85c671b: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [85c671b]
  - @happyvertical/smrt-core@0.9.0
  - @happyvertical/smrt-places@0.9.0
  - @happyvertical/smrt-profiles@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [fb98c3a]
  - @happyvertical/smrt-core@0.8.1
  - @happyvertical/smrt-profiles@0.8.1
  - @happyvertical/smrt-places@0.8.1

## 0.8.0

### Patch Changes

- @happyvertical/smrt-profiles@0.8.0
- @happyvertical/smrt-core@0.8.0
- @happyvertical/smrt-places@0.8.0

## 0.7.0

### Minor Changes

- 51c388a: - feat(generators): expose custom methods by default without explicit include
  - fix(cli): load manifest at runtime to populate ObjectRegistry

### Patch Changes

- Updated dependencies [51c388a]
  - @happyvertical/smrt-core@0.7.0
  - @happyvertical/smrt-places@0.7.0
  - @happyvertical/smrt-profiles@0.7.0

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
  - @happyvertical/smrt-places@0.5.8
  - @happyvertical/smrt-profiles@0.5.8

## 0.5.7

### Patch Changes

- f9019e6: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [f9019e6]
  - @happyvertical/smrt-core@0.5.7
  - @happyvertical/smrt-places@0.5.7
  - @happyvertical/smrt-profiles@0.5.7

## 0.5.6

### Patch Changes

- Updated dependencies [708a6ab]
  - @happyvertical/smrt-core@0.5.6
  - @happyvertical/smrt-places@0.5.6
  - @happyvertical/smrt-profiles@0.5.6

## 0.5.5

### Patch Changes

- 694e1da: - fix(manifest): capture package name during registration for external packages
- Updated dependencies [694e1da]
  - @happyvertical/smrt-core@0.5.5
  - @happyvertical/smrt-places@0.5.5
  - @happyvertical/smrt-profiles@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies [1129a5a]
  - @happyvertical/smrt-core@0.5.4
  - @happyvertical/smrt-places@0.5.4
  - @happyvertical/smrt-profiles@0.5.4

## 0.5.3

### Patch Changes

- @happyvertical/smrt-core@0.5.3
- @happyvertical/smrt-profiles@0.5.3
- @happyvertical/smrt-places@0.5.3

## 0.5.2

### Patch Changes

- 905bdf4: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [905bdf4]
  - @happyvertical/smrt-core@0.5.2
  - @happyvertical/smrt-places@0.5.2
  - @happyvertical/smrt-profiles@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [3663a95]
  - @happyvertical/smrt-core@0.5.1
  - @happyvertical/smrt-places@0.5.1
  - @happyvertical/smrt-profiles@0.5.1

## 0.5.0

### Minor Changes

- 007567e: - feat(all): add local SDK development setup scripts

### Patch Changes

- Updated dependencies [6d322c8]
- Updated dependencies [007567e]
  - @happyvertical/smrt-core@0.5.0
  - @happyvertical/smrt-places@0.5.0
  - @happyvertical/smrt-profiles@0.5.0

## 0.4.2

### Patch Changes

- dfce003: Enable GitHub Package Registry publishing for all SMRT packages

  - Add @happyvertical scope to .npmrc for GitHub Package Registry
  - Configure authentication with GITHUB_TOKEN
  - All packages now publish to https://npm.pkg.github.com/@happyvertical/*

- Updated dependencies [dfce003]
  - @happyvertical/smrt-core@0.4.2
  - @happyvertical/smrt-places@0.4.2
  - @happyvertical/smrt-profiles@0.4.2
