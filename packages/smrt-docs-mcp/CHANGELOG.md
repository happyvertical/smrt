# @happyvertical/smrt-docs-mcp

## 0.5.2

### Patch Changes

- 694e1da: - fix(manifest): capture package name during registration for external packages

## 0.5.1

### Patch Changes

- 905bdf4: - fix(scanner): use project tsconfig.json for proper module resolution

## 0.5.0

### Minor Changes

- 007567e: - feat(all): add local SDK development setup scripts

## 0.4.2

### Patch Changes

- dfce003: Enable GitHub Package Registry publishing for all SMRT packages

  - Add @happyvertical scope to .npmrc for GitHub Package Registry
  - Configure authentication with GITHUB_TOKEN
  - All packages now publish to https://npm.pkg.github.com/@happyvertical/*
