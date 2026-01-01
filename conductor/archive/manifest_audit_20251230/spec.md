# Track Specification: Comprehensive Audit and Unification of Manifest Generation Logic

## 1. Context & Objective
The SMRT Framework's current manifest generation logic is fragmented. Different components (CLI, tests, runtime applications) may trigger generation or consumption of manifests in slightly different ways or look for them in different locations. This duplication creates maintenance headaches, potential bugs, and confusion.

The objective of this track is to:
1.  **Audit**: Map out every code path that touches manifest generation or loading.
2.  **Unify**: Consolidate this logic into a single, authoritative source of truth.
3.  **Simplify**: Remove redundant checks and unify file locations.
4.  **Harden**: Ensure the new unified logic is robust and reliable.

Breaking changes are acceptable at this stage if they lead to a cleaner architecture.

## 2. Scope
- **In Scope:**
    -   Analysis of `@smrt/core`, `@smrt/cli`, and other relevant packages.
    -   Refactoring `ManifestGenerator` and related classes.
    -   Updating logic for where manifests are stored (e.g., standardizing on `.smrt/manifest.json` or similar).
    -   Updating consumers to use the new unified loading mechanism.
- **Out of Scope:**
    -   Adding new features to the manifest format itself (unless required for unification).
    -   Refactoring unrelated parts of the framework (e.g., database drivers) unless they directly impact manifest loading.

## 3. Implementation Strategy
1.  **Discovery Phase**: Use `grep` and code analysis to find all usages of manifest logic.
2.  **Design Phase**: Propose a unified `ManifestService` or similar abstraction.
3.  **Refactor Phase**: Implement the unified logic and delete the old, duplicated code.
4.  **Verification Phase**: Update tests to reflect the changes and verify that all current features work with the new system.

## 4. Detailed Design: Unified Manifest Architecture

### 4.1 Manifest Locations (The "Two-Path" Rule)
To eliminate ambiguity, we define exactly two valid locations for a manifest:
1.  **Development (`.smrt/manifest.json`):** The ephemeral, current state of the project. Used by CLI, local tests, and the dev server.
    -   *Replaces:* `src/manifest/test-manifest.json`, `manifest.json` (root), `static-manifest.json`.
2.  **Distribution (`dist/manifest.json`):** The immutable, built state of a package. Used by consumers when loading a published package.
    -   *Stays:* `dist/manifest.json`.

### 4.2 The `ManifestManager` Class
A new class in `@smrt/core` (likely `packages/core/src/manifest/manager.ts`) that encapsulates all manifest operations.

```typescript
export class ManifestManager {
  constructor(private projectRoot: string) {}

  /**
   * Generates the manifest by scanning the source code.
   * - In 'dev' mode, writes to .smrt/manifest.json
   * - In 'build' mode, writes to dist/manifest.json
   */
  async generate(mode: 'dev' | 'build', options?: ScanOptions): Promise<void>;

  /**
   * Loads the local manifest.
   * Priority: .smrt/manifest.json (Dev) -> dist/manifest.json (Prod fallback)
   */
  loadLocal(): Manifest | null;

  /**
   * Loads a manifest from an external package (node_modules).
   * Always looks for dist/manifest.json.
   */
  static loadExternal(packageName: string): Manifest | null;
}
```

### 4.3 Migration Plan
1.  **Refactor Core:** Implement `ManifestManager` in `@smrt/core`.
2.  **Update Scripts:** Change all `generate-test-manifest.js` scripts to use `ManifestManager` and target `.smrt/manifest.json`.
3.  **Update Loaders:** Update `loadLocalTestManifestSync` (to be renamed/deprecated) to read from `.smrt/manifest.json`.
4.  **Clean Up:** Delete `test-manifest.json` files and legacy scanning logic.
