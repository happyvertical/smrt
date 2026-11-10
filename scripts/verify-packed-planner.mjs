#!/usr/bin/env node
/**
 * Offline check of a packed `@happyvertical/smrt-planner` tarball, run by
 * `validate-publish-packages.js` for that package: the static app and MCP
 * widget are inside (`app/`, which released `smrt kitchen` CLIs resolve), the
 * guidance ships, and the catalog was generated from this release: every
 * catalog package carries the planner's own version, so a planner can never
 * describe packages other than the ones published beside it.
 *
 * Usage: node scripts/verify-packed-planner.mjs <tarball>
 */
import { spawnSync } from 'node:child_process';
import { parse } from 'acorn';
import { pathToFileURL } from 'node:url';

const REQUIRED_ENTRIES = [
  'package/package.json',
  'package/AGENTS.md',
  'package/README.md',
  'package/app/index.html',
  'package/app/404.html',
  'package/app/mcp.html',
  'package/dist/index.js',
  'package/dist/core/index.js',
  'package/dist/catalog/catalog.json',
  'package/dist/smrt-version.js',
];

function tar(args) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Static and dynamic import specifiers of an ES module's source, from a real
 * parse (string and template contents that look like imports are ignored).
 */
export function moduleImports(source) {
  const specifiers = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration' ||
        node.type === 'ImportExpression') &&
      node.source
    ) {
      specifiers.push(
        node.source.type === 'Literal' ? String(node.source.value) : '<dynamic>',
      );
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  return specifiers;
}

/**
 * Problems with a packed planner, given its file list and readers for the
 * entries checked. Pure, so the rules are unit-tested without a tarball.
 */
export function plannerTarballProblems({ entries, readJson, readText }) {
  const problems = [];
  const present = new Set(entries);
  for (const entry of REQUIRED_ENTRIES) {
    if (!present.has(entry)) problems.push(`missing ${entry}`);
  }
  if (problems.length > 0) return problems;
  const { version } = readJson('package/package.json');
  const catalog = readJson('package/dist/catalog/catalog.json');
  const packages = Array.isArray(catalog.packages) ? catalog.packages : [];
  if (packages.length === 0) problems.push('catalog lists no packages');
  for (const pkg of packages) {
    if (pkg.version !== version) {
      problems.push(
        `catalog ${pkg.packageName}@${pkg.version} is not this release (${version})`,
      );
    }
  }
  if (typeof catalog.registry !== 'string' || !/^https:\/\//.test(catalog.registry)) {
    problems.push(`catalog registry ${catalog.registry} is not a release registry`);
  }
  if (!readText('package/dist/smrt-version.js').includes(`'${version}'`)) {
    problems.push(`dist/smrt-version.js does not name ${version}`);
  }
  if (!readText('package/app/mcp.html').includes('id="smrt-planner-entry"')) {
    problems.push('app/mcp.html is not the self-contained planner widget');
  }
  // `smrt kitchen` imports ./core from its cache without installing the
  // planner's dependencies (#4238): the entry must be one self-contained file.
  const coreImports = moduleImports(readText('package/dist/core/index.js'));
  const external = coreImports.filter(
    (specifier) => !specifier.startsWith('node:'),
  );
  if (external.length > 0) {
    problems.push(
      `dist/core/index.js is not self-contained (imports ${external.join(', ')})`,
    );
  }
  return problems;
}

function main(tarball) {
  if (!tarball) {
    console.error('usage: node scripts/verify-packed-planner.mjs <tarball>');
    process.exit(2);
  }
  const entries = tar(['-tzf', tarball])
    .split('\n')
    .filter(Boolean)
    .map((entry) => entry.replace(/\/$/, ''));
  const readText = (entry) => tar(['-xzOf', tarball, entry]);
  const problems = plannerTarballProblems({
    entries,
    readText,
    readJson: (entry) => JSON.parse(readText(entry)),
  });
  if (problems.length > 0) {
    console.error(`❌ ${tarball}:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`✅ packed planner carries its app, widget and this release's catalog`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv[2]);
}
