import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { importWorkspaceModule } from './import-workspace-module.js';

describe('importWorkspaceModule', () => {
  it('loads packages through ESM resolution', async () => {
    const fixturePackageDir = new URL(
      './node_modules/@fixture/esm-only-import-package/',
      import.meta.url,
    );

    await rm(fixturePackageDir, { recursive: true, force: true });
    await mkdir(fixturePackageDir, { recursive: true });
    await writeFile(
      new URL('package.json', fixturePackageDir),
      `${JSON.stringify({
        name: '@fixture/esm-only-import-package',
        type: 'module',
        exports: {
          '.': {
            import: './index.mjs',
          },
        },
      })}\n`,
    );
    await writeFile(
      new URL('index.mjs', fixturePackageDir),
      'export const loadedViaEsm = true;\n',
    );

    try {
      const module = await importWorkspaceModule<{ loadedViaEsm: boolean }>({
        packageName: '@fixture/esm-only-import-package',
        sourceEntry: 'packages/missing/src/index.ts',
        purpose: 'test ESM resolution',
      });

      expect(module.loadedViaEsm).toBe(true);
    } finally {
      await rm(new URL('./node_modules/@fixture/', import.meta.url), {
        recursive: true,
        force: true,
      });
      await removeIfEmpty(new URL('./node_modules/', import.meta.url));
    }
  });

  it('surfaces a resolved module that fails to evaluate instead of loading a dist fallback (#2954)', async () => {
    const fixturePackageDir = new URL(
      './node_modules/@fixture/throwing-import-package/',
      import.meta.url,
    );
    await rm(fixturePackageDir, { recursive: true, force: true });
    await mkdir(fixturePackageDir, { recursive: true });
    await writeFile(
      new URL('package.json', fixturePackageDir),
      `${JSON.stringify({
        name: '@fixture/throwing-import-package',
        type: 'module',
        exports: { '.': { import: './index.mjs' } },
      })}\n`,
    );
    await writeFile(
      new URL('index.mjs', fixturePackageDir),
      "throw new Error('source failed to evaluate');\n",
    );
    try {
      await expect(
        importWorkspaceModule({
          packageName: '@fixture/throwing-import-package',
          sourceEntry: 'packages/missing/src/index.ts',
          // An existing file the old fallback would have loaded silently.
          distEntry: 'package.json',
          purpose: 'test evaluation failures',
        }),
      ).rejects.toThrow('source failed to evaluate');
    } finally {
      await rm(new URL('./node_modules/@fixture/', import.meta.url), {
        recursive: true,
        force: true,
      });
      await removeIfEmpty(new URL('./node_modules/', import.meta.url));
    }
  });

  it('surfaces a missing import inside a resolved module instead of loading a dist fallback (#2954)', async () => {
    const fixturePackageDir = new URL(
      './node_modules/@fixture/nested-missing-import-package/',
      import.meta.url,
    );
    await rm(fixturePackageDir, { recursive: true, force: true });
    await mkdir(fixturePackageDir, { recursive: true });
    await writeFile(
      new URL('package.json', fixturePackageDir),
      `${JSON.stringify({
        name: '@fixture/nested-missing-import-package',
        type: 'module',
        exports: { '.': { import: './index.mjs' } },
      })}\n`,
    );
    await writeFile(
      new URL('index.mjs', fixturePackageDir),
      "export * from './not-written-yet.mjs';\n",
    );
    try {
      await expect(
        importWorkspaceModule({
          packageName: '@fixture/nested-missing-import-package',
          sourceEntry: 'packages/missing/src/index.ts',
          distEntry: 'package.json',
          purpose: 'test nested resolution failures',
        }),
      ).rejects.toThrow(/not-written-yet/);
    } finally {
      await rm(new URL('./node_modules/@fixture/', import.meta.url), {
        recursive: true,
        force: true,
      });
      await removeIfEmpty(new URL('./node_modules/', import.meta.url));
    }
  });

  it('propagates ESM resolver failures when no installed package or workspace fallback is available', async () => {
    const isolatedDir = await mkdtemp(
      join(tmpdir(), 'smrt-import-workspace-module-'),
    );
    // Keep the workspace source fallback out of this resolver-error assertion.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(isolatedDir);

    try {
      let thrown: unknown;

      try {
        await importWorkspaceModule({
          packageName: '@happyvertical/definitely-not-a-real-smrt-package',
          sourceEntry: 'packages/missing/src/index.ts',
          purpose: 'test resolution',
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(AggregateError);
      expect((thrown as Error).message).toContain(
        '@happyvertical/definitely-not-a-real-smrt-package',
      );
    } finally {
      cwdSpy.mockRestore();
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });
});

async function removeIfEmpty(directory: URL): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      throw error;
    }
  }
}
