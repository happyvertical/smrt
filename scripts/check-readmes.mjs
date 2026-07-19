#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');
const README = join(ROOT, 'README.md');
const ALLOWED_STATUSES = new Set([
  'Stable',
  'Preview',
  'Experimental',
  'Internal',
  'Deprecated',
]);

function fail(message) {
  failures.push(message);
}

function workspacePackages() {
  const result = [];

  function visit(directory) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      result.push({
        directory,
        relativeDirectory: relative(ROOT, directory).replaceAll('\\', '/'),
        name: manifest.name,
      });
    }

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const child = join(directory, entry.name);
      if (directory === PACKAGES || child.endsWith('/smrt-playground/host')) {
        visit(child);
      }
    }
  }

  visit(PACKAGES);
  return result.sort((a, b) => a.relativeDirectory.localeCompare(b.relativeDirectory));
}

function markdownFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', '.turbo'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(path);
  }
  return result;
}

function readmeLocalLinks(path) {
  const markdown = readFileSync(path, 'utf8');
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|tel:|data:)/i.test(target)) continue;
    if (target.startsWith('#')) continue;
    target = target.split('#', 1)[0].split('?', 1)[0];
    if (!target) continue;
    links.push(decodeURIComponent(target));
  }
  return links;
}

const failures = [];
const packages = workspacePackages();
const rootReadme = readFileSync(README, 'utf8');

for (const pkg of packages) {
  const readmePath = join(pkg.directory, 'README.md');
  if (!existsSync(readmePath)) {
    fail(`${pkg.relativeDirectory} is missing README.md`);
    continue;
  }

  const content = readFileSync(readmePath, 'utf8');
  if (!content.startsWith('# ') || content.trim().length < 120) {
    fail(`${relative(ROOT, readmePath)} is not an appropriate package README`);
  }

  const catalogTarget = `./${pkg.relativeDirectory}/README.md`;
  const escaped = catalogTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = new RegExp(
    `^\\| \\[[^\\]]+\\]\\(${escaped}\\) \\| ([^|]+) \\|`,
    'm',
  ).exec(rootReadme);
  if (!row) {
    fail(`root package catalog is missing ${catalogTarget}`);
  } else if (!ALLOWED_STATUSES.has(row[1].trim())) {
    fail(`root package catalog has an invalid status for ${catalogTarget}`);
  }
}

const catalogLinks = [
  ...rootReadme.matchAll(/\]\(\.\/(packages\/[^)#]+\/README\.md)\)/g),
].map((match) => match[1]);
const expectedCatalogLinks = new Set(
  packages.map((pkg) => `${pkg.relativeDirectory}/README.md`),
);
for (const link of catalogLinks) {
  if (!expectedCatalogLinks.has(link)) {
    fail(`root package catalog contains stale entry ${link}`);
  }
}

const readmes = [README, ...packages.map((pkg) => join(pkg.directory, 'README.md'))];
for (const readme of readmes) {
  for (const target of readmeLocalLinks(readme)) {
    const resolved = resolve(dirname(readme), target);
    if (!existsSync(resolved)) {
      fail(`${relative(ROOT, readme)} has broken local link: ${target}`);
    }
  }
}

for (const path of markdownFiles(ROOT)) {
  if (readFileSync(path, 'utf8').includes('smrt-homer.png')) {
    fail(`${relative(ROOT, path)} still references obsolete smrt-homer.png branding`);
  }
}
for (const asset of [
  join(ROOT, 'smrt-homer.png'),
  join(ROOT, 'docs/content/api/core/_media/smrt-homer.png'),
]) {
  if (existsSync(asset) && statSync(asset).isFile()) {
    fail(`${relative(ROOT, asset)} obsolete branding asset still exists`);
  }
}

const quickstartMatch = rootReadme.match(
  /<!-- quickstart:start -->\s*```typescript\n([\s\S]*?)\n```\s*<!-- quickstart:end -->/,
);
if (!quickstartMatch) {
  fail('root README is missing the validated TypeScript quick-start block');
} else {
  const quickstart = quickstartMatch[1];
  const required = ['SmrtCollection', 'SmrtObject', 'smrt', '@smrt(', 'ProductCollection.create'];
  for (const token of required) {
    if (!quickstart.includes(token)) fail(`quick start is missing supported API token ${token}`);
  }
  const transpiled = ts.transpileModule(quickstart, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
    },
    reportDiagnostics: true,
  });
  for (const diagnostic of transpiled.diagnostics ?? []) {
    if (diagnostic.category === ts.DiagnosticCategory.Error) {
      fail(`quick start TypeScript does not transpile: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
  }

  const coreIndex = readFileSync(join(PACKAGES, 'core/src/index.ts'), 'utf8');
  for (const exportPath of ["export * from './class'", "export * from './collection'", "export * from './registry'"]) {
    if (!coreIndex.includes(exportPath)) {
      fail(`quick start depends on missing core export: ${exportPath}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`README validation failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `README validation passed: ${packages.length} workspace packages, complete catalog, local links, branding, and quick start.`,
  );
}
