import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkerRegistrationExternal,
  projectSourceAliases,
  WORKER_REGISTRATION_PATH,
} from './worker-registration.js';

const execFileAsync = promisify(execFile);

describe('worker registration externals (#3117)', () => {
  const root = '/app';

  it('keeps only aliases that point into the project sources', () => {
    const aliases = projectSourceAliases(root, [
      { find: '$lib', replacement: '/app/src/lib' },
      {
        find: '@happyvertical/smrt-core',
        replacement: '/repo/core/src/index.ts',
      },
      { find: 'dep', replacement: '/app/node_modules/dep/index.js' },
      { find: /^virtual:x$/, replacement: 'virtual:y' },
    ]);
    expect(aliases.map((alias) => alias.find)).toEqual(['$lib']);
  });

  it('bundles relative, resolved, and project-alias imports; externalizes packages', () => {
    const external = createWorkerRegistrationExternal([
      { find: '$lib', replacement: '/app/src/lib' },
    ]);
    expect(external('./objects/task')).toBe(false);
    expect(external('../../.smrt/register.js')).toBe(false);
    expect(external('/app/src/lib/objects/task.ts')).toBe(false);
    expect(external('\0virtual')).toBe(false);
    expect(external('$lib/objects/helpers')).toBe(false);
    expect(external('$libx')).toBe(true);
    expect(external('@happyvertical/smrt-core')).toBe(true);
    expect(external('@happyvertical/smrt-jobs/runner')).toBe(true);
    expect(external('node:fs')).toBe(true);
  });
});

describe('SvelteKit build compiles the app registration for workers (#3117)', () => {
  const projectRoot = resolve(
    import.meta.dirname,
    `__test-worker-registration-${process.pid}`,
  );

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a plain node process resolves the app’s own objects from .smrt/runtime/register.js', async () => {
    mkdirSync(join(projectRoot, 'src/routes'), { recursive: true });
    mkdirSync(join(projectRoot, 'src/lib/objects'), { recursive: true });
    mkdirSync(join(projectRoot, 'node_modules/@happyvertical'), {
      recursive: true,
    });
    // The worker resolves smrt-core the way a deployed app does: from its own
    // node_modules (the built package), never from the Vite alias below.
    symlinkSync(
      resolve(import.meta.dirname, '../..'),
      join(projectRoot, 'node_modules/@happyvertical/smrt-core'),
      'dir',
    );
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: '@test/worker-app',
        private: true,
        type: 'module',
      }),
    );
    writeFileSync(
      join(projectRoot, 'svelte.config.js'),
      'export default {};\n',
    );
    writeFileSync(
      join(projectRoot, 'tsconfig.json'),
      JSON.stringify({ extends: './.svelte-kit/tsconfig.json' }),
    );
    writeFileSync(
      join(projectRoot, 'src/app.html'),
      '<!doctype html><html><head>%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>',
    );
    writeFileSync(
      join(projectRoot, 'src/routes/+page.svelte'),
      '<h1>app</h1>\n',
    );
    writeFileSync(
      join(projectRoot, 'src/lib/objects/retention.ts'),
      'export const RETENTION_DAYS = 30;\n',
    );
    writeFileSync(
      join(projectRoot, 'src/lib/objects/ShopScheduledTask.ts'),
      [
        "import { SmrtObject, smrt } from '@happyvertical/smrt-core';",
        "import { RETENTION_DAYS } from '$lib/objects/retention';",
        "@smrt({ api: { include: ['list', 'get'] } })",
        'export class ShopScheduledTask extends SmrtObject {',
        "  label = '';",
        '  sweep(): number {',
        '    return RETENTION_DAYS;',
        '  }',
        '}',
      ].join('\n'),
    );

    const coreSourceUrl = pathToFileURL(
      resolve(import.meta.dirname, '../index.ts'),
    ).href;
    const producerPluginUrl = pathToFileURL(
      resolve(import.meta.dirname, 'index.ts'),
    ).href;
    writeFileSync(
      join(projectRoot, 'vite.config.ts'),
      `import { sveltekit } from '@sveltejs/kit/vite';
import { smrtPlugin } from ${JSON.stringify(producerPluginUrl)};
import { defineConfig } from 'vite';

export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  resolve: { alias: { '@happyvertical/smrt-core': ${JSON.stringify(coreSourceUrl)} } },
  plugins: [
    sveltekit(),
    smrtPlugin({
      projectRoot: ${JSON.stringify(projectRoot)},
      include: ['src/lib/objects/**/*.ts'],
      generateTypes: false,
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      },
    }),
  ],
});
`,
    );

    const viteCli = resolve(
      import.meta.dirname,
      '../../../../node_modules/vite/bin/vite.js',
    );
    await execFileAsync(
      process.execPath,
      [viteCli, 'build', '--config', join(projectRoot, 'vite.config.ts')],
      { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024, timeout: 110_000 },
    );

    const output = join(projectRoot, WORKER_REGISTRATION_PATH);
    expect(existsSync(output)).toBe(true);
    const compiled = readFileSync(output, 'utf8');
    // Package imports stay external so the worker shares the installed core.
    expect(compiled).toMatch(/from ["']@happyvertical\/smrt-core["']/);
    expect(compiled).not.toContain('class SmrtObject');

    // The issue's repro: runtime + generated registration, no app source.
    const probe = join(projectRoot, 'probe.mjs');
    writeFileSync(
      probe,
      [
        "const { ObjectRegistry } = await import('@happyvertical/smrt-core');",
        `await import(${JSON.stringify(pathToFileURL(output).href)});`,
        "const entry = ObjectRegistry.getClass('@test/worker-app:ShopScheduledTask');",
        'const instance = entry && new entry.constructor({});',
        'console.log(JSON.stringify({',
        '  found: Boolean(entry),',
        '  qualifiedName: entry?.qualifiedName,',
        '  sweep: instance?.sweep(),',
        '}));',
      ].join('\n'),
    );
    const { stdout } = await execFileAsync(process.execPath, [probe], {
      cwd: projectRoot,
      timeout: 30_000,
    });
    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')).toEqual({
      found: true,
      qualifiedName: '@test/worker-app:ShopScheduledTask',
      sweep: 30,
    });
  }, 150_000);
});
