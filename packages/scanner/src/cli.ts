#!/usr/bin/env node
/**
 * smrt-scan CLI
 *
 * High-performance TypeScript scanner for SMRT manifest generation.
 *
 * Usage:
 *   smrt-scan [options] [directory]
 *
 * Options:
 *   -o, --output <file>   Output manifest file (default: stdout)
 *   -i, --include <glob>  Include patterns (comma-separated)
 *   -e, --exclude <glob>  Exclude patterns (comma-separated)
 *   --json                Output as JSON (default)
 *   --stats               Output scan statistics
 *   --benchmark           Run performance benchmark
 *   -h, --help            Show help
 *   -v, --version         Show version
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestAdapter } from './manifest-adapter.js';
import { OxcScanner } from './scanner.js';

interface CLIOptions {
  directory: string;
  output?: string;
  include?: string[];
  exclude?: string[];
  json: boolean;
  stats: boolean;
  benchmark: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(args: string[]): CLIOptions {
  const options: CLIOptions = {
    directory: process.cwd(),
    json: true,
    stats: false,
    benchmark: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case '-o':
      case '--output':
        options.output = args[++i];
        break;

      case '-i':
      case '--include':
        options.include = args[++i]?.split(',').map((s) => s.trim());
        break;

      case '-e':
      case '--exclude':
        options.exclude = args[++i]?.split(',').map((s) => s.trim());
        break;

      case '--json':
        options.json = true;
        break;

      case '--stats':
        options.stats = true;
        break;

      case '--benchmark':
        options.benchmark = true;
        break;

      case '-h':
      case '--help':
        options.help = true;
        break;

      case '-v':
      case '--version':
        options.version = true;
        break;

      default:
        // Assume it's the directory if it doesn't start with -
        if (!arg.startsWith('-')) {
          options.directory = resolve(arg);
        }
        break;
    }

    i++;
  }

  return options;
}

function showHelp(): void {
  console.log(`
smrt-scan - High-performance TypeScript scanner for SMRT manifest generation

Usage:
  smrt-scan [options] [directory]

Options:
  -o, --output <file>   Output manifest file (default: stdout)
  -i, --include <glob>  Include patterns (comma-separated)
  -e, --exclude <glob>  Exclude patterns (comma-separated)
  --json                Output as JSON (default)
  --stats               Output scan statistics only
  --benchmark           Run performance benchmark
  -h, --help            Show this help message
  -v, --version         Show version

Examples:
  smrt-scan                           # Scan current directory
  smrt-scan src/                      # Scan src/ directory
  smrt-scan -o manifest.json          # Output to file
  smrt-scan --stats                   # Show scan statistics
  smrt-scan -i "src/**/*.ts" -e "**/*.test.ts"
`);
}

function showVersion(): void {
  // Read version from package.json using ESM-compatible approach
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(__dirname, '../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    console.log(`smrt-scan v${pkg.version}`);
  } catch {
    console.log('smrt-scan v0.0.0');
  }
}

async function runBenchmark(directory: string): Promise<void> {
  console.log(`\nBenchmarking OXC scanner on: ${directory}\n`);

  const iterations = 5;
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const scanner = new OxcScanner({ cwd: directory });
    const start = performance.now();
    await scanner.scan();
    const end = performance.now();
    times.push(end - start);
    process.stdout.write(`  Run ${i + 1}: ${(end - start).toFixed(2)}ms\n`);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`\nResults:`);
  console.log(`  Average: ${avg.toFixed(2)}ms`);
  console.log(`  Min:     ${min.toFixed(2)}ms`);
  console.log(`  Max:     ${max.toFixed(2)}ms`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.version) {
    showVersion();
    process.exit(0);
  }

  if (options.benchmark) {
    await runBenchmark(options.directory);
    process.exit(0);
  }

  // Create scanner
  const scanner = new OxcScanner({
    cwd: options.directory,
    include: options.include,
    exclude: options.exclude,
  });

  // Scan and resolve
  const { results, resolved } = await scanner.scanAndResolve();

  // Check for errors
  if (results.errors.length > 0) {
    console.error('Scan errors:');
    for (const error of results.errors) {
      console.error(
        `  ${error.filePath}:${error.line || '?'}: ${error.message}`,
      );
    }
  }

  // Output stats only
  if (options.stats) {
    const stats = scanner.getStats();
    console.log('Scan Statistics:');
    console.log(`  Files scanned:        ${stats.fileCount}`);
    console.log(`  Total classes:        ${stats.totalClasses}`);
    console.log(`  SMRT classes:         ${stats.smrtClasses}`);
    console.log(`  STI classes:          ${stats.stiClasses}`);
    console.log(`  Max inheritance:      ${stats.maxInheritanceDepth}`);
    console.log(`  Parse time:           ${stats.parseTimeMs.toFixed(2)}ms`);
    process.exit(results.errors.length > 0 ? 1 : 0);
  }

  // Generate manifest
  const adapter = new ManifestAdapter();
  const manifest = adapter.toManifest(resolved);

  const output = JSON.stringify(manifest, null, 2);

  // Write output
  if (options.output) {
    writeFileSync(options.output, output, 'utf-8');
    console.error(`Manifest written to: ${options.output}`);
    console.error(`  Classes: ${resolved.length}`);
    console.error(`  Time: ${results.totalParseTimeMs.toFixed(2)}ms`);
  } else {
    console.log(output);
  }

  process.exit(results.errors.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
