#!/usr/bin/env node

/**
 * Build-time manifest generator
 * Scans TypeScript source files and generates static manifest JSON
 *
 * Now uses ManifestBuilder service for consolidated, testable logic
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

      const { buildDomainKnowledgeManifest } = await import(
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
      const knowledge = preserveGeneratedAtIfUnchanged(
        knowledgePath,
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
      writeFileSync(knowledgePath, JSON.stringify(knowledge, null, 2), 'utf8');
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

function preserveGeneratedAtIfUnchanged(path, nextKnowledge) {
  if (!existsSync(path)) {
    return nextKnowledge;
  }

  try {
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (semanticArtifactJson(current) === semanticArtifactJson(nextKnowledge)) {
      return {
        ...nextKnowledge,
        generatedAt: current.generatedAt,
      };
    }
  } catch {
    // Replace malformed artifacts.
  }

  return nextKnowledge;
}

function semanticArtifactJson(artifact) {
  const { generatedAt: _generatedAt, ...rest } = artifact ?? {};
  return stableJson(rest);
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

export { generateManifest };
