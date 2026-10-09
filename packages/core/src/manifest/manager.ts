import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { publishAtomicArtifact } from '../consumer-plugin/artifact-publication.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { ScanResult, SmartObjectManifest } from '../scanner/types.js';
import { LocalManifestReader } from './local-manifest-reader.js';

/**
 * Reads, writes, and generates SMRT manifests for a project.
 *
 * @remarks
 * Adds writing and generation to {@link LocalManifestReader}, which owns the
 * read side and the manifest locations. This half is Node-only (`node:fs`
 * writes and the AST scanner) and stays out of the registry's browser graph.
 */
export class ManifestManager extends LocalManifestReader {
  constructor(projectRoot: string) {
    // Reads go through this module's own `node:fs` binding, not the lazy host
    // the registry's reader uses.
    super(projectRoot, { existsSync, readFileSync });
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

    publishAtomicArtifact({
      path: outputPath,
      content: JSON.stringify(manifest, null, 2),
    });
  }

  /**
   * Generates a manifest from scan results and writes it.
   */
  async generateFromScanResults(
    scanResults: ScanResult[],
    options: {
      mode: 'dev' | 'build';
      packageName?: string;
      packageVersion?: string;
      packageJson?: Record<string, unknown>;
      smrtDependencies?: string[];
    },
  ): Promise<SmartObjectManifest> {
    const generator = new ManifestGenerator();
    const manifest = generator.generateManifest(scanResults, options);
    this.write(manifest, options.mode);
    return manifest;
  }
}
