#!/usr/bin/env node

/**
 * Build-time manifest generator
 * Scans TypeScript source files and generates static manifest JSON
 *
 * Now uses ManifestBuilder service for consolidated, testable logic
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

async function generateManifest() {
  try {
    console.log('[smrt] Generating static manifest...');

    const workspaceTsconfigPath = resolve(
      process.cwd(),
      '../../tsconfig.package-build.json',
    );
    const unregister = register(
      existsSync(workspaceTsconfigPath)
        ? { tsconfig: workspaceTsconfigPath }
        : undefined,
    );

    try {
      const { ManifestBuilder } = await import(
        pathToFileURL(resolve(process.cwd(), 'src/manifest/generator.ts')).href
      );

      const builder = new ManifestBuilder();

      await builder.generate({
        // === FILE DISCOVERY ===
        include: ['src/**/*.ts'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/*.spec.ts',
          'src/**/__tests__/**/*.ts',
          'src/**/*.d.ts',
          'src/scanner/**/*.ts',
          'src/vite-plugin/**/*.ts',
          'src/pleb.ts', // Test/prototype class - not a real framework object
        ],

        // === SCANNER CONFIGURATION ===
        baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
        followImports: false,
        loadViteConfig: false,
        discoverExternalPackages: true,
        includeExternalBaseClasses: false, // Build manifest doesn't need external base classes

        // === OUTPUT CONFIGURATION ===
        outputDir: 'src/manifest',
        outputName: 'static-manifest.json',
        generateTypeStub: true,
        stubName: 'static-manifest.ts',

        // === METADATA ===
        injectPackageInfo: true,
        moduleType: 'smrt',
      });

      const { buildDomainKnowledgeManifest, publishAtomicArtifact } =
        await import(
          pathToFileURL(resolve(process.cwd(), 'src/knowledge.ts')).href
        );
      const sourceManifestPath = resolve(
        process.cwd(),
        'src/manifest/static-manifest.json',
      );
      const distManifestPath = resolve(process.cwd(), 'dist/manifest.json');
      const manifestPath = existsSync(distManifestPath)
        ? distManifestPath
        : sourceManifestPath;
      const manifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'));
      const packageJson = JSON.parse(
        readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
      );
      const knowledgePath = resolve(
        process.cwd(),
        'src/manifest/smrt-knowledge.json',
      );
      // src/manifest/smrt-knowledge.json is gitignored build output that the
      // package build copies verbatim to dist/smrt-knowledge.json, so it must
      // not carry the clock: a fresh checkout has no previous file for
      // preserveGeneratedAtIfUnchanged to carry a value forward from, and
      // every build would emit different bytes (#2232). Mirrors
      // DETERMINISTIC_GENERATED_AT in src/scanner/types.ts, duplicated as a
      // literal because this script runs before core is built.
      const DeterministicGeneratedAt = '1970-01-01T00:00:00.000Z';
      const knowledge = withDeterministicGeneratedAt(
        DeterministicGeneratedAt,
        buildDomainKnowledgeManifest({
          manifest,
          rootDir: process.cwd(),
          packageJson,
          manifestPath,
          config: {
            includeDocs: true,
            includePrompts: true,
          },
        }),
      );
      publishAtomicArtifact({
        path: knowledgePath,
        content: JSON.stringify(knowledge, null, 2),
      });
      // Core has no Vite producer during its own package build, yet its
      // declared build cache owns this canonical runtime pair. Refresh it
      // from the current production projection, replacing stale test output.
      const localDir = resolve(process.cwd(), '.smrt');
      mkdirSync(localDir, { recursive: true });
      const localManifestPath = resolve(localDir, 'manifest.json');
      const localKnowledgePath = resolve(localDir, 'smrt-knowledge.json');
      publishAtomicArtifact({
        path: localManifestPath,
        content: JSON.stringify(manifest, null, 2),
      });
      publishAtomicArtifact({
        path: localKnowledgePath,
        content: JSON.stringify(
          withDeterministicGeneratedAt(
            DeterministicGeneratedAt,
            buildDomainKnowledgeManifest({
              manifest,
              rootDir: process.cwd(),
              packageJson,
              manifestPath: localManifestPath,
              config: { includeDocs: true, includePrompts: true },
            }),
          ),
          null,
          2,
        ),
      });
    } finally {
      await unregister();
    }
  } catch (error) {
    console.error('[smrt] ❌ Failed to generate manifest:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateManifest();
}

function withDeterministicGeneratedAt(generatedAt, nextKnowledge) {
  return { ...nextKnowledge, generatedAt };
}

export { generateManifest };
