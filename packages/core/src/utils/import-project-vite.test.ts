import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importProjectVite } from './import-project-vite.js';

describe('importProjectVite (#3181)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.doUnmock('node:module');
    vi.resetModules();
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function project(exportsField: unknown): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'smrt-project-vite-'));
    roots.push(root);
    await writeFile(
      join(root, 'package.json'),
      '{"name":"app","type":"module"}\n',
    );
    const viteDir = join(root, 'node_modules', 'vite');
    await mkdir(join(viteDir, 'dist', 'node'), { recursive: true });
    await writeFile(
      join(viteDir, 'package.json'),
      `${JSON.stringify({ name: 'vite', type: 'module', exports: exportsField })}\n`,
    );
    await writeFile(
      join(viteDir, 'dist', 'node', 'index.js'),
      `export const build = () => 'project vite:${root}';\n`,
    );
    return root;
  }

  it("imports the application's Vite, not the one next to smrt-core", async () => {
    const root = await project({
      '.': './dist/node/index.js',
      './package.json': './package.json',
    });
    const vite = await importProjectVite(root, 'test');
    expect((vite.build as unknown as () => string)()).toBe(
      `project vite:${root}`,
    );
  });

  it('follows conditional exports to the ESM entry', async () => {
    const root = await project({
      '.': { types: './dist/node/index.d.ts', import: './dist/node/index.js' },
      './package.json': './package.json',
    });
    const vite = await importProjectVite(root, 'test');
    expect((vite.build as unknown as () => string)()).toBe(
      `project vite:${root}`,
    );
  });

  it('names the purpose when the application has no Vite', async () => {
    // Node's global folders (NODE_PATH, set by pnpm bin shims) can supply a
    // hoisted Vite for any directory, so simulate a failed resolution.
    vi.resetModules();
    vi.doMock('node:module', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:module')>()),
      createRequire: () => ({
        resolve: () => {
          throw Object.assign(new Error("Cannot find module 'vite'"), {
            code: 'MODULE_NOT_FOUND',
          });
        },
      }),
    }));
    const { importProjectVite: isolated } = await import(
      './import-project-vite.js'
    );
    await expect(
      isolated('/no/such/app', 'Worker registration'),
    ).rejects.toThrow(
      /Worker registration needs Vite, but 'vite' is not installed in \/no\/such\/app/,
    );
  });
});
