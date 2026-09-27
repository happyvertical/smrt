import { readFileSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Runtime registries are process globals, even across different core versions. */
let selectedProject: string | undefined;

export class ProjectRuntimeResolutionError extends Error {
  readonly code: string;
  constructor(specifier: string, code = 'runtime_dependency_unavailable') {
    super(
      code === 'runtime_project_mismatch'
        ? 'This server already loaded another project runtime. Start a separate server for this project or restart with its working directory.'
        : `The selected project must install a compatible ${specifier}. Install the SMRT runtime in that project, build it, and retry; the MCP server does not supply a runtime.`,
    );
    this.name = 'ProjectRuntimeResolutionError';
    this.code = code;
  }
}

export function projectRuntimeRoot(projectPath?: string): string {
  const root = resolve(projectPath ?? process.cwd());
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** Test seam; callers must also clear the process-global runtime registry. */
export function resetProjectRuntimeForTests(): void {
  selectedProject = undefined;
}

// findPackageJSON uses Node's ESM package lookup, including import-only exports.
// Resolve the documented exact export from that same package root: never search
// again from the server, and never choose a second core for one of its subpaths.
function packageExport(packageJson: string, subpath: string): string {
  const pkg = JSON.parse(readFileSync(packageJson, 'utf8'));
  let target = pkg.exports?.[subpath];
  if (
    target === undefined &&
    subpath === '.' &&
    typeof pkg.exports === 'string'
  )
    target = pkg.exports;
  while (target && typeof target === 'object')
    target = target.import ?? target.node ?? target.default;
  if (typeof target !== 'string' || !target.startsWith('./'))
    throw new Error('Unsupported runtime export');
  const root = dirname(packageJson);
  const entry = resolve(root, target);
  const rel = relative(root, entry);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Invalid runtime export');
  return entry;
}

export function resolveProjectRuntimeEntry(
  projectPath: string | undefined,
  specifier: string,
): string {
  const root = projectRuntimeRoot(projectPath);
  let entry: string;
  try {
    const coreJson = findPackageJSON(
      '@happyvertical/smrt-core',
      pathToFileURL(join(root, 'package.json')),
    );
    if (!coreJson) throw new Error('Missing runtime');
    if (
      specifier === '@happyvertical/smrt-core' ||
      specifier.startsWith('@happyvertical/smrt-core/')
    ) {
      const subpath = specifier.slice('@happyvertical/smrt-core'.length);
      entry = packageExport(coreJson, subpath ? `.${subpath}` : '.');
    } else {
      const dependencyJson = findPackageJSON(
        specifier,
        pathToFileURL(coreJson),
      );
      if (!dependencyJson) throw new Error('Missing runtime dependency');
      entry = packageExport(dependencyJson, '.');
    }
  } catch {
    throw new ProjectRuntimeResolutionError(specifier);
  }
  return entry;
}

export async function importProjectRuntimeModule<T = Record<string, unknown>>(
  projectPath: string | undefined,
  specifier: string,
): Promise<T> {
  const root = projectRuntimeRoot(projectPath);
  if (selectedProject && selectedProject !== root) {
    throw new ProjectRuntimeResolutionError(
      specifier,
      'runtime_project_mismatch',
    );
  }
  const entry = resolveProjectRuntimeEntry(root, specifier);
  // Pin before the first await: concurrent requests cannot import two runtimes.
  selectedProject = root;
  try {
    return (await import(pathToFileURL(entry).href)) as T;
  } catch {
    // Driver/module errors may contain credentials or absolute host paths.
    throw new ProjectRuntimeResolutionError(specifier);
  }
}

export const loadProjectCore = (projectPath?: string) =>
  importProjectRuntimeModule<typeof import('@happyvertical/smrt-core')>(
    projectPath,
    '@happyvertical/smrt-core',
  );

export async function loadProjectRuntime(projectPath?: string) {
  const core = await loadProjectCore(projectPath);
  const sql = await importProjectRuntimeModule<
    typeof import('@happyvertical/sql')
  >(projectPath, '@happyvertical/sql');
  return { core, sql, projectRoot: projectRuntimeRoot(projectPath) };
}
