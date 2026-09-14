#!/usr/bin/env tsx
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkKnowledgeGraphFreshness } from '../packages/core/src/knowledge-graph.js';
import {
  checkKnowledgeFreshness,
  renderFreshnessResult,
} from '../packages/smrt-dev-mcp/src/knowledge/index.js';

/**
 * Whether any package currently has a built `smrt-knowledge.json`. The root
 * graph (#2863) is only required once at least one package has opted in —
 * a checkout that has not run `pnpm build` yet, or a repo with no package
 * exporting `./smrt-knowledge.json`, has nothing to merge.
 */
function hasAnyPackageKnowledgeArtifact(rootDir: string): boolean {
  const packagesDir = join(rootDir, 'packages');
  if (!existsSync(packagesDir)) return false;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(packagesDir, entry.name);
    if (
      existsSync(join(packageDir, 'dist', 'smrt-knowledge.json')) ||
      existsSync(join(packageDir, '.smrt', 'smrt-knowledge.json'))
    ) {
      return true;
    }
  }
  return false;
}

type OutputFormat = 'json' | 'markdown';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function showHelp(): void {
  console.log(`Usage: pnpm knowledge:check [options]

Options:
  --changed          Limit stale-pattern checks to changed files
  --strict           Treat stale-pattern findings as errors
  --format <format>  Output format: markdown or json (default: markdown)
  --json             Deprecated alias for --format json
  --help             Show this help text`);
}

async function main(): Promise<void> {
  if (hasFlag('--help')) {
    showHelp();
    return;
  }

  const format = (
    hasFlag('--json') ? 'json' : optionValue('--format') || 'markdown'
  ) as OutputFormat;

  if (format !== 'json' && format !== 'markdown') {
    console.error(`Unknown output format: ${format}`);
    process.exit(2);
  }

  const result = await checkKnowledgeFreshness({
    changed: hasFlag('--changed'),
    strict: hasFlag('--strict'),
  });

  // The merged root graph (#2863) is checked alongside each package's own
  // artifact: it is stale, in the same sense, whenever any per-package
  // artifact it was built from has changed since generation.
  const graphIssues = checkKnowledgeGraphFreshness(
    process.cwd(),
    '.smrt/smrt-knowledge-graph.json',
    { requireArtifact: hasAnyPackageKnowledgeArtifact(process.cwd()) },
  );
  const combinedIssues = [...result.issues, ...graphIssues];
  const combinedErrorCount =
    result.errorCount +
    graphIssues.filter((i) => i.severity === 'error').length;
  const combinedResult = {
    ...result,
    ok: result.ok && graphIssues.length === 0,
    issueCount: combinedIssues.length,
    errorCount: combinedErrorCount,
    issues: combinedIssues,
  };

  if (format === 'json') {
    console.log(JSON.stringify(combinedResult, null, 2));
  } else {
    console.log(renderFreshnessResult(combinedResult));
    if (graphIssues.length > 0) {
      console.log('\n## Knowledge graph\n');
      for (const issue of graphIssues) {
        console.log(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
      }
    }
  }

  if (!combinedResult.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
