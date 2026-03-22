import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export interface ImportWorkspacePackageOptions {
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

export async function importWorkspacePackage<T = unknown>({
  packageName,
  sourceEntry,
  distEntry,
  purpose,
}: ImportWorkspacePackageOptions): Promise<T> {
  try {
    const installedEntry = require.resolve(packageName);
    return (await import(
      /* @vite-ignore */ pathToFileURL(installedEntry).href
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

    const { tsImport } = await import(
      /* @vite-ignore */ pathToFileURL(tsxApiPath).href
    );
    return (await tsImport(pathToFileURL(sourcePath).href, {
      parentURL: import.meta.url,
    })) as T;
  }
}
