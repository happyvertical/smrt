import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

interface DiscoveryCase {
  name: string;
  sourceDirectory: string;
  additionalDirectories: string[];
  testConfig: (root: string) => Record<string, unknown>;
}

const cases: DiscoveryCase[] = [
  {
    name: 'root source tests with stale build copies',
    sourceDirectory: 'src',
    additionalDirectories: [],
    testConfig: () => ({}),
  },
  {
    name: 'an inline project without a test object',
    sourceDirectory: 'src',
    additionalDirectories: [],
    testConfig: (root) => ({ projects: [{ root }] }),
  },
  {
    name: 'independent project exclusions without root exclusions leaking',
    sourceDirectory: 'integration',
    additionalDirectories: ['ignored'],
    testConfig: (root) => ({
      exclude: ['**/integration/**'],
      projects: [{ root, test: { exclude: ['**/ignored/**'] } }],
    }),
  },
  {
    name: 'explicit root inheritance and project exclusions',
    sourceDirectory: 'src',
    additionalDirectories: ['root-ignored', 'project-ignored'],
    testConfig: (root) => ({
      exclude: ['**/root-ignored/**'],
      projects: [
        {
          root,
          extends: true,
          test: { exclude: ['**/project-ignored/**'] },
        },
      ],
    }),
  },
];

it.each(cases)('collects $name once', async ({
  sourceDirectory,
  additionalDirectories,
  testConfig,
}) => {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const root = mkdtempSync(join(packageRoot, '.discovery-fixture-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'setup.ts'), 'export {};');
    for (const directory of [
      sourceDirectory,
      'dist/svelte',
      '.svelte-kit/__package__',
      ...additionalDirectories,
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(
        join(root, directory, 'example.test.ts'),
        "import { it } from 'vitest'; it('example', () => {});",
      );
    }
    const plugin = fileURLToPath(new URL('../index.ts', import.meta.url));
    writeFileSync(
      join(root, 'vitest.config.ts'),
      `
      import { smrtVitestPlugin } from ${JSON.stringify(plugin)};
      export default { root: ${JSON.stringify(root)}, plugins: [smrtVitestPlugin({
        root: ${JSON.stringify(root)}, generateManifest: false,
        setupFile: ${JSON.stringify(join(root, 'setup.ts'))}
      })], test: ${JSON.stringify(testConfig(root))} };
    `,
    );
    const require = createRequire(import.meta.url);
    const cli = resolve(
      dirname(require.resolve('vitest/package.json')),
      'vitest.mjs',
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli, 'list', '--filesOnly', '--config', join(root, 'vitest.config.ts')],
      { cwd: packageRoot, timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    const files = stdout
      .split('\n')
      .filter((line) => line.includes('example.test.ts'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(`${sourceDirectory}/example.test.ts`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 65000);
