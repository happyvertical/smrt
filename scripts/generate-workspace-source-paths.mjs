import {
  existsSync,
  globSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import {
  getWorkspaceExportSources,
  resolveWorkspaceExportSource,
  workspaceExportTarget,
} from '../packages/vitest/src/workspace-exports.ts';
import { isTestArtifact } from './package-test-artifacts.mjs';

export const configName = 'tsconfig.workspace-source-paths.json';

const declarationExtension = /\.d\.[cm]?ts$/;
const sourceExtension = /(?<!\.d)\.([cm]?)ts$/;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const isFile = (file) => statSync(file, { throwIfNoEntry: false })?.isFile();

function declarationTarget(value) {
  if (typeof value === 'string') {
    return declarationExtension.test(value) ? value : undefined;
  }
  if (typeof value?.types === 'string') return value.types;
  return Object.values(value ?? {}).map(declarationTarget).find(Boolean);
}

function exactSource(packageRoot, declaration, runtimeSource) {
  if (declaration && !declaration.startsWith('./dist/')) {
    const declarationFile = join(packageRoot, declaration);
    if (isFile(declarationFile)) return declarationFile;
  }
  if (runtimeSource && isFile(runtimeSource)) return runtimeSource;
  if (!declaration) return undefined;

  const sourceName = declaration
    .replace(/^\.\/dist\//, '')
    .replace(/\.d(?=\.[cm]?ts$)/, '');
  // The SvelteKit template publishes dist/host/*.d.ts from host/*.ts.
  // The src layouts also support an export that only declares types.
  return ['src', 'src/lib', '']
    .map((base) => join(packageRoot, base, sourceName))
    .find(isFile);
}

function workspaceExportPatterns(exportsMap) {
  return Object.keys(exportsMap)
    .filter((key) => key.startsWith('./') && key.includes('*'))
    .map((key) => {
      const [prefix, suffix] = key.split('*');
      return { key, prefix, suffix };
    })
    // Node prefers the longest prefix; a longer suffix breaks prefix ties.
    .sort((left, right) =>
      right.prefix.length - left.prefix.length ||
      right.suffix.length - left.suffix.length,
    );
}

function* patternSources(packageRoot, subpath, declared, runtimeTarget) {
  const target = declared ?? runtimeTarget;
  if (!target?.startsWith('./dist/') || !target.includes('*')) return;

  // Exact concrete entries preserve export spelling (for example, utils/*.js)
  // and avoid widening the wildcard to siblings, tests, and other source files.
  const [prefix, suffix] = target.slice('./dist/'.length).split('*');
  const searchDir = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  for (const base of ['src', 'src/lib']) {
    const sourceRoot = join(packageRoot, base);
    const searchRoot = join(sourceRoot, searchDir);
    if (!existsSync(searchRoot)) continue;
    for (const file of globSync('**/*', { cwd: searchRoot })) {
      if (!sourceExtension.test(file) || isTestArtifact(file)) continue;
      const source = join(searchRoot, file);
      if (!isFile(source)) continue;
      const built = relative(sourceRoot, source)
        .replaceAll('\\', '/')
        .replace(sourceExtension, declared ? '.d.$1ts' : '.$1js');
      if (!built.startsWith(prefix) || !built.endsWith(suffix)) continue;

      const capture = built.slice(prefix.length, built.length - suffix.length);
      if (!capture) continue;
      const concrete = subpath.replace('*', capture);
      if (
        declared ||
        resolveWorkspaceExportSource(packageRoot, concrete) === source
      ) {
        yield [concrete, source];
      }
    }
  }
}

export function generateWorkspaceSourcePaths(root) {
  const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
  const paths = {};
  for (const directory of globSync(workspace.packages, { cwd: root })) {
    const packageRoot = join(root, directory);
    const manifest = join(packageRoot, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name, exports: exportsMap } = readJson(manifest);
    if (!exportsMap || typeof exportsMap !== 'object') continue;

    const specifier = (key) => (key === '.' ? name : `${name}${key.slice(1)}`);
    const record = (key, source) => {
      paths[specifier(key)] = [
        `./${relative(root, source).replaceAll('\\', '/')}`,
      ];
    };
    const runtimeSources = new Map(
      getWorkspaceExportSources(packageRoot).map(
        ({ subpath, target, source }) => [subpath, { target, source }],
      ),
    );
    const patterns = workspaceExportPatterns(exportsMap);

    for (const [subpath, value] of Object.entries(exportsMap)) {
      if (!subpath.startsWith('.')) continue;
      const declared = declarationTarget(value);
      if (subpath.includes('*')) {
        const runtime = workspaceExportTarget(packageRoot, subpath);
        const sources = [
          ...patternSources(packageRoot, subpath, declared, runtime),
        ];
        if (declared && sources.length === 0) {
          throw new Error(
            `No source for typed export pattern ${specifier(subpath)} -> ${declared}`,
          );
        }
        for (const [key, source] of sources) {
          if (Object.hasOwn(exportsMap, key) || Object.hasOwn(paths, specifier(key))) {
            continue;
          }
          const matched = patterns.find(
            ({ prefix, suffix }) =>
              key.length >= prefix.length + suffix.length &&
              key.startsWith(prefix) &&
              key.endsWith(suffix),
          );
          if (matched.key === subpath) record(key, source);
        }
        continue;
      }

      const runtime = runtimeSources.get(subpath);
      if (!declared && !runtime?.target.startsWith('./dist/')) continue;
      const source = exactSource(packageRoot, declared, runtime?.source);
      if (source) record(subpath, source);
      if (!source && declared) {
        throw new Error(
          `No source for typed export ${specifier(subpath)} -> ${declared}`,
        );
      }
      // Runtime-only outputs (workers, manifests, knowledge, CSS, and app
      // assets) may be generated. Their existing artifact consumers use the
      // exports map; a source check must avoid inventing a replacement.
    }
  }
  return {
    compilerOptions: {
      paths: Object.fromEntries(
        Object.keys(paths)
          .sort()
          .map((key) => [key, paths[key]]),
      ),
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = join(root, configName);
  const generated = generateWorkspaceSourcePaths(root);
  if (process.argv.length === 3 && process.argv[2] === '--check') {
    if (!isDeepStrictEqual(readJson(config), generated)) {
      throw new Error(
        'Workspace source paths are stale. Run node scripts/generate-workspace-source-paths.mjs.',
      );
    }
  } else if (process.argv.length === 2) {
    writeFileSync(config, `${JSON.stringify(generated, null, 2)}\n`);
  } else {
    throw new Error(
      'Usage: node scripts/generate-workspace-source-paths.mjs [--check]',
    );
  }
}
