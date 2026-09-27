import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class ProjectRuntimeResolutionError extends Error {
  constructor(projectRoot: string, specifier: string) {
    super(
      `Selected project ${projectRoot} must install ${specifier}; install the SMRT runtime in that project and retry.`,
    );
    this.name = 'ProjectRuntimeResolutionError';
  }
}

export async function importProjectRuntimeModule<T = Record<string, unknown>>(
  projectPath: string | undefined,
  specifier: string,
): Promise<T> {
  const root = resolve(projectPath ?? process.cwd());
  const require = createRequire(join(root, 'package.json'));
  let entry: string;
  try {
    entry = require.resolve(specifier);
  } catch {
    throw new ProjectRuntimeResolutionError(root, specifier);
  }
  return (await import(pathToFileURL(entry).href)) as T;
}

export async function loadProjectRuntime(projectPath?: string) {
  const core = await importProjectRuntimeModule(
    projectPath,
    '@happyvertical/smrt-core',
  );
  const root = resolve(projectPath ?? process.cwd());
  const require = createRequire(join(root, 'package.json'));
  let coreEntry: string;
  try {
    coreEntry = require.resolve('@happyvertical/smrt-core');
  } catch {
    throw new ProjectRuntimeResolutionError(root, '@happyvertical/smrt-core');
  }
  const coreRequire = createRequire(coreEntry);
  let sqlEntry: string;
  try {
    sqlEntry = coreRequire.resolve('@happyvertical/sql');
  } catch {
    throw new ProjectRuntimeResolutionError(root, '@happyvertical/sql');
  }
  return {
    core,
    sql: await import(pathToFileURL(sqlEntry).href),
    projectRoot: root,
  };
}
