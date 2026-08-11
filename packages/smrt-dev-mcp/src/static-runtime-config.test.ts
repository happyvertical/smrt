import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStaticRuntimeConfig } from './static-runtime-config.js';

const testDirectories: string[] = [];

afterEach(async () => {
  for (const directory of testDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('static runtime config', () => {
  it('reads literal TypeScript database config without executing the module', async () => {
    const directory = await temporaryDirectory();
    const marker = '__smrtRuntimeConfigExecuted';
    delete (globalThis as Record<string, unknown>)[marker];
    await writeFile(
      join(directory, 'smrt.config.ts'),
      `
        globalThis.${marker} = true;
        const dbType: string = 'sqlite';
        export default {
          packages: {
            cli: {
              database: {
                type: dbType,
                url: process.env.DATABASE_URL || './app.db',
              } satisfies { type: string; url: string },
            },
          },
        };
      `,
    );

    await expect(
      loadStaticRuntimeConfig(directory, { DATABASE_URL: './env.db' }),
    ).resolves.toEqual({
      packages: {
        cli: { database: { type: 'sqlite', url: './env.db' } },
      },
    });
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('fails closed when database fields require code execution', async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, 'smrt.config.js'),
      `export default {
        packages: { cli: { database: { type: 'sqlite', url: makeUrl() } } }
      };`,
    );

    await expect(loadStaticRuntimeConfig(directory, {})).rejects.toThrow(
      'not statically readable',
    );
  });

  it('reads JSON config and searches parent directories', async () => {
    const directory = await temporaryDirectory();
    const child = join(directory, 'nested');
    await writeFile(
      join(directory, 'smrt.config.json'),
      JSON.stringify({
        packages: {
          cli: { database: { type: 'sqlite', url: './json.db' } },
        },
      }),
    );
    await import('node:fs/promises').then(({ mkdir }) => mkdir(child));

    await expect(loadStaticRuntimeConfig(child, {})).resolves.toMatchObject({
      packages: {
        cli: { database: { type: 'sqlite', url: './json.db' } },
      },
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'smrt-static-config-'));
  testDirectories.push(directory);
  return directory;
}
