#!/usr/bin/env tsx
/**
 * Merges every discoverable per-package `smrt-knowledge.json` into the root
 * cross-package graph at `.smrt/smrt-knowledge-graph.json` (#2863).
 *
 * Discovery deliberately checks both locations `docs/content/standards.md`
 * documents for the artifact: `packages/<pkg>/.smrt/smrt-knowledge.json`
 * (local dev/build) and `packages/<pkg>/dist/smrt-knowledge.json` (package
 * build output), preferring `dist` when both exist since that is the
 * published, `files`-allowlisted artifact. A package that has not yet been
 * built, or does not export `./smrt-knowledge.json`, simply contributes no
 * nodes — this script never invents or requires generation across packages
 * that have not opted in.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  buildKnowledgeGraph,
  discoverKnowledgeArtifactPaths,
  type KnowledgeGraphInput,
  stableStringify,
} from '../packages/core/src/knowledge-graph.js';

const rootDir = resolveRepoRoot();
const outputPath = join(rootDir, '.smrt', 'smrt-knowledge-graph.json');

function resolveRepoRoot(): string {
  // scripts/generate-knowledge-graph.ts runs from the repo root via `tsx`.
  return process.cwd();
}

function discoverInputs(): KnowledgeGraphInput[] {
  const inputs: KnowledgeGraphInput[] = [];
  for (const artifactPath of discoverKnowledgeArtifactPaths(rootDir)) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(rootDir, artifactPath), 'utf8'),
      );
      inputs.push({ artifactPath, manifest });
    } catch (error) {
      console.warn(
        `⚠️  Skipping ${artifactPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return inputs;
}

function main(): void {
  const inputs = discoverInputs();
  const graph = buildKnowledgeGraph(inputs);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${stableStringify(graph)}\n`, 'utf8');
  console.log(
    `✅ Wrote ${relative(rootDir, outputPath)} (${graph.packages.length} packages, ${graph.objects.length} objects, ${graph.edges.length} edges)`,
  );
}

main();
