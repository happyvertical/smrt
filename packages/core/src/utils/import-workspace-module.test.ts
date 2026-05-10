import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { importWorkspaceModule } from './import-workspace-module.js';

describe('importWorkspaceModule', () => {
  it('loads packages that are resolvable by ESM import but not createRequire', async () => {
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

  it('preserves createRequire and ESM resolver failures when no installed package or workspace fallback is available', async () => {
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

      expect(thrown).toBeInstanceOf(AggregateError);
      expect(
        (thrown as AggregateError & { errors: unknown[] }).errors,
      ).toHaveLength(2);
      expect((thrown as Error).message).toContain(
        'Failed to resolve installed package "@happyvertical/definitely-not-a-real-smrt-package".',
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
