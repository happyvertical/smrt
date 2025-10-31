# CLI Extraction Summary

**Date**: October 30, 2024
**Branch**: Current work (not yet committed)

## Overview

Successfully extracted CLI functionality from `@happyvertical/smrt-core` into a new standalone `@happyvertical/smrt-cli` package with automatic manifest discovery and new introspection commands.

## What Was Done

### 1. Package Structure Created

Created new `@happyvertical/smrt-cli` package at `packages/cli/` with:
- Full package.json with bin entries for `smrt` and `smrt-cli`
- TypeScript configuration with project references
- Vite build configuration
- Comprehensive README documentation

### 2. Code Moved from Core to CLI

**Files Moved**:
- `CLIGenerator` class → `packages/cli/src/cli-generator.ts`
- Commands → `packages/cli/src/commands/`
  - `generate.ts` - Code generation commands
  - `gnode.ts` - Gnode scaffolding commands
  - **NEW**: `utilities.ts` - Introspection and testing commands
- Template loaders → `packages/cli/src/loaders/`
- Generator utilities → `packages/cli/src/utils/`

**Files Created**:
- `packages/cli/src/discovery/manifest-discovery.ts` - Auto-discovery system
- `packages/cli/src/discovery/index.ts` - Discovery exports
- `packages/cli/src/commands/utilities.ts` - New utility commands

### 3. Core Package Cleaned Up

**Removed from Core**:
- `dist/generators/cli.js` binary → moved to CLI package as `smrt` binary
- `src/cli/` directory (all CLI command implementations)
- `src/generators/cli.ts` and `cli.spec.ts`
- `tar` dependency (moved to CLI package)
- CLI-related exports from `generators/index.ts`

**Kept in Core**:
- `smrt-prebuild` binary (for pre-build type generation)
  - **Purpose**: Generates TypeScript declarations from manifests before builds
  - **Location**: `packages/core/src/prebuild/`
  - **Usage**: `smrt-prebuild generate-types <manifest> <output-dir>`
  - **Use Case**: Solves chicken-and-egg problem for virtual module type resolution
- Code generation libraries (MCPGenerator, APIGenerator, etc.)
- All other framework functionality

### 4. New Features Implemented

#### Manifest Discovery System (`packages/cli/src/discovery/`)

Automatically discovers SMRT object manifests from:
- **Project root**: static-manifest.js, manifest.json, src/manifest/*, .smrt/*
- **Installed packages**: Scans node_modules for SMRT packages and their manifests

Functions:
- `discoverManifests()` - Find all manifests in project and dependencies
- `loadManifest()` - Load and parse manifest files (.js and .json)
- `autoDiscoverAndLoad()` - Complete auto-discovery workflow

#### New Commands

**`smrt introspect`** (solves Issue #135 discovery problem):
- Auto-discovers manifests in project and node_modules
- Shows discovered manifests with source (project vs package)
- Displays object counts and paths
- `--verbose` flag shows detailed object information
- Provides next steps guidance

**`smrt test`**:
- Scans src/**/*.test.ts and src/**/*.spec.ts files
- Generates test manifest using ASTScanner and ManifestGenerator
- Creates both JSON manifest and TypeScript stub
- Optionally runs vitest after manifest generation
- `--manifest-only` flag to skip test execution
- `--output` option to specify output directory (default: src/manifest)

### 5. Architecture

**Option A** (selected): CLIGenerator in CLI package
- Clean separation between framework (core) and tooling (CLI)
- `tar` dependency removed from core
- CLI is self-contained with all its dependencies

**Package Roles**:
- `@happyvertical/smrt-core`: Framework code, generators (MCP, REST), prebuild tools
- `@happyvertical/smrt-cli`: Developer CLI, introspection, gnode scaffolding

### 6. Build Configuration

**TypeScript Project References**:
- Added `packages/cli` to root `tsconfig.json` references
- CLI properly references core and types packages
- Composite builds work correctly

**Vite Configuration**:
- Externalizes all `@happyvertical/*` dependencies
- Externalizes node built-ins (fs, path, os, https, etc.)
- Generates type declarations

### 7. Testing Status

**Builds Successfully**:
- ✅ `@happyvertical/smrt-cli` builds without errors
- ✅ `@happyvertical/smrt-core` builds without errors (after CLI removal)
- ✅ All imports resolve correctly
- ✅ Type declarations generated

**Runtime Testing**:
- ✅ Tested in profiles package - introspect command successfully discovers manifests
- ✅ Manifest discovery finds dist/manifest.json in project root
- ✅ Discovered 7 SMRT objects from profiles package
- ✅ Both normal and verbose modes work correctly

**Discovery Path Fix**:
- Added `dist/manifest.json` and `dist/static-manifest.js` to search paths
- Previously only searched src/manifest/ and root, missing build artifacts
- Now correctly discovers manifests in all SMRT packages

## Two-CLI Architecture

The extraction results in **two separate CLI tools** with distinct purposes:

### `smrt` CLI (`@happyvertical/smrt-cli`)
**Developer-facing tool** for working with SMRT projects:
- **Commands**: `introspect`, `test`, `generate-mcp`, `gnode create`, `objects`, `schema`
- **Used by**: Developers during development
- **Installation**: `npm install -D @happyvertical/smrt-cli`
- **Purpose**: Full-featured developer CLI for SMRT project management

### `smrt-prebuild` CLI (`@happyvertical/smrt-core`)
**Build-time tool** for type generation:
- **Commands**: `generate-types <manifest> <output-dir>`
- **Used by**: Package build scripts (not developers directly)
- **Installation**: Installed automatically as dependency of `@happyvertical/smrt-core`
- **Purpose**: Generates physical `.d.ts` files from manifests before TypeScript compilation
- **Why Needed**: Solves chicken-and-egg problem where virtual modules need type declarations before Vite plugin runs

**Example build script usage**:
```json
{
  "scripts": {
    "prebuild": "smrt-prebuild generate-types ./manifest.json src/types",
    "build": "npm run prebuild && vite build"
  }
}
```

This separation keeps the core framework lightweight while providing a full-featured developer CLI.

## Benefits Achieved

1. **Clean Separation**: CLI is now independent from core framework
2. **Reduced Core Dependencies**: `tar` removed from core
3. **Better Discoverability**: `smrt introspect` solves the main problem from Issue #135
4. **Independent Versioning**: CLI can evolve separately from core
5. **Focused Packages**: Each package has a clear, single responsibility
6. **Two-CLI Architecture**: Developer CLI (`smrt`) separate from build-time utility (`smrt-prebuild`)

## Next Steps

### Immediate (Completed)
- [x] Test CLI in profiles package
- [x] Verify introspect command discovers manifests correctly
- [x] Update workspace documentation
- [x] Create commits with conventional messages
- [x] Create PR with full description
- [x] Fix CI failure (removed prepare script causing build issues)
- [x] Migrate profiles package to use `smrt test` command

### Future Enhancements
- [ ] Migrate other packages to use `smrt test` (check for similar custom scripts)
- [ ] Add more introspection features (relationship visualization, etc.)
- [ ] Improve manifest discovery caching
- [ ] Add configuration file support for CLI

## Files Changed

### New Files
- `packages/cli/` (entire new package)
  - `package.json`
  - `tsconfig.json`
  - `vite.config.ts`
  - `README.md`
  - `src/index.ts`
  - `src/cli-generator.ts` (copied from core)
  - `src/cli-generator.spec.ts` (copied from core)
  - `src/commands/*` (copied and enhanced)
  - `src/loaders/*` (copied from core)
  - `src/utils/*` (copied from core)
  - `src/discovery/*` (NEW - manifest discovery)

### Modified Files
- `tsconfig.json` (added CLI package reference)
- `packages/core/package.json` (removed CLI binary, tar dependency, CLI exports)
- `packages/core/src/generators/index.ts` (removed CLI exports)

### Deleted Files
- `packages/core/src/cli/*` (all command implementations)
- `packages/core/src/generators/cli.ts`
- `packages/core/src/generators/cli.spec.ts`

## Migration Guide

For projects currently using the CLI from core:

**Before** (using core):
```json
{
  "dependencies": {
    "@happyvertical/smrt-core": "^0.4.1"
  }
}
```
```bash
npx smrt help  # Uses binary from core
```

**After** (using CLI package):
```json
{
  "dependencies": {
    "@happyvertical/smrt-core": "^0.4.1",
    "@happyvertical/smrt-cli": "^0.4.1"
  },
  "devDependencies": {
    "@happyvertical/smrt-cli": "^0.4.1"  // Or as dev dependency
  }
}
```
```bash
npx smrt help  # Uses binary from CLI package
npx smrt introspect  # NEW - auto-discover manifests
```

## Related Issues

- Issue #135: "Add `smrt test` CLI command" - Partially addressed with introspect command and test guidance
- Issue #?: CLI extraction from core - Completed

## Breaking Changes

⚠️ **Breaking**: Projects depending on `smrt` binary from `@happyvertical/smrt-core` must now install `@happyvertical/smrt-cli`.

## Compatibility

- Node.js 24+
- TypeScript 5.7+
- Vite 7.1+
- Compatible with all existing SMRT packages

---

*This extraction maintains full backward compatibility for all programmatic APIs while providing a cleaner package structure and better developer experience.*
