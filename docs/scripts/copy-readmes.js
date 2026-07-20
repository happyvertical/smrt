#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverWorkspaces } from '../../scripts/workspaces.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '../..');
const outputDir = join(scriptDir, '../content/packages');

export function markdownDestinations(markdown) {
  const destinations = [];
  for (let index = 0; index < markdown.length; index += 1) {
    const image = markdown[index] === '!';
    const labelStart = image ? index + 1 : index;
    if (markdown[labelStart] !== '[' || (labelStart > 0 && markdown[labelStart - 1] === '\\')) continue;

    let cursor = labelStart + 1;
    for (; cursor < markdown.length; cursor += 1) {
      if (markdown[cursor] === '\\') cursor += 1;
      else if (markdown[cursor] === ']') break;
    }
    if (markdown[cursor] !== ']' || markdown[cursor + 1] !== '(') continue;
    cursor += 2;
    while (/\s/.test(markdown[cursor] ?? '')) cursor += 1;

    let start = cursor;
    let end;
    if (markdown[cursor] === '<') {
      start = ++cursor;
      for (; cursor < markdown.length; cursor += 1) {
        if (markdown[cursor] === '\\') cursor += 1;
        else if (markdown[cursor] === '>') {
          end = cursor;
          break;
        }
      }
    } else {
      let depth = 0;
      for (; cursor < markdown.length; cursor += 1) {
        const character = markdown[cursor];
        if (character === '\\') cursor += 1;
        else if (character === '(') depth += 1;
        else if (character === ')' && depth > 0) depth -= 1;
        else if (character === ')' || (/\s/.test(character) && depth === 0)) {
          end = cursor;
          break;
        }
      }
    }
    if (end === undefined || end === start) continue;
    destinations.push({ start, end, target: markdown.slice(start, end), image });
    index = cursor;
  }
  return destinations;
}

function encodeRepositoryPath(pathname) {
  return pathname
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (byte) => `%${byte.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
}

export async function rewriteLocalLinks(markdown, source, root = repoRoot) {
  const canonicalRoot = await realpath(root);
  const canonicalSource = await realpath(source);
  if (!isInside(canonicalRoot, canonicalSource)) {
    throw new Error(`README source resolves outside the repository: ${source}`);
  }
  const replacements = [];
  for (const destination of markdownDestinations(markdown)) {
    const rawTarget = destination.target;
    if (!rawTarget || /^(?:https?:|mailto:|tel:|data:)/i.test(rawTarget)) continue;
    if (rawTarget.startsWith('#')) continue;

    const pathEnd = rawTarget.search(/[?#]/);
    const pathname = pathEnd === -1 ? rawTarget : rawTarget.slice(0, pathEnd);
    const suffix = pathEnd === -1 ? '' : rawTarget.slice(pathEnd);
    if (!pathname) continue;

    const sourcePath = relative(canonicalRoot, canonicalSource).replaceAll('\\', '/');
    let decodedPathname;
    try {
      decodedPathname = decodeURIComponent(pathname.replace(/\\([\\()`])/g, '$1'));
    } catch (error) {
      throw new Error(
        `Malformed URL encoding in ${sourcePath} link "${rawTarget}": ${error.message}`,
        { cause: error },
      );
    }

    const resolved = resolve(dirname(canonicalSource), decodedPathname);
    let canonicalTarget;
    try {
      canonicalTarget = await realpath(resolved);
    } catch (error) {
      throw new Error(`Local link in ${sourcePath} does not exist: "${rawTarget}"`, {
        cause: error,
      });
    }
    const repoPath = relative(canonicalRoot, canonicalTarget).replaceAll('\\', '/');
    if (!isInside(canonicalRoot, canonicalTarget)) {
      throw new Error(`Local link in ${sourcePath} resolves outside the repository: "${rawTarget}"`);
    }

    let targetStat;
    try {
      targetStat = await stat(canonicalTarget);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `Missing local target in ${sourcePath} link "${rawTarget}" (resolved to ${repoPath})`,
          { cause: error },
        );
      }
      throw new Error(
        `Unable to inspect local target in ${sourcePath} link "${rawTarget}": ${error.message}`,
        { cause: error },
      );
    }

    const encodedPath = encodeRepositoryPath(repoPath);
    const base = destination.image
      ? 'https://raw.githubusercontent.com/happyvertical/smrt/main/'
      : targetStat.isDirectory()
        ? 'https://github.com/happyvertical/smrt/tree/main/'
        : 'https://github.com/happyvertical/smrt/blob/main/';
    replacements.push({ ...destination, target: `${base}${encodedPath}${suffix}` });
  }

  let result = markdown;
  for (const replacement of replacements.reverse()) {
    result = `${result.slice(0, replacement.start)}${replacement.target}${result.slice(replacement.end)}`;
  }
  return result;
}

export async function discoverPackages(root = repoRoot, options = {}) {
  const workspaces = await discoverWorkspaces(root, options);
  const packages = workspaces.map((workspace) => {
    const workspacePath = relative(root, workspace.path).replaceAll('\\', '/');
    const packagePath = workspacePath.startsWith('packages/')
      ? workspacePath.slice('packages/'.length)
      : workspacePath;
    return {
      directory: workspace.path,
      outputName: packagePath.replaceAll('/', '-'),
    };
  });
  const names = new Set();
  for (const pkg of packages) {
    if (names.has(pkg.outputName)) throw new Error(`Duplicate generated README name: ${pkg.outputName}`);
    names.add(pkg.outputName);
  }
  return packages.sort((a, b) => a.outputName.localeCompare(b.outputName));
}

export async function replaceGeneratedDirectory(staging, destination, options = {}) {
  const renamePath = options.rename ?? rename;
  const removePath = options.rm ?? rm;
  const backup = options.backup ?? `${destination}.old-${randomUUID()}`;
  let hadOutput = false;
  try {
    await renamePath(destination, backup);
    hadOutput = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    await renamePath(staging, destination);
  } catch (installationError) {
    if (hadOutput) {
      try {
        await renamePath(backup, destination);
      } catch (rollbackError) {
        // Keep the installation error as the rejection even when restoring the
        // old directory also fails. The secondary error remains inspectable.
        try {
          Object.defineProperty(installationError, 'rollbackError', {
            configurable: true,
            value: rollbackError,
          });
        } catch {
          // Frozen/non-object thrown values still have to remain the rejection.
        }
      }
    }
    throw installationError;
  }
  if (hadOutput) await removePath(backup, { recursive: true, force: true });
}

export async function copyPackageReadmes(options = {}) {
  const root = await realpath(options.repoRoot ?? repoRoot);
  const requestedDestination = resolve(options.outputDir ?? outputDir);
  const destinationParent = await realpath(dirname(requestedDestination));
  if (!isInside(root, destinationParent)) {
    throw new Error(
      `Generated README destination resolves outside the repository: ${requestedDestination}`,
    );
  }
  const destinationRoot = join(destinationParent, basename(requestedDestination));
  const packages = await discoverPackages(root, options);

  // Read and validate every source before touching the currently generated docs.
  const generated = [];
  for (const pkg of packages) {
    const source = join(pkg.directory, 'README.md');
    let markdown;
    try {
      const canonicalSource = await realpath(source);
      if (!isInside(root, canonicalSource)) {
        throw new Error('README symlink resolves outside the repository');
      }
      markdown = await readFile(canonicalSource, 'utf8');
      generated.push({
        name: `${pkg.outputName}.md`,
        markdown: await rewriteLocalLinks(markdown, canonicalSource, root),
      });
    } catch (error) {
      throw new Error(`Unable to read workspace README ${relative(root, source)}: ${error.message}`, {
        cause: error,
      });
    }
  }

  const staging = `${destinationRoot}.tmp-${randomUUID()}`;
  const backup = `${destinationRoot}.old-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    for (const file of generated) await writeFile(join(staging, file.name), file.markdown);
    await writeFile(join(staging, '.generated'), 'Generated by docs/scripts/copy-readmes.js. Do not edit.\n');

    await replaceGeneratedDirectory(staging, destinationRoot, { backup });
  } catch (error) {
    try {
      await rm(staging, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort and must not hide validation/installation errors.
    }
    throw error;
  }

  return packages.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  copyPackageReadmes()
    .then((count) => console.log(`Copied ${count} package READMEs to docs/content/packages.`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
