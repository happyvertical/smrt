/**
 * OXC Scanner
 *
 * High-level scanner that orchestrates OXC parsing and inheritance resolution.
 * Provides a simple API for scanning TypeScript files for SMRT classes.
 */

import { resolve } from 'node:path';
import fg from 'fast-glob';
import { InheritanceResolver } from './inheritance-resolver.js';
import { parseFile } from './oxc-parser.js';
import type {
  ExternalManifest,
  FileScanResult,
  OxcScannerOptions,
  ResolvedClassDefinition,
  ScanResults,
} from './types.js';

/**
 * Default glob patterns for scanning
 */
const DEFAULT_INCLUDE = ['**/*.ts', '**/*.tsx'];
const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/*.d.ts',
  '**/*.test.ts',
  '**/*.spec.ts',
  '**/__tests__/**',
];

/**
 * High-performance TypeScript scanner that discovers `@smrt()`-decorated
 * classes in a project's source files.
 *
 * Orchestrates the two-phase scan pipeline:
 * 1. **Phase 1 — Parse** (`scan()`): uses OXC (Rust) to parse TypeScript files
 *    in parallel and extract raw class, field, method, and decorator metadata.
 * 2. **Phase 2 — Resolve** (`resolve()`): walks inheritance chains, detects STI
 *    hierarchies, and merges fields from ancestor classes.
 *
 * The common path is {@link scanAndResolve} which runs both phases in sequence.
 *
 * @example
 * ```typescript
 * import { OxcScanner } from '@happyvertical/smrt-scanner';
 *
 * const scanner = new OxcScanner({
 *   cwd: process.cwd(),
 *   include: ['src/**\/*.ts'],
 *   exclude: ['**\/*.test.ts'],
 * });
 *
 * const { results, resolved } = await scanner.scanAndResolve();
 * console.log(`Found ${resolved.length} SMRT classes in ${results.fileCount} files`);
 * ```
 *
 * @see {@link OxcScannerOptions} for all available configuration options.
 * @see {@link scanDirectory} for a one-liner convenience wrapper.
 */
export class OxcScanner {
  private options: Required<OxcScannerOptions>;
  private resolver: InheritanceResolver;
  private scanResults: ScanResults | null = null;

  /**
   * Create a new `OxcScanner` with the given options.
   *
   * All options are optional. By default the scanner targets every `.ts` and
   * `.tsx` file under `process.cwd()`, excluding `node_modules`, `dist`,
   * `build`, declaration files, and test files.
   *
   * @param options - Scanner configuration. See {@link OxcScannerOptions}.
   */
  constructor(options: OxcScannerOptions = {}) {
    this.options = {
      include: options.include || DEFAULT_INCLUDE,
      exclude: options.exclude || DEFAULT_EXCLUDE,
      cwd: options.cwd || process.cwd(),
      tsconfig: options.tsconfig || '',
      followImports: options.followImports ?? false,
      baseClasses: options.baseClasses || [],
      includePrivateMethods: options.includePrivateMethods ?? false,
      includeStaticMethods: options.includeStaticMethods ?? true,
      externalManifests: options.externalManifests || new Map(),
    };

    this.resolver = new InheritanceResolver({
      baseClasses: this.options.baseClasses,
      externalManifests: this.options.externalManifests,
    });
  }

  /**
   * Phase 1 — Discover and parse TypeScript files using OXC.
   *
   * Uses `fast-glob` to enumerate matching files and then parses them in
   * parallel with OXC (Rust).  The raw class definitions are registered with
   * the internal {@link InheritanceResolver} for use in the subsequent
   * {@link resolve} call.
   *
   * @returns A {@link ScanResults} object containing all classes found, any
   *   parse errors, accumulated type aliases, SMRT import metadata, and
   *   aggregate timing information.
   *
   * @example
   * ```typescript
   * const scanner = new OxcScanner({ cwd: '/project' });
   * const results = await scanner.scan();
   * console.log(`Parsed ${results.fileCount} files in ${results.totalParseTimeMs.toFixed(1)}ms`);
   * ```
   */
  async scan(): Promise<ScanResults> {
    const startTime = performance.now();

    // Discover files
    const files = await this.discoverFiles();

    // Parse files in parallel
    const fileResults = await Promise.all(
      files.map((filePath) => this.parseFileWithTiming(filePath)),
    );

    // Collect results
    const results: ScanResults = {
      files: fileResults,
      classes: [],
      errors: [],
      totalParseTimeMs: performance.now() - startTime,
      fileCount: files.length,
      typeAliases: {},
    };

    // Flatten classes, errors, and type aliases
    for (const file of fileResults) {
      for (const classDef of file.classes) {
        results.classes.push(classDef);
      }
      for (const error of file.errors) {
        results.errors.push(error);
      }
      Object.assign(results.typeAliases, file.typeAliases);
    }

    // Add classes to resolver
    this.resolver.addClasses(results.classes);

    this.scanResults = results;
    return results;
  }

  /**
   * Phase 2 — Resolve inheritance chains for all scanned classes.
   *
   * Must be called after {@link scan}.  Walks each class's extends chain,
   * detects STI hierarchies, merges ancestor fields for STI subclasses, and
   * marks framework base classes.
   *
   * @returns An array of {@link ResolvedClassDefinition} objects — one for
   *   every class that either carries `@smrt()` or extends a framework base
   *   class (`SmrtObject`, `SmrtClass`, `SmrtCollection`).
   *
   * @throws {Error} If called before {@link scan}.
   *
   * @see {@link scanAndResolve} to run both phases in one call.
   */
  resolve(): ResolvedClassDefinition[] {
    if (!this.scanResults) {
      throw new Error('Must call scan() before resolve()');
    }

    return this.resolver.resolveAll();
  }

  /**
   * Run both scan phases in a single call.
   *
   * Equivalent to calling `await scanner.scan()` followed by
   * `scanner.resolve()`.  This is the most common entry point for callers
   * that want the fully-resolved manifest-ready data in one step.
   *
   * @returns An object with:
   *   - `results` — raw {@link ScanResults} from Phase 1.
   *   - `resolved` — array of {@link ResolvedClassDefinition} from Phase 2.
   *
   * @example
   * ```typescript
   * const scanner = new OxcScanner({ cwd: '/project/src' });
   * const { results, resolved } = await scanner.scanAndResolve();
   * // resolved is ready to pass to ManifestAdapter.toManifest()
   * ```
   *
   * @see {@link ManifestAdapter} to convert `resolved` into a manifest JSON.
   */
  async scanAndResolve(): Promise<{
    results: ScanResults;
    resolved: ResolvedClassDefinition[];
  }> {
    const results = await this.scan();
    const resolved = this.resolve();

    return { results, resolved };
  }

  /**
   * Register an external package manifest for cross-package base class resolution.
   *
   * When a project class extends a class defined in an installed SMRT package,
   * the resolver needs access to that package's class definitions to walk the
   * full inheritance chain.  Call this method with each external package's
   * {@link ExternalManifest} before calling {@link scan} or {@link resolve}.
   *
   * @param manifest - The external manifest to register, including `packageName`,
   *   `packageVersion`, and a `classes` map keyed by class name.
   *
   * @see {@link ExternalManifest}
   */
  addExternalManifest(manifest: ExternalManifest): void {
    this.resolver.addExternalManifest(manifest);
  }

  /**
   * Scan all discovered files for @happyvertical/smrt-* imports.
   * Returns a map of package name → Set of imported class names.
   *
   * Used for tree-shaking: only external objects that are actually imported
   * in the project's source files will be included in the manifest.
   *
   * Must be called after scan() or as part of scanAndResolve().
   *
   * @example
   * ```typescript
   * const scanner = new OxcScanner({ cwd: process.cwd() });
   * await scanner.scan();
   * const imports = scanner.scanSmrtImports();
   * // Map { '@happyvertical/smrt-profiles' => Set { 'Person', 'Organization' } }
   * ```
   */
  scanSmrtImports(): Map<string, Set<string>> {
    if (!this.scanResults) {
      throw new Error('Must call scan() before scanSmrtImports()');
    }

    const merged = new Map<string, Set<string>>();

    for (const file of this.scanResults.files) {
      if (file.smrtImports) {
        for (const [pkg, classes] of file.smrtImports) {
          if (!merged.has(pkg)) {
            merged.set(pkg, new Set());
          }
          const mergedSet = merged.get(pkg)!;
          for (const cls of classes) {
            mergedSet.add(cls);
          }
        }
      }
    }

    return merged;
  }

  /**
   * Return aggregate statistics about the last scan.
   *
   * Can be called after {@link scan} has completed.  Returns counts useful for
   * diagnostics and the `--stats` CLI flag.
   *
   * @returns An object with:
   *   - `totalClasses` — total class declarations seen (including non-SMRT).
   *   - `smrtClasses` — classes with `@smrt()` decorator.
   *   - `stiClasses` — SMRT classes participating in an STI hierarchy.
   *   - `maxInheritanceDepth` — length of the deepest inheritance chain.
   *   - `fileCount` — number of files scanned.
   *   - `parseTimeMs` — total wall-clock parse time in milliseconds.
   */
  getStats(): {
    totalClasses: number;
    smrtClasses: number;
    stiClasses: number;
    maxInheritanceDepth: number;
    fileCount: number;
    parseTimeMs: number;
  } {
    const resolverStats = this.resolver.getStats();

    return {
      ...resolverStats,
      fileCount: this.scanResults?.fileCount || 0,
      parseTimeMs: this.scanResults?.totalParseTimeMs || 0,
    };
  }

  /**
   * Discover files to scan using fast-glob
   */
  private async discoverFiles(): Promise<string[]> {
    const patterns = this.options.include;

    const files = await fg(patterns, {
      cwd: this.options.cwd,
      ignore: this.options.exclude,
      absolute: true,
      onlyFiles: true,
    });

    return files;
  }

  /**
   * Parse a single file with timing
   */
  private async parseFileWithTiming(filePath: string): Promise<FileScanResult> {
    // parseFile is synchronous but we wrap it for potential future async
    return parseFile(filePath);
  }
}

/**
 * Convenience wrapper that creates an {@link OxcScanner} for `dir` and runs
 * both scan phases in a single call.
 *
 * @param dir - Directory to scan (resolved to an absolute path automatically).
 * @param options - Scanner options, excluding `cwd` which is set from `dir`.
 *   See {@link OxcScannerOptions}.
 * @returns An object with `results` ({@link ScanResults}) and `resolved`
 *   ({@link ResolvedClassDefinition}[]).
 *
 * @example
 * ```typescript
 * import { scanDirectory } from '@happyvertical/smrt-scanner';
 *
 * const { resolved } = await scanDirectory('src/', {
 *   include: ['**\/*.ts'],
 *   exclude: ['**\/*.test.ts'],
 * });
 * console.log(`Found ${resolved.length} SMRT classes`);
 * ```
 *
 * @see {@link OxcScanner} for the full class API with more control.
 */
export async function scanDirectory(
  dir: string,
  options: Omit<OxcScannerOptions, 'cwd'> = {},
): Promise<{
  results: ScanResults;
  resolved: ResolvedClassDefinition[];
}> {
  const scanner = new OxcScanner({
    ...options,
    cwd: resolve(dir),
  });

  return scanner.scanAndResolve();
}
