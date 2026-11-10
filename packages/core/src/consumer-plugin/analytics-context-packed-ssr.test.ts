import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Consumer {
  directory: string;
  run(command: string, args: string[]): string;
  cleanup(): void;
}
interface PackedModule {
  createPackedConsumer(options: {
    root: string;
    packageNames: string[];
    consumerDependencies: Record<string, string>;
  }): Consumer;
}

function listen(child: ChildProcess): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error(`SSR child timeout: ${output}`)),
      20_000,
    );
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      const match = /SSR_PORT=(\d+)/.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolvePort(Number(match[1]));
      }
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`SSR child exited ${code}: ${output}`));
    });
  });
}

describe('packed UI analytics production SSR (#4302)', () => {
  it.each([
    'current Vite',
    'Work Vite 7',
  ])('renders root and login with the same parent/child analytics context (%s)', async (runtime) => {
    const root = resolve(import.meta.dirname, '../../../..');
    const { createPackedConsumer } = (await import(
      pathToFileURL(join(root, 'scripts/packed-consumer.mjs')).href
    )) as PackedModule;
    const core = JSON.parse(
      readFileSync(join(root, 'packages/core/package.json'), 'utf8'),
    );
    const consumer = createPackedConsumer({
      root,
      packageNames: ['@happyvertical/smrt-core', '@happyvertical/smrt-ui'],
      consumerDependencies: {
        '@sveltejs/kit': core.devDependencies['@sveltejs/kit'],
        '@sveltejs/vite-plugin-svelte':
          runtime === 'Work Vite 7'
            ? '6.2.4'
            : core.devDependencies['@sveltejs/vite-plugin-svelte'],
        '@sveltejs/adapter-node': '5.5.7',
        vite: runtime === 'Work Vite 7' ? '7.3.7' : core.devDependencies.vite,
        svelte: core.devDependencies.svelte,
      },
    });
    let child: ChildProcess | undefined;
    let errors = '';
    try {
      const dir = consumer.directory;
      // UI is a manifest-free leaf. A minimal provider reaches the real packed
      // UI transitively, matching domain-package consumer SSR resolution.
      const provider = join(dir, 'node_modules/@acme/context-provider');
      mkdirSync(join(provider, 'dist'), { recursive: true });
      writeFileSync(
        join(provider, 'package.json'),
        JSON.stringify({
          name: '@acme/context-provider',
          version: '0.0.0-fixture',
          type: 'module',
          exports: {
            '.': './dist/index.js',
            './manifest.json': './dist/manifest.json',
          },
          dependencies: { '@happyvertical/smrt-ui': '*' },
        }),
      );
      writeFileSync(join(provider, 'dist/index.js'), 'export {};\n');
      writeFileSync(
        join(provider, 'dist/manifest.json'),
        JSON.stringify({
          packageName: '@acme/context-provider',
          objects: {},
        }),
      );
      mkdirSync(join(dir, 'src/routes/login'), { recursive: true });
      writeFileSync(
        join(dir, 'svelte.config.js'),
        "import adapter from '@sveltejs/adapter-node'; export default {kit:{adapter:adapter()}};\n",
      );
      writeFileSync(
        join(dir, 'vite.config.js'),
        `import {sveltekit} from '@sveltejs/kit/vite';
import {smrtConsumer} from '@happyvertical/smrt-core/consumer-plugin';
export default {plugins:[sveltekit(),smrtConsumer({packages:['@acme/context-provider'],disableScanning:true,generateTypes:false})]};\n`,
      );
      writeFileSync(
        join(dir, 'src/app.html'),
        '<!doctype html><html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>',
      );
      writeFileSync(
        join(dir, 'src/routes/+layout.svelte'),
        `<script>
import {setAnalyticsContext} from '@happyvertical/smrt-ui/analytics';
let {children}=$props();
const received=[];
setAnalyticsContext(name=>received.push(name));
</script>
{@render children()}<output id="analytics-receipt">{received.join(',')}</output>\n`,
      );
      for (const [path, title] of [
        ['src/routes/+page.svelte', 'root'],
        ['src/routes/login/+page.svelte', 'login'],
      ]) {
        writeFileSync(
          join(dir, path),
          `<script>
import {getAnalyticsContext} from '@happyvertical/smrt-ui/analytics';
getAnalyticsContext()('planner_opened');
</script><h1>${title}</h1>\n`,
        );
      }
      consumer.run('pnpm', ['exec', 'vite', 'build']);
      writeFileSync(
        join(dir, 'serve.mjs'),
        `import {createServer} from 'node:http';
import {handler} from './build/handler.js';
const server=createServer(handler);
server.listen(0,'127.0.0.1',()=>console.log('SSR_PORT='+server.address().port));\n`,
      );
      child = spawn(process.execPath, ['serve.mjs'], {
        cwd: dir,
        env: { ...process.env, ORIGIN: 'http://localhost' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr?.on('data', (chunk) => {
        errors += String(chunk);
      });
      const port = await listen(child);
      // Repeated root proves the sink is request-local, not a shared SSR global.
      for (const [path, title] of [
        ['/', 'root'],
        ['/login', 'login'],
        ['/', 'root'],
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        const body = await response.text();
        expect(response.status, `${path}: ${body}\n${errors}`).toBe(200);
        expect(body).toContain(`<h1>${title}</h1>`);
        expect(body).toMatch(
          /id="analytics-receipt">(?:<!--.*?-->)*planner_opened/,
        );
        expect(body).not.toContain('planner_opened,planner_opened');
      }
      expect(errors).not.toContain('lifecycle_outside_component');
    } finally {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolveExit) =>
          child?.once('exit', () => resolveExit()),
        );
        child.kill('SIGTERM');
        await exited;
      }
      consumer.cleanup();
    }
  }, 180_000);
});
