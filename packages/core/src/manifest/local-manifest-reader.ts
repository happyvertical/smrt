import { createLogger } from '@happyvertical/logger';
import type { SmartObjectManifest } from '../scanner/types.js';
import { existsSync, join, readFileSync } from './node-host.js';

/** The two filesystem reads a manifest load needs. */
export interface ManifestFileAccess {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf-8'): string;
}

/** Resolved through the lazy Node host: absent files on a host without one. */
const hostFileAccess: ManifestFileAccess = { existsSync, readFileSync };

const logger = createLogger({ level: 'info' });

/**
 * Reads SMRT manifests for a project from the standard locations.
 *
 * @remarks
 * The read half of `ManifestManager`, split out so the registry's manifest
 * discovery does not pull the write and generation half (`node:fs` writes,
 * the AST scanner) into a browser bundle (#2838). Filesystem access goes
 * through `node-host.ts`, so without a Node host every load finds nothing.
 *
 * Manifests are JSON files containing class/field metadata produced by the AST scanner.
 * Dev manifests live at `.smrt/manifest.json`; build manifests at `dist/manifest.json`.
 * Workspace packages may also provide a checked-in source manifest at
 * `src/manifest/manifest.json`. When loading a local project, the dev path takes
 * priority; for external packages (dependencies), the build path takes priority
 * to avoid pulling in test objects.
 */
export class LocalManifestReader {
  constructor(
    protected projectRoot: string,
    private readonly files: ManifestFileAccess = hostFileAccess,
  ) {}

  /**
   * Get the standard output path for the manifest based on mode.
   */
  getOutputPath(mode: 'dev' | 'build' | 'source'): string {
    if (mode === 'dev') {
      return join(this.projectRoot, '.smrt/manifest.json');
    }
    if (mode === 'source') {
      return join(this.projectRoot, 'src/manifest/manifest.json');
    }
    return join(this.projectRoot, 'dist/manifest.json');
  }

  /**
   * Loads the local manifest from the standard locations.
   * Priority: .smrt/manifest.json -> dist/manifest.json -> src/manifest/manifest.json
   */
  loadLocal(): SmartObjectManifest | null {
    return this._loadFromPaths([
      this.getOutputPath('dev'),
      this.getOutputPath('build'),
      this.getOutputPath('source'),
    ]);
  }

  /**
   * Loads the manifest for an external package (dependency).
   * Priority: dist/manifest.json -> .smrt/manifest.json -> src/manifest/manifest.json
   *
   * External packages should prefer their production (dist) manifest
   * over the dev/test (.smrt) manifest to avoid pulling in test objects
   * and transitive dependencies. In a workspace, the checked-in source manifest
   * provides the same package metadata even when the sibling package has not been built yet.
   */
  loadForExternalPackage(): SmartObjectManifest | null {
    return this._loadFromPaths([
      this.getOutputPath('build'),
      this.getOutputPath('dev'),
      this.getOutputPath('source'),
    ]);
  }

  private _loadFromPaths(paths: string[]): SmartObjectManifest | null {
    for (const path of paths) {
      if (this.files.existsSync(path)) {
        try {
          const content = this.files.readFileSync(path, 'utf-8');
          return JSON.parse(content);
        } catch (error) {
          logger.error(`[ManifestManager] Failed to read manifest at ${path}`, {
            error,
          });
        }
      }
    }

    return null;
  }
}
