/**
 * Manifest generation orchestrator
 * Consolidates manifest generation logic for both build and test manifests
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import fg from 'fast-glob';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { importWorkspaceModule } from '../utils/import-workspace-module.js';
import type { ScannerModule } from '../utils/scanner-module.js';
import { discoverSmrtPackages } from './discover-smrt-packages.js';
import { ManifestManager } from './manager.js';

async function importScanner() {
  return importWorkspaceModule<ScannerModule>({
    packageName: '@happyvertical/smrt-scanner',
    distEntry: 'packages/scanner/dist/index.js',
    sourceEntry: 'packages/scanner/src/index.ts',
    purpose: 'manifest generation',
  });
}

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
   * @deprecated Tree shaking is no longer needed. The AST scanner no longer includes external objects in the manifest by default.
   */
  treeShake?: boolean;

  /**
   * @deprecated Whitelists are no longer needed. The AST scanner no longer includes external objects in the manifest by default.
   */
  externalObjectsWhitelist?: string[];
}

interface ScannerConfig {
  baseClasses: string[];
  includePrivateMethods: boolean;
  includeStaticMethods: boolean;
  followImports: boolean;
  smrtDependencies?: string[];
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

    // 3. Scan files with OXC scanner
    const scannedManifest = await this.scanAndBuildManifest(
      scannerConfig,
      options,
    );

    // 4. Enrich manifest with metadata (smrtDependencies, packageInfo)
    const manifest = this.enrichManifest(
      scannedManifest,
      options,
      scannerConfig,
    );

    // 5. Write output files
    this.normalizeFilePaths(manifest);
    await this.writeOutput(manifest, options);

    return manifest;
  }

  private normalizeFilePaths(manifest: SmartObjectManifest): void {
    const workspaceRoot = this.findWorkspaceRoot(process.cwd());

    for (const obj of Object.values(manifest.objects || {})) {
      if (obj.filePath && isAbsolute(obj.filePath)) {
        obj.filePath = relative(workspaceRoot, obj.filePath).replace(
          /\\/g,
          '/',
        );
      }
    }
  }

  private findWorkspaceRoot(startDir: string): string {
    let current = resolve(startDir);

    while (true) {
      if (
        existsSync(resolve(current, 'pnpm-workspace.yaml')) ||
        existsSync(resolve(current, '.git'))
      ) {
        return current;
      }

      const parent = dirname(current);
      if (parent === current) {
        return resolve(startDir);
      }
      current = parent;
    }
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
  ): Promise<SmartObjectManifest> {
    const { OxcScanner, ManifestAdapter } = await importScanner();

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
    manifestGen.injectTenantScopedFields(manifest);
    manifestGen.mergeInheritedFields(manifest);
    manifestGen.generateValidationRules(manifest);
    manifestGen.generateSchemas(manifest);
    manifestGen.assertTenantScopedSchemaContract(manifest);
    manifestGen.generateAgentManifests(manifest, packageName, packageJson);

    return manifest;
  }

  /**
   * Enrich manifest with metadata (moduleType, smrtDependencies, packageInfo).
   *
   * Note: As of Issue #1013, this method no longer merges external package
   * objects into the manifest. Dependencies are referenced via
   * `smrtDependencies` and resolved at runtime by manifest-loader.ts.
   */
  private enrichManifest(
    manifest: SmartObjectManifest,
    options: ManifestBuilderOptions,
    scannerConfig: ScannerConfig,
  ): SmartObjectManifest {
    // Add module type
    manifest.moduleType = options.moduleType || 'smrt';

    // Record dependency references (not their objects) so runtime
    // manifest-loader.ts can discover and load them on demand.
    if (
      scannerConfig.smrtDependencies &&
      scannerConfig.smrtDependencies.length > 0
    ) {
      manifest.smrtDependencies = scannerConfig.smrtDependencies;
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
