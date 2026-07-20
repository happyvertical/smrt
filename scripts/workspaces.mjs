import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
}

export async function validateWorkspaceList(entries, repoRoot) {
  if (!Array.isArray(entries)) {
    throw new Error('pnpm workspace discovery did not return an array');
  }

  const root = await realpath(resolve(repoRoot));
  const seen = new Set();
  const workspaces = [];
  let rootEntries = 0;
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Malformed pnpm workspace result at index ${index}: expected an object`);
    }
    if (typeof entry.path !== 'string' || entry.path.trim() === '') {
      throw new Error(
        `Malformed pnpm workspace result at index ${index}: path must be a non-empty string`,
      );
    }

    let canonicalPath;
    try {
      canonicalPath = await realpath(resolve(repoRoot, entry.path));
    } catch (error) {
      throw new Error(
        `Unable to canonicalize pnpm workspace path at index ${index}: ${entry.path}`,
        { cause: error },
      );
    }
    if (!isInside(root, canonicalPath)) {
      throw new Error(`Workspace resolves outside the repository: ${entry.path}`);
    }
    if (canonicalPath === root) {
      rootEntries += 1;
      continue;
    }
    if (seen.has(canonicalPath)) {
      throw new Error(`Duplicate pnpm workspace result: ${entry.path}`);
    }
    seen.add(canonicalPath);
    workspaces.push({ ...entry, path: canonicalPath });
  }

  if (rootEntries !== 1) {
    throw new Error(
      `pnpm workspace discovery must include exactly one repository-root record; received ${rootEntries}`,
    );
  }
  if (workspaces.length === 0) {
    throw new Error('pnpm-workspace.yaml resolved to zero workspace packages');
  }

  return workspaces.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Ask pnpm to parse and expand pnpm-workspace.yaml. This supports pnpm's full
 * YAML and workspace-glob syntax instead of maintaining a second partial parser.
 */
export async function discoverWorkspaces(repoRoot, options = {}) {
  const workspaceFile = resolve(repoRoot, 'pnpm-workspace.yaml');
  await readFile(workspaceFile, 'utf8');

  const run = options.run ?? execFileAsync;
  let stdout;
  try {
    ({ stdout } = await run('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`Unable to discover pnpm workspaces: ${error.stderr || error.message}`, {
      cause: error,
    });
  }

  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`pnpm workspace discovery returned invalid JSON: ${error.message}`, {
      cause: error,
    });
  }
  return await validateWorkspaceList(entries, repoRoot);
}
