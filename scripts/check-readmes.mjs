#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { discoverWorkspaces } from './workspaces.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const README = join(ROOT, 'README.md');
const ALLOWED_STATUSES = new Set([
  'Stable',
  'Preview',
  'Experimental',
  'Internal',
  'Deprecated',
]);

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

export function markdownProse(markdown) {
  let fenced = false;
  let fence = '';
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line);
      if (marker) {
        if (!fenced) {
          fenced = true;
          fence = marker[1][0];
        } else if (marker[1][0] === fence) {
          fenced = false;
          fence = '';
        }
        return '';
      }
      if (fenced) return '';
      return line.replace(/`+[^`]*`+/g, '');
    })
    .join('\n');
}

export function hasObsoleteBrandName(markdown) {
  return /\bSMRT\b/.test(markdownProse(markdown));
}

export function hasApplicationManifestRegistration(sourceText, fileName = 'manifest-registration.ts') {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'ObjectRegistry' &&
      node.expression.name.text === 'registerPackageManifest' &&
      node.arguments.length === 1 &&
      ts.isNewExpression(node.arguments[0]) &&
      ts.isIdentifier(node.arguments[0].expression) &&
      node.arguments[0].expression.text === 'URL' &&
      node.arguments[0].arguments?.length === 2 &&
      ts.isStringLiteral(node.arguments[0].arguments[0]) &&
      node.arguments[0].arguments[0].text === '../.smrt/manifest.json' &&
      ts.isPropertyAccessExpression(node.arguments[0].arguments[1]) &&
      node.arguments[0].arguments[1].name.text === 'url' &&
      ts.isMetaProperty(node.arguments[0].arguments[1].expression) &&
      node.arguments[0].arguments[1].expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0].arguments[1].expression.name.text === 'meta'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function validateQuickstart(quickstart, root = ROOT) {
  const quickstartPath = join(root, '.readme-quickstart.ts');
  const coreIndexPath = join(root, 'packages/core/src/index.ts');
  const options = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    experimentalDecorators: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: root,
    paths: { '@happyvertical/smrt-core': [coreIndexPath] },
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(fileName) === quickstartPath
      ? ts.createSourceFile(fileName, quickstart, languageVersion, true, ts.ScriptKind.TS)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = ((original) => (fileName) =>
    resolve(fileName) === quickstartPath || original(fileName))(host.fileExists.bind(host));
  host.readFile = ((original) => (fileName) =>
    resolve(fileName) === quickstartPath ? quickstart : original(fileName))(host.readFile.bind(host));

  const program = ts.createProgram([quickstartPath, coreIndexPath], options, host);
  const quickstartSource = program.getSourceFile(quickstartPath);
  const diagnostics = ts.getPreEmitDiagnostics(program, quickstartSource).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  const failures = diagnostics.map(
    (diagnostic) =>
      `quick start TypeScript is not semantically valid: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
  );

  const checker = program.getTypeChecker();
  const coreSource = program.getSourceFile(coreIndexPath);
  const moduleSymbol = coreSource && checker.getSymbolAtLocation(coreSource);
  const exports = new Map(
    (moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []).map((symbol) => [
      symbol.name,
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
    ]),
  );
  for (const name of ['ObjectRegistry', 'SmrtCollection', 'SmrtObject', 'smrt']) {
    const symbol = exports.get(name);
    if (!symbol || !(symbol.flags & ts.SymbolFlags.Value)) {
      failures.push(`@happyvertical/smrt-core is missing runtime export ${name}`);
    }
  }

  if (!hasApplicationManifestRegistration(quickstart, quickstartPath)) {
    failures.push('quick start does not register the generated application manifest');
  }
  return failures;
}

export async function checkReadmes(root = ROOT) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const workspaces = await discoverWorkspaces(root);
  const packages = workspaces.map((workspace) => {
    const manifest = JSON.parse(readFileSync(join(workspace.path, 'package.json'), 'utf8'));
    return {
      directory: workspace.path,
      relativeDirectory: relative(root, workspace.path).replaceAll('\\', '/'),
      name: manifest.name,
    };
  });
  const readmePath = join(root, 'README.md');
  const rootReadme = readFileSync(readmePath, 'utf8');

  for (const pkg of packages) {
    const packageReadme = join(pkg.directory, 'README.md');
    if (!existsSync(packageReadme)) {
      fail(`${pkg.relativeDirectory} is missing README.md`);
      continue;
    }
    const content = readFileSync(packageReadme, 'utf8');
    if (!content.startsWith('# ') || content.trim().length < 120) {
      fail(`${relative(root, packageReadme)} is not an appropriate package README`);
    }
    const catalogTarget = `./${pkg.relativeDirectory}/README.md`;
    const escaped = catalogTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = new RegExp(`^\\| \\[[^\\]]+\\]\\(${escaped}\\) \\| ([^|]+) \\|`, 'm').exec(
      rootReadme,
    );
    if (!row) fail(`root package catalog is missing ${catalogTarget}`);
    else if (!ALLOWED_STATUSES.has(row[1].trim())) {
      fail(`root package catalog has an invalid status for ${catalogTarget}`);
    }
  }

  const catalogLinks = [...rootReadme.matchAll(/\]\(\.\/(packages\/[^)#]+\/README\.md)\)/g)].map(
    (match) => match[1],
  );
  const expectedCatalogLinks = new Set(packages.map((pkg) => `${pkg.relativeDirectory}/README.md`));
  for (const link of catalogLinks) {
    if (!expectedCatalogLinks.has(link)) fail(`root package catalog contains stale entry ${link}`);
  }

  const readmes = [readmePath, ...packages.map((pkg) => join(pkg.directory, 'README.md'))];
  const brandedMarkdown = [
    ...readmes,
    join(root, 'docs/README.md'),
    join(root, 'docs/content/index.md'),
  ].filter(existsSync);
  for (const readme of brandedMarkdown) {
    if (hasObsoleteBrandName(readFileSync(readme, 'utf8'))) {
      fail(`${relative(root, readme)} uses obsolete SMRT prose; write s-m-r-t`);
    }
  }
  for (const readme of readmes) {
    for (const target of readmeLocalLinks(readme)) {
      if (!existsSync(resolve(dirname(readme), target))) {
        fail(`${relative(root, readme)} has broken local link: ${target}`);
      }
    }
  }

  for (const path of markdownFiles(root)) {
    if (readFileSync(path, 'utf8').includes('smrt-homer.png')) {
      fail(`${relative(root, path)} still references obsolete smrt-homer.png branding`);
    }
  }
  for (const asset of [
    join(root, 'smrt-homer.png'),
    join(root, 'docs/content/api/core/_media/smrt-homer.png'),
  ]) {
    if (existsSync(asset) && statSync(asset).isFile()) {
      fail(`${relative(root, asset)} obsolete branding asset still exists`);
    }
  }

  const quickstartMatch = rootReadme.match(
    /<!-- quickstart:start -->\s*```typescript\n([\s\S]*?)\n```\s*<!-- quickstart:end -->/,
  );
  if (!quickstartMatch) fail('root README is missing the validated TypeScript quick-start block');
  else failures.push(...validateQuickstart(quickstartMatch[1], root));

  if (failures.length > 0) {
    throw new Error(
      `README validation failed with ${failures.length} issue(s):\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    );
  }
  return packages.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkReadmes()
    .then((count) => {
      console.log(
        `README validation passed: ${count} workspace packages, complete catalog, local links, s-m-r-t branding, and quick start.`,
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
