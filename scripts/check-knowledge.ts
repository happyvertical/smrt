#!/usr/bin/env tsx
import {
  checkKnowledgeFreshness,
  renderFreshnessResult,
} from '../packages/smrt-dev-mcp/src/knowledge/index.js';

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

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderFreshnessResult(result));
  }

  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
