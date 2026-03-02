import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { SmartObjectManifest } from '../scanner/types.js';

/**
 * Reads, writes, and generates SMRT manifests for a project.
 *
 * @remarks
 * Manifests are JSON files containing class/field metadata produced by the AST scanner.
 * Dev manifests live at `.smrt/manifest.json`; build manifests at `dist/manifest.json`.
 * When loading a local project, the dev path takes priority; for external packages
 * (dependencies), the build path takes priority to avoid pulling in test objects.
 */
export class ManifestManager {
  constructor(private projectRoot: string) {}

  /**
   * Get the standard output path for the manifest based on mode.
   */
  getOutputPath(mode: 'dev' | 'build'): string {
    if (mode === 'dev') {
      return join(this.projectRoot, '.smrt/manifest.json');
    }
    return join(this.projectRoot, 'dist/manifest.json');
  }

  /**
   * Loads the local manifest from the standard locations.
   * Priority: .smrt/manifest.json -> dist/manifest.json
   */
  loadLocal(): SmartObjectManifest | null {
    return this._loadFromPaths([
      this.getOutputPath('dev'),
      this.getOutputPath('build'),
    ]);
  }

  /**
   * Loads the manifest for an external package (dependency).
   * Priority: dist/manifest.json -> .smrt/manifest.json
   *
   * External packages should prefer their production (dist) manifest
   * over the dev/test (.smrt) manifest to avoid pulling in test objects
   * and transitive dependencies.
   */
  loadForExternalPackage(): SmartObjectManifest | null {
    return this._loadFromPaths([
      this.getOutputPath('build'),
      this.getOutputPath('dev'),
    ]);
  }

  private _loadFromPaths(paths: string[]): SmartObjectManifest | null {
    for (const path of paths) {
      if (existsSync(path)) {
        try {
          const content = readFileSync(path, 'utf-8');
          return JSON.parse(content);
        } catch (error) {
          console.error(
            `[ManifestManager] Failed to read manifest at ${path}:`,
            error,
          );
        }
      }
    }

    return null;
  }

  /**
   * Writes a manifest to the standard location.
   */
  write(manifest: SmartObjectManifest, mode: 'dev' | 'build' = 'dev'): void {
    const outputPath = this.getOutputPath(mode);
    const outputDir = dirname(outputPath);

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  }

  /**
   * Generates a manifest from scan results and writes it.
   */
  async generateFromScanResults(
    scanResults: any[],
    options: {
      mode: 'dev' | 'build';
      packageName?: string;
      packageVersion?: string;
      packageJson?: any;
      smrtDependencies?: string[];
    },
  ): Promise<SmartObjectManifest> {
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(scanResults, options);
    this.write(manifest, options.mode);
    return manifest;
  }
}
