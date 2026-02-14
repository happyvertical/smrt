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
 * High-performance TypeScript scanner using OXC
 *
 * @example
 * ```typescript
 * const scanner = new OxcScanner({
 *   cwd: process.cwd(),
 *   include: ['src/** /*.ts'],
 *   exclude: ['** /*.test.ts'],
 * });
 *
 * const results = await scanner.scan();
 * const resolved = scanner.resolve();
 * ```
 */
export class OxcScanner {
  private options: Required<OxcScannerOptions>;
  private resolver: InheritanceResolver;
  private scanResults: ScanResults | null = null;

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
   * Scan files and extract class definitions
   *
   * Phase 1: Uses OXC for fast syntactic parsing
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
   * Resolve inheritance chains for all scanned classes
   *
   * Phase 2: JavaScript-based inheritance resolution
   */
  resolve(): ResolvedClassDefinition[] {
    if (!this.scanResults) {
      throw new Error('Must call scan() before resolve()');
    }

    return this.resolver.resolveAll();
  }

  /**
   * Scan and resolve in one call
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
   * Add external manifest for cross-package base class resolution
   */
  addExternalManifest(manifest: ExternalManifest): void {
    this.resolver.addExternalManifest(manifest);
  }

  /**
   * Get resolver statistics
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
 * Convenience function for quick scanning
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
