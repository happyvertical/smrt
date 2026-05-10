import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export interface ImportWorkspaceModuleOptions {
  packageName: string;
  sourceEntry: string;
  distEntry?: string;
  purpose: string;
}

function findWorkspaceRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveInstalledPackage(packageName: string): string {
  try {
    return pathToFileURL(require.resolve(packageName)).href;
  } catch (requireError) {
    try {
      return import.meta.resolve(packageName);
    } catch (esmResolveError) {
      throw new AggregateError(
        [requireError, esmResolveError],
        `Failed to resolve installed package "${packageName}".`,
      );
    }
  }
}

export async function importWorkspaceModule<T = unknown>({
  packageName,
  sourceEntry,
  distEntry,
  purpose,
}: ImportWorkspaceModuleOptions): Promise<T> {
  try {
    return (await import(
      /* @vite-ignore */ resolveInstalledPackage(packageName)
    )) as T;
  } catch (originalError) {
    const workspaceRoot = findWorkspaceRoot(process.cwd());
    if (!workspaceRoot) {
      throw originalError;
    }

    if (distEntry) {
      const distPath = join(workspaceRoot, distEntry);
      if (existsSync(distPath)) {
        return (await import(
          /* @vite-ignore */ pathToFileURL(distPath).href
        )) as T;
      }
    }

    const sourcePath = join(workspaceRoot, sourceEntry);
    if (!existsSync(sourcePath)) {
      throw new Error(
        `Failed to load ${packageName} for ${purpose}: could not find ${sourcePath}.`,
      );
    }

    let tsxApiPath: string;
    try {
      tsxApiPath = require.resolve('tsx/esm/api');
    } catch (tsxError) {
      throw new Error(
        `Failed to load ${packageName} for ${purpose}: workspace source fallback requires the "tsx" package.`,
        { cause: tsxError },
      );
    }

    const { register } = await import(
      /* @vite-ignore */ pathToFileURL(tsxApiPath).href
    );
    const tsconfigPath = join(workspaceRoot, 'tsconfig.package-build.json');
    const unregister = register(
      existsSync(tsconfigPath) ? { tsconfig: tsconfigPath } : undefined,
    );

    try {
      return (await import(
        /* @vite-ignore */ pathToFileURL(sourcePath).href
      )) as T;
    } finally {
      await unregister();
    }
  }
}
