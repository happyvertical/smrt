#!/usr/bin/env tsx
/**
 * Generates the OKF v0.2 component pages under `docs/knowledge/` (#4686).
 *
 * Walks the workspace through the same knowledge pipeline that feeds
 * `smrt-knowledge.json` (`packages/smrt-dev-mcp/src/knowledge/`) and writes one
 * `components/<unscoped-package-name>.md` per workspace package plus the
 * generated `components/index.md` and root `index.md`. Hand-authored concept
 * pages (`intents/`, `solutions/`, ...) are never touched.
 *
 * Run it after `pnpm build` (it is deliberately not part of the build, or the
 * freshness gate could never see a stale page): the model, MCP-tool and agent-surface slices come from the
 * built knowledge artifacts. `pnpm knowledge:check --strict` fails when a page
 * no longer matches its inputs, so CI catches a stale or hand-edited page.
 * The page format, the `source_revision` definition and the `generated.at`
 * rule are documented in `scripts/knowledge-okf.ts`.
 */
import { relative } from 'node:path';
import { buildKnowledgeIndex } from '../packages/smrt-dev-mcp/src/knowledge/index.js';
import {
  buildComponentModels,
  bundleDirFor,
  writeBundle,
} from './knowledge-okf.ts';

async function main(): Promise<void> {
  const index = await buildKnowledgeIndex({ rootDir: process.cwd() });
  const models = buildComponentModels(index);
  const bundleDir = bundleDirFor(index.rootDir);
  const { written, removed } = writeBundle(models, bundleDir, new Date());
  for (const path of removed) console.log(`removed ${path}`);
  console.log(
    `✅ ${relative(index.rootDir, bundleDir)}: ${models.length} component pages, ${written} file${written === 1 ? '' : 's'} updated`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
