#!/usr/bin/env node

/**
 * Test manifest generator
 * Scans test files and generates manifest for runtime field detection
 *
 * This allows test files to use TypeScript type annotations (e.g., latitude: number | null)
 * instead of requiring explicit Field helpers, maintaining consistency with production code.
 *
 * Now uses ManifestBuilder service for consolidated, testable logic
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

async function generateTestManifest() {
  try {
    console.log('[smrt] Generating test manifest...');

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

      const manifest = await builder.generate({
        // === FILE DISCOVERY ===
        // Scan all source files including test files for test manifest
        // Test classes defined inline need to be in the manifest for proper field detection
        include: ['src/**/*.ts'],
        exclude: [
          'src/**/*.d.ts',
          'src/manifest/static-manifest.ts',
          'src/manifest/test-manifest-stub.ts',
          'node_modules/**',
        ],

        // === SCANNER CONFIGURATION ===
        baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
        followImports: true, // Needed for multi-package inheritance (e.g., Meeting extends Event from external package)
        loadViteConfig: true, // Use custom baseClasses from vite.config.ts if present
        discoverExternalPackages: true,
        includeExternalBaseClasses: true, // Test manifest needs external base classes

        // === OUTPUT CONFIGURATION ===
        outputDir: 'src/manifest',
        outputName: 'test-manifest.json',
        generateTypeStub: true,
        stubName: 'test-manifest-stub.ts',

        // === METADATA ===
        injectPackageInfo: true,
        moduleType: 'smrt',
      });
      const {
        AGENT_SURFACE_HASH_PREFIX,
        buildDomainKnowledgeManifest,
        publishAtomicArtifact,
        resolveFileKnowledgeConfig,
      } = await import(
        pathToFileURL(resolve(process.cwd(), 'src/knowledge.ts')).href
      );
      const manifestPath = resolve(process.cwd(), '.smrt/manifest.json');
      const knowledgePath = resolve(process.cwd(), '.smrt/smrt-knowledge.json');
      let priorKnowledge;
      try {
        priorKnowledge = JSON.parse(readFileSync(knowledgePath, 'utf8'));
      } catch {
        // A missing or malformed prior artifact is replaced by current generation.
      }
      const config = await resolveFileKnowledgeConfig(
        process.cwd(),
        manifest.packageName,
      );
      if (config.enabled !== false) {
        const knowledge = buildDomainKnowledgeManifest({
          manifest,
          rootDir: process.cwd(),
          manifestPath,
          config,
        });
        const priorSurfaceHashes = Object.entries(
          priorKnowledge?.sourceHashes ?? {},
        ).filter(([key]) => key.startsWith(AGENT_SURFACE_HASH_PREFIX));
        if (priorKnowledge?.agentSurface && priorSurfaceHashes.length) {
          // This script does not run the producer scanner. Preserve the prior
          // declaration with its prior hashes so an edited declaration stays
          // stale instead of being rehashed as a false-fresh artifact.
          knowledge.agentSurface = priorKnowledge.agentSurface;
          Object.assign(
            knowledge.sourceHashes,
            Object.fromEntries(priorSurfaceHashes),
          );
        }
        publishAtomicArtifact({
          path: knowledgePath,
          content: JSON.stringify(knowledge, null, 2),
        });
      } else if (existsSync(knowledgePath)) {
        unlinkSync(knowledgePath);
      }
    } finally {
      await unregister();
    }
  } catch (error) {
    console.error('[smrt] ❌ Failed to generate test manifest:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateTestManifest();
}

export { generateTestManifest };
