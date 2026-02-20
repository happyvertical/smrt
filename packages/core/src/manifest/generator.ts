/**
 * Manifest generation orchestrator
 * Consolidates manifest generation logic for both build and test manifests
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { discoverSmrtPackages } from './discover-smrt-packages.js';
import { ManifestManager } from './manager.js';
import { loadExternalManifestSync } from './manifest-loader.js';

/**
 * Options for ManifestBuilder.generate()
 *
 * Controls file discovery, scanner configuration, output generation, and metadata injection
 */
export interface ManifestBuilderOptions {
  // File Discovery
  include?: string[];
  exclude?: string[];
  followImports?: boolean;

  // Scanner Configuration
  baseClasses?: string[];
  loadViteConfig?: boolean;
  discoverExternalPackages?: boolean;
  includeExternalBaseClasses?: boolean;
  includePrivateMethods?: boolean;
  includeStaticMethods?: boolean;

  // Output Configuration
  outputDir?: string;
  outputName?: string;
  generateTypeStub?: boolean;
  stubName?: string;

  // Metadata
  injectPackageInfo?: boolean;
  moduleType?: string;

  // Tree Shaking (External Object Filtering)
  /**
   * Enable import-based tree shaking for external SMRT objects.
   * When enabled, only external objects that are actually imported
   * in the project's source files will be included in the manifest.
   *
   * Default: false (include all external objects)
   */
  treeShake?: boolean;

  /**
   * Explicit whitelist of external class names to include in the manifest.
   * Use this in conjunction with or instead of import-based tree shaking.
   *
   * Accepts simple class names (e.g., "Person") or qualified names
   * (e.g., "@happyvertical/smrt-profiles:Person").
   *
   * When combined with treeShake, both imported classes AND whitelisted
   * classes will be included.
   */
  externalObjectsWhitelist?: string[];
}

interface ScannerConfig {
  baseClasses: string[];
  includePrivateMethods: boolean;
  includeStaticMethods: boolean;
  followImports: boolean;
  smrtDependencies?: string[];
  /** Imports discovered from source files (package → Set<className>) */
  smrtImports?: Map<string, Set<string>>;
}

interface PackageInfo {
  name?: string;
  version?: string;
}

/**
 * Orchestrates manifest generation with configurable options
 *
 * Consolidates logic from generate-manifest.js and generate-test-manifest.js
 * into a single, testable, and maintainable service.
 */
export class ManifestBuilder {
  /**
   * Generate manifest with specified options
   */
  async generate(
    options: ManifestBuilderOptions = {},
  ): Promise<SmartObjectManifest> {
    // 1. Discover files to scan
    const files = this.discoverFiles(options);

    if (files.length === 0) {
      console.log('[smrt] No source files found');
      return this.createEmptyManifest(options);
    }

    console.log(`[smrt] Scanning ${files.length} source file(s)...`);

    // 2. Configure scanner (baseClasses, external packages, vite config)
    const scannerConfig = await this.configureScanner(options);

    // 3. Scan files with OXC scanner (includes import scanning if tree shaking enabled)
    const { manifest: scannedManifest, smrtImports } =
      await this.scanAndBuildManifest(scannerConfig, options);

    // Store imports in scanner config for use in enrichManifest
    if (smrtImports) {
      scannerConfig.smrtImports = smrtImports;
    }

    // 4. Enrich manifest with external packages, metadata, etc.
    const manifest = this.enrichManifest(
      scannedManifest,
      options,
      scannerConfig,
    );

    // 5. Write output files
    await this.writeOutput(manifest, options);

    return manifest;
  }

  /**
   * Discover source files based on include/exclude patterns
   */
  private discoverFiles(options: ManifestBuilderOptions): string[] {
    const include = options.include || ['src/**/*.ts'];
    const exclude = options.exclude || ['src/**/*.d.ts', 'node_modules/**'];

    return fg.sync(include, {
      absolute: true,
      ignore: exclude,
    });
  }

  /**
   * Configure AST scanner with baseClasses, external packages, and vite config
   */
  private async configureScanner(
    options: ManifestBuilderOptions,
  ): Promise<ScannerConfig> {
    let baseClasses = options.baseClasses || [
      'SmrtObject',
      'SmrtClass',
      'SmrtCollection',
    ];

    // Load from vite.config.ts if requested
    if (options.loadViteConfig) {
      const viteBaseClasses = await this.loadViteConfigBaseClasses();
      if (viteBaseClasses && viteBaseClasses.length > 0) {
        baseClasses = viteBaseClasses;
        console.log(
          `[smrt] Using baseClasses from vite.config.ts: ${baseClasses.join(', ')}`,
        );
      }
    }

    // Discover external SMRT packages
    let smrtDependencies: string[] = [];
    if (options.discoverExternalPackages) {
      console.log('[smrt] Discovering external SMRT packages...');
      smrtDependencies = discoverSmrtPackages();
      console.log(
        `[smrt] Found ${smrtDependencies.length} SMRT package(s): ${smrtDependencies.join(', ')}`,
      );

      // Optionally add external base classes
      if (options.includeExternalBaseClasses) {
        const externalClasses =
          await this.loadExternalBaseClasses(smrtDependencies);
        if (externalClasses.length > 0) {
          baseClasses = [...baseClasses, ...externalClasses];
          console.log(
            `[smrt] Added ${externalClasses.length} external base class(es) to scanner`,
          );
          console.log(`[smrt] Total baseClasses: ${baseClasses.length}`);
        }
      }
    }

    return {
      baseClasses,
      includePrivateMethods: options.includePrivateMethods ?? false,
      includeStaticMethods: options.includeStaticMethods ?? true,
      followImports: options.followImports ?? false,
      smrtDependencies,
    };
  }

  /**
   * Scan files using OxcScanner and build manifest via ManifestAdapter.
   *
   * This replaces the old ASTScanner-based scanFiles() method.
   * Uses the same OXC pipeline as the Vite plugin's scanWithOxc().
   */
  private async scanAndBuildManifest(
    config: ScannerConfig,
    options: ManifestBuilderOptions,
  ): Promise<{
    manifest: SmartObjectManifest;
    smrtImports?: Map<string, Set<string>>;
  }> {
    const { OxcScanner, ManifestAdapter } = await import(
      '@happyvertical/smrt-scanner'
    );

    const scanner = new OxcScanner({
      cwd: process.cwd(),
      include: options.include || ['src/**/*.ts'],
      exclude: options.exclude || ['src/**/*.d.ts', 'node_modules/**'],
      baseClasses: config.baseClasses,
      includePrivateMethods: config.includePrivateMethods,
      includeStaticMethods: config.includeStaticMethods,
      followImports: config.followImports,
    });

    const { results, resolved } = await scanner.scanAndResolve();

    // Read package.json for metadata
    let packageName: string | undefined;
    let packageVersion: string | undefined;
    let packageJson: any;
    try {
      const pkgPath = resolve(process.cwd(), 'package.json');
      const pkgContent = readFileSync(pkgPath, 'utf-8');
      packageJson = JSON.parse(pkgContent);
      packageName = packageJson.name || undefined;
      packageVersion = packageJson.version || undefined;
    } catch {
      // package.json not found - continue without packageName
    }

    // Convert to manifest format
    const adapter = new ManifestAdapter();
    const manifest = adapter.toManifest(resolved, {
      packageName,
      packageVersion,
      typeAliases: results.typeAliases,
    });

    // Set smrtDependencies BEFORE mergeInheritedFields so external packages can be loaded
    if (config.smrtDependencies && config.smrtDependencies.length > 0) {
      manifest.smrtDependencies = config.smrtDependencies;
    }

    // Run manifest generation passes (same as Vite plugin path)
    const manifestGen = new ManifestGenerator();
    manifestGen.mergeInheritedFields(manifest);
    manifestGen.generateValidationRules(manifest);
    manifestGen.generateSchemas(manifest);
    manifestGen.generateAgentManifests(manifest, packageName, packageJson);

    // Scan for SMRT imports if tree shaking is enabled
    let smrtImports: Map<string, Set<string>> | undefined;
    if (options.treeShake) {
      if (process.env.DEBUG_MANIFEST) {
        console.log(
          '[smrt] Tree shaking enabled, scanning for SMRT imports...',
        );
      }
      smrtImports = scanner.scanSmrtImports();
    }

    return { manifest, smrtImports };
  }

  /**
   * Enrich manifest with external packages, metadata, and tree shaking
   */
  private enrichManifest(
    manifest: SmartObjectManifest,
    options: ManifestBuilderOptions,
    scannerConfig: ScannerConfig,
  ): SmartObjectManifest {
    // Add module type
    manifest.moduleType = options.moduleType || 'smrt';

    // Add SMRT dependencies and aggregate their manifests (Issue #782)
    // This pre-aggregates all external package objects into a single manifest,
    // eliminating the need to scan node_modules at runtime
    if (
      scannerConfig.smrtDependencies &&
      scannerConfig.smrtDependencies.length > 0
    ) {
      manifest.smrtDependencies = scannerConfig.smrtDependencies;

      // Determine if we should filter external objects
      const shouldFilter =
        options.treeShake ||
        (options.externalObjectsWhitelist &&
          options.externalObjectsWhitelist.length > 0);

      // Build the allowed set of external classes
      let allowedClasses: Set<string> | null = null;
      if (shouldFilter) {
        allowedClasses = this.buildAllowedClassSet(
          options,
          scannerConfig,
          scannerConfig.smrtDependencies,
        );
      }

      // Merge objects from external packages into this manifest
      let includedCount = 0;
      let excludedCount = 0;

      for (const pkgName of scannerConfig.smrtDependencies) {
        const extManifest = loadExternalManifestSync(pkgName);
        if (extManifest?.objects) {
          for (const [key, obj] of Object.entries(extManifest.objects)) {
            // Don't overwrite local objects with external ones
            if (manifest.objects[key]) {
              continue;
            }

            // Apply tree shaking filter if enabled
            if (allowedClasses) {
              if (
                !this.isClassAllowed(
                  obj.className,
                  obj.qualifiedName ?? obj.className,
                  allowedClasses,
                )
              ) {
                excludedCount++;
                continue;
              }
            }

            manifest.objects[key] = obj;
            includedCount++;
          }
        }
      }

      // Log filtering results
      if (shouldFilter && process.env.DEBUG_MANIFEST) {
        console.log(
          `[smrt] Tree shaking: included ${includedCount} external object(s), excluded ${excludedCount}`,
        );
      }
    }

    // Inject package info
    if (options.injectPackageInfo) {
      const packageInfo = this.readPackageJson();
      if (packageInfo.name) {
        manifest.packageName = packageInfo.name;
        console.log(`[smrt] Injected package name: ${packageInfo.name}`);
      } else {
        console.warn(
          '[smrt] Warning: Could not read package.json, packageName will be undefined',
        );
      }
    }

    return manifest;
  }

  /**
   * Build the set of allowed external classes from imports and whitelist
   *
   * Combines:
   * 1. Whitelist (explicit class names)
   * 2. Import analysis (classes imported in source files)
   * 3. Transitive dependencies (inheritance, foreignKey relationships)
   */
  private buildAllowedClassSet(
    options: ManifestBuilderOptions,
    scannerConfig: ScannerConfig,
    packages: string[],
  ): Set<string> {
    const allowed = new Set<string>();

    // 1. Add whitelisted classes
    if (options.externalObjectsWhitelist) {
      for (const className of options.externalObjectsWhitelist) {
        // Handle both simple names and qualified names
        if (className.includes(':')) {
          // Qualified name like "@happyvertical/smrt-profiles:Person"
          allowed.add(className);
          // Also add simple name for matching (use last segment for multi-colon names)
          const parts = className.split(':');
          const simpleName = parts[parts.length - 1];
          if (simpleName) {
            allowed.add(simpleName);
          }
        } else {
          allowed.add(className);
        }
      }
      if (process.env.DEBUG_MANIFEST) {
        console.log(
          `[smrt] Whitelist: ${options.externalObjectsWhitelist.length} class(es)`,
        );
      }
    }

    // 2. Add imported classes
    if (scannerConfig.smrtImports) {
      for (const [pkgName, classNames] of scannerConfig.smrtImports) {
        // Check for wildcard import (import * as ...)
        if (classNames.has('*')) {
          // Include all classes from this package
          const extManifest = loadExternalManifestSync(pkgName);
          if (extManifest?.objects) {
            for (const obj of Object.values(extManifest.objects)) {
              allowed.add(obj.className);
              if (obj.qualifiedName) {
                allowed.add(obj.qualifiedName);
              }
            }
          }
          if (process.env.DEBUG_MANIFEST) {
            console.log(`[smrt] Import wildcard: all classes from ${pkgName}`);
          }
        } else {
          for (const className of classNames) {
            allowed.add(className);
          }
        }
      }
    }

    // 3. Resolve transitive dependencies
    const resolved = this.resolveTransitiveDependencies(allowed, packages);

    if (process.env.DEBUG_MANIFEST) {
      console.log(
        `[smrt] Allowed classes after dependency resolution: ${resolved.size}`,
      );
    }

    return resolved;
  }

  /**
   * Resolve transitive dependencies for allowed classes
   *
   * Includes:
   * - Base classes (extends)
   * - Foreign key targets (foreignKey relationships)
   * - STI siblings (classes sharing the same STI base table)
   */
  private resolveTransitiveDependencies(
    initial: Set<string>,
    packages: string[],
  ): Set<string> {
    const resolved = new Set(initial);
    const queue = [...initial];
    const visited = new Set<string>();

    // Build a map of all external objects for lookup
    const externalObjects = new Map<
      string,
      { obj: any; pkgName: string; key: string }
    >();
    for (const pkgName of packages) {
      const extManifest = loadExternalManifestSync(pkgName);
      if (extManifest?.objects) {
        for (const [key, obj] of Object.entries(extManifest.objects)) {
          externalObjects.set(obj.className, { obj, pkgName, key });
          if (obj.qualifiedName) {
            externalObjects.set(obj.qualifiedName, { obj, pkgName, key });
          }
        }
      }
    }

    // Process queue to find transitive dependencies
    while (queue.length > 0) {
      const className = queue.shift()!;
      if (visited.has(className)) continue;
      visited.add(className);

      const entry = externalObjects.get(className);
      if (!entry) continue;

      const { obj } = entry;

      // Include base class (extends)
      if (obj.extends && !resolved.has(obj.extends)) {
        resolved.add(obj.extends);
        queue.push(obj.extends);
      }

      // Include foreign key targets
      if (obj.fields) {
        for (const field of Object.values(obj.fields) as any[]) {
          if (
            field.type === 'foreignKey' &&
            field.related &&
            !resolved.has(field.related)
          ) {
            resolved.add(field.related);
            queue.push(field.related);
          }
        }
      }

      // Include STI siblings (classes sharing the same base table)
      // If this class uses STI, include all classes in the same hierarchy
      if (obj.decoratorConfig?.tableStrategy === 'sti') {
        // Find all classes that share the same STI base
        const stiBase = this.findSTIBase(obj, externalObjects);
        if (stiBase) {
          for (const [, otherEntry] of externalObjects) {
            const other = otherEntry.obj;
            if (this.findSTIBase(other, externalObjects) === stiBase) {
              if (!resolved.has(other.className)) {
                resolved.add(other.className);
                queue.push(other.className);
              }
            }
          }
        }
      }
    }

    return resolved;
  }

  /**
   * Find the STI base class for an object
   */
  private findSTIBase(
    obj: any,
    externalObjects: Map<string, { obj: any; pkgName: string; key: string }>,
  ): string | null {
    // If no tableStrategy, not STI
    if (!obj.decoratorConfig?.tableStrategy) return null;
    if (obj.decoratorConfig.tableStrategy !== 'sti') return null;

    // Walk up inheritance chain to find the root STI class
    // Track visited classes to prevent infinite loops
    const visited = new Set<string>();
    let current = obj;
    while (current.extends) {
      if (visited.has(current.className)) {
        // Circular inheritance detected, return current as base
        break;
      }
      visited.add(current.className);
      const parentEntry = externalObjects.get(current.extends);
      if (!parentEntry) break;
      if (parentEntry.obj.decoratorConfig?.tableStrategy !== 'sti') {
        // Parent is not STI, so current is the STI base
        return current.className;
      }
      current = parentEntry.obj;
    }

    // Reached the top, return current
    return current.className;
  }

  /**
   * Check if a class is in the allowed set
   */
  private isClassAllowed(
    className: string,
    qualifiedName: string,
    allowed: Set<string>,
  ): boolean {
    return allowed.has(className) || allowed.has(qualifiedName);
  }

  /**
   * Write manifest JSON and optional TypeScript stub
   */
  private async writeOutput(
    manifest: SmartObjectManifest,
    options: ManifestBuilderOptions,
  ): Promise<void> {
    const manager = new ManifestManager(process.cwd());
    const isTest =
      options.outputName?.includes('test') ||
      options.stubName?.includes('test');
    const mode = isTest ? 'dev' : 'build';

    // 1. Always write to the unified location via ManifestManager
    manager.write(manifest, mode);

    // 2. Legacy/Explicit Output (if requested or for stubs)
    const outputDir = options.outputDir || 'src/manifest';
    const outputName = options.outputName || 'manifest.json';

    // Ensure output directory exists for legacy/stubs
    mkdirSync(outputDir, { recursive: true });

    // Write JSON manifest to legacy location if different from unified path
    const manifestPath = resolve(outputDir, outputName);
    const unifiedPath = manager.getOutputPath(mode);

    if (resolve(manifestPath) !== resolve(unifiedPath)) {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    // Write TypeScript stub if requested
    if (options.generateTypeStub) {
      const stubName = options.stubName || 'manifest.ts';
      const tsContent = this.generateTypeStub(manifest, stubName);
      const stubPath = resolve(outputDir, stubName);
      writeFileSync(stubPath, tsContent);
    }

    const objectCount = Object.keys(manifest.objects).length;
    console.log(`[smrt] ✅ Generated manifest with ${objectCount} object(s)`);
    console.log(`[smrt]    Unified: ${unifiedPath}`);
  }

  /**
   * Generate TypeScript stub file with manifest constant
   */
  private generateTypeStub(
    manifest: SmartObjectManifest,
    filename: string,
  ): string {
    const isTestManifest = filename.includes('test');

    const comment = isTestManifest
      ? `/**
 * Test manifest stub
 * This file is replaced by generate-test-manifest.js during pretest
 * If tests run without pretest, this empty manifest is used
 *
 * DO NOT EDIT MANUALLY - This file is automatically generated
 */`
      : `/**
 * Auto-generated static manifest
 * Generated at build time from SMRT object scanning
 * DO NOT EDIT - This file is automatically generated
 */`;

    const exportName = isTestManifest ? 'testManifest' : 'staticManifest';

    // Use relative import for core package (to avoid self-reference during build),
    // package import for all other packages
    const isCorePackage = manifest.packageName === '@happyvertical/smrt-core';
    const importPath = isCorePackage
      ? '../scanner/types.js'
      : '@happyvertical/smrt-core/scanner/types';

    return `${comment}

import type { SmartObjectManifest } from '${importPath}';

export const ${exportName}: SmartObjectManifest = ${JSON.stringify(manifest, null, 2)} as const;

export default ${exportName};
`;
  }

  /**
   * Load baseClasses from vite.config.ts
   */
  private async loadViteConfigBaseClasses(): Promise<string[] | null> {
    try {
      const viteConfigPath = resolve(process.cwd(), 'vite.config.ts');
      if (!existsSync(viteConfigPath)) {
        console.log('[smrt] vite.config.ts not found');
        return null;
      }

      console.log('[smrt] Found vite.config.ts, attempting to load...');

      // Use vite to load config which handles TypeScript
      const { loadConfigFromFile } = await import('vite');
      const loaded = await loadConfigFromFile(
        { command: 'build', mode: 'test' },
        viteConfigPath,
      );

      if (!loaded?.config?.plugins) {
        console.log('[smrt] No plugins found in vite config');
        return null;
      }

      console.log(
        '[smrt] Vite config loaded, plugins:',
        loaded.config.plugins.map((p: any) => p?.name),
      );

      // Find smrtPlugin in plugins array
      const smrtPlugin = loaded.config.plugins.find(
        (p: any) => p?.name === 'smrt-auto-service',
      );

      if (!smrtPlugin) {
        console.log(
          '[smrt] smrt-auto-service plugin not found in plugins array',
        );
        return null;
      }

      console.log('[smrt] Found smrt-auto-service plugin');

      // Try different ways to access options
      let opts =
        (smrtPlugin as any).api?.options ||
        (smrtPlugin as any).options ||
        (smrtPlugin as any)._options;

      if (!opts && typeof (smrtPlugin as any).api === 'function') {
        try {
          const api = (smrtPlugin as any).api();
          opts = api.options;
        } catch (e) {
          console.log('[smrt] Could not call plugin.api()');
        }
      }

      if (opts?.baseClasses) {
        console.log(
          '[smrt] Plugin options:',
          JSON.stringify({
            baseClasses: opts.baseClasses,
            followImports: opts.followImports,
          }),
        );
        return opts.baseClasses;
      }

      console.log('[smrt] Could not access plugin options');
      return null;
    } catch (error: any) {
      console.log('[smrt] Error loading vite.config.ts:', error.message);
      console.log('[smrt] Using default baseClasses');
      return null;
    }
  }

  /**
   * Load base classes from external SMRT package manifests
   */
  private async loadExternalBaseClasses(packages: string[]): Promise<string[]> {
    const externalBaseClasses: string[] = [];

    for (const pkgName of packages) {
      try {
        const manifestPath = resolve(
          process.cwd(),
          'node_modules',
          pkgName,
          'dist',
          'manifest.json',
        );

        const manifestContent = readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);

        // Extract all class names from this package
        const foundClassNames: string[] = [];
        for (const objDef of Object.values(manifest.objects)) {
          if ((objDef as any).className) {
            const className = (objDef as any).className;
            foundClassNames.push(className);
            externalBaseClasses.push(className);
          }
        }

        console.log(
          `[smrt]   ${pkgName}: found ${foundClassNames.length} class(es) - ${foundClassNames.join(', ')}`,
        );
      } catch (error: any) {
        console.log(
          `[smrt]   ${pkgName}: manifest not found or invalid - ${error.message}`,
        );
      }
    }

    return externalBaseClasses;
  }

  /**
   * Read package.json from current working directory
   */
  private readPackageJson(): PackageInfo {
    try {
      const packageJsonPath = resolve(process.cwd(), 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      return {
        name: packageJson.name,
        version: packageJson.version,
      };
    } catch (error) {
      return {};
    }
  }

  /**
   * Create empty manifest when no files found
   */
  private createEmptyManifest(
    options: ManifestBuilderOptions,
  ): SmartObjectManifest {
    const manifest: SmartObjectManifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      objects: {},
      moduleType: options.moduleType || 'smrt',
    };

    if (options.discoverExternalPackages) {
      manifest.smrtDependencies = discoverSmrtPackages();
    }

    if (options.injectPackageInfo) {
      const packageInfo = this.readPackageJson();
      if (packageInfo.name) {
        manifest.packageName = packageInfo.name;
      }
    }

    return manifest;
  }
}
