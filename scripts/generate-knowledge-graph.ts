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

/**
 * A discovered artifact that cannot be read as JSON is a generation error,
 * not a package that opted out: unlike a package that never produced an
 * artifact, `discoverKnowledgeArtifactPaths` already found this file on
 * disk, so silently omitting it would merge an incomplete graph and report
 * success (#2872 review).
 */
function discoverInputs(): KnowledgeGraphInput[] {
  const inputs: KnowledgeGraphInput[] = [];
  for (const artifactPath of discoverKnowledgeArtifactPaths(rootDir)) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(rootDir, artifactPath), 'utf8'));
    } catch (error) {
      console.error(
        `❌ ${artifactPath} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    }
    inputs.push({
      artifactPath,
      manifest: manifest as KnowledgeGraphInput['manifest'],
    });
  }
  return inputs;
}

function readPreviousGraph():
  | ReturnType<typeof buildKnowledgeGraph>
  | undefined {
  try {
    return JSON.parse(readFileSync(outputPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function main(): void {
  const inputs = discoverInputs();
  const graph = buildKnowledgeGraph(inputs, {
    previousGraph: readPreviousGraph(),
  });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${stableStringify(graph)}\n`, 'utf8');
  console.log(
    `✅ Wrote ${relative(rootDir, outputPath)} (${graph.packages.length} packages, ${graph.objects.length} objects, ${graph.edges.length} edges)`,
  );
}

main();
