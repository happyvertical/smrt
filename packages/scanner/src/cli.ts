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

  // A scan with errors has no complete manifest to write: the diagnostics
  // above name values and classes that would be missing from it.
  if (results.errors.some((error) => error.severity === 'error')) {
    console.error('No manifest written: fix the scan errors above.');
    process.exit(1);
  }

  // Read package.json for metadata (Issue #713 - namespace isolation)
  let packageName: string | undefined;
  let packageVersion: string | undefined;
  try {
    const pkgPath = resolve(options.directory, 'package.json');
    const pkgContent = readFileSync(pkgPath, 'utf-8');
    const packageJson = JSON.parse(pkgContent);
    packageName = packageJson.name || undefined;
    packageVersion = packageJson.version || undefined;
  } catch {
    // package.json not found or invalid - continue without packageName
    console.error(
      'Warning: package.json not found. Qualified names will not be generated.',
    );
  }

  // Generate manifest with packageName for qualified names (Issue #713)
  const adapter = new ManifestAdapter();
  const manifest = adapter.toManifest(resolved, {
    packageName,
    packageVersion,
    typeAliases: results.typeAliases,
  });

  // The generation checks a SMRT producer runs (confirmed parents, known
  // relationship and report targets) need the dependency manifests, which
  // this standalone command does not read. Anything it cannot confirm from
  // the scan itself refuses the output rather than publish it unchecked.
  const unconfirmed = unconfirmedIdentities(manifest);
  if (unconfirmed.length > 0) {
    console.error('Cannot confirm from this scan alone:');
    for (const problem of unconfirmed) console.error(`  ${problem}`);
    console.error(
      'No manifest written: build with the SMRT producer (ManifestBuilder or the Vite plugin), which reads dependency manifests, or name targets this package declares.',
    );
    process.exit(1);
  }

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

/**
 * Parents, relationship targets and report sources in `manifest` that the
 * scan alone cannot confirm: another package's export (its manifest is not
 * read here), or a name no class of this manifest has.
 */
function unconfirmedIdentities(manifest: {
  packageName?: string;
  objects: Record<
    string,
    {
      className: string;
      packageName?: string;
      extendsQualified?: string;
      fields?: Record<
        string,
        { type?: string; related?: string; relatedQualified?: string }
      >;
      decoratorConfig?: Record<string, unknown>;
    }
  >;
}): string[] {
  // Identity is the package and the class together: a name qualified with
  // another package is that package's class, whatever this scan declares.
  const identities = new Set(
    Object.values(manifest.objects).map((obj) =>
      `${obj.packageName ?? manifest.packageName ?? ''}:${obj.className}`.toLowerCase(),
    ),
  );
  const names = new Set(
    Object.values(manifest.objects).map((obj) => obj.className.toLowerCase()),
  );
  const own = (manifest.packageName ?? '').toLowerCase();
  /** `undefined` for a known class, else why it cannot be confirmed here. */
  const unconfirmed = (name: string): string | undefined => {
    const separator = name.lastIndexOf(':');
    const className = name
      .slice(separator + 1)
      .split('.')[0]
      ?.toLowerCase();
    if (separator < 0) {
      return names.has(className ?? '')
        ? undefined
        : 'which no class of this scan declares';
    }
    const packageName = name.slice(0, separator).toLowerCase();
    if (packageName !== own) return "another package's export";
    return identities.has(`${packageName}:${className}`)
      ? undefined
      : 'which no class of this scan declares';
  };
  const problems: string[] = [];
  for (const obj of Object.values(manifest.objects)) {
    const parentProblem = obj.extendsQualified
      ? unconfirmed(obj.extendsQualified)
      : undefined;
    if (obj.extendsQualified && parentProblem) {
      problems.push(
        `${obj.className} extends ${obj.extendsQualified}, ${parentProblem}`,
      );
    }
    for (const [name, field] of Object.entries(obj.fields ?? {})) {
      if (!['foreignKey', 'oneToMany', 'manyToMany'].includes(field.type ?? ''))
        continue;
      if (field.relatedQualified) {
        problems.push(
          `${obj.className}.${name} targets ${field.relatedQualified}, another package's export`,
        );
      } else if (!field.related?.trim()) {
        problems.push(`${obj.className}.${name} names no target`);
      } else {
        const problem = unconfirmed(field.related);
        if (problem) {
          problems.push(
            `${obj.className}.${name} targets "${field.related}", ${problem}`,
          );
        }
      }
    }
    const report = obj.decoratorConfig?.report as
      | {
          source?: unknown;
          sourceQualified?: unknown;
          joins?: Record<
            string,
            { source?: unknown; sourceQualified?: unknown }
          >;
        }
      | undefined;
    for (const [path, holder] of [
      ['source', report],
      ...Object.entries(report?.joins ?? {}).map(
        ([join, entry]) => [`joins.${join}.source`, entry] as const,
      ),
    ] as const) {
      if (!holder) continue;
      if (typeof holder.sourceQualified === 'string') {
        problems.push(
          `${obj.className} @report() ${path} is ${holder.sourceQualified}, another package's export`,
        );
      } else if (typeof holder.source === 'string' && holder.source !== '') {
        const problem = unconfirmed(holder.source);
        if (problem) {
          problems.push(
            `${obj.className} @report() ${path} is "${holder.source}", ${problem}`,
          );
        }
      }
    }
  }
  return problems;
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
