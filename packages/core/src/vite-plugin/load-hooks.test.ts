/**
 * Tests for the smrtPlugin Vite hooks that generate virtual modules
 * (src/vite-plugin/index.ts).
 *
 * The per-virtual-module code generators (generateClientModule,
 * generateManifestModule, generateRoutesModule, generateMCPModule,
 * generateTypesModule, generateCLIModule, generateSchemaModule, the default-UI
 * loaders) are module-private. We reach them the way Vite does: through the
 * plugin's `resolveId` and `load` hooks. A small real project (two @smrt
 * classes) is scanned once via `configResolved` to seed a genuine manifest, and
 * then every `load` branch is invoked and its emitted source asserted. No dev
 * server is started and no Vite build runs.
 *
 * Hooks that require a live ViteDevServer / file watcher (configureServer,
 * transformIndexHtml) and the closeBundle library-build path are exercised only
 * where they have a pure, server-independent branch; the rest is flagged
 * infeasible in the report.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { smrtPlugin } from './index.js';

function getHook(plugin: any, name: string) {
  const hook = plugin[name];
  return typeof hook === 'function' ? hook : hook.handler;
}

describe('smrtPlugin resolveId', () => {
  it('resolves each known virtual module to its \\0-prefixed id', () => {
    const plugin: any = smrtPlugin();
    const resolveId = getHook(plugin, 'resolveId');

    expect(resolveId.call(plugin, '@happyvertical/smrt-virt-routes')).toBe(
      '\0smrt:routes',
    );
    expect(resolveId.call(plugin, '@happyvertical/smrt-virt-client')).toBe(
      '\0smrt:client',
    );
    expect(resolveId.call(plugin, '@happyvertical/smrt-virt-manifest')).toBe(
      '\0smrt:manifest',
    );
    expect(resolveId.call(plugin, '@happyvertical/smrt-virt-schema')).toBe(
      '\0smrt:schema',
    );
    expect(resolveId.call(plugin, '@happyvertical/smrt-virt-cli')).toBe(
      '\0smrt:cli',
    );
  });

  it('returns null for /index.html when no dev server is attached', () => {
    const plugin: any = smrtPlugin();
    const resolveId = getHook(plugin, 'resolveId');
    expect(resolveId.call(plugin, '/index.html')).toBeNull();
  });

  it('returns null for unknown ids', () => {
    const plugin: any = smrtPlugin();
    const resolveId = getHook(plugin, 'resolveId');
    expect(resolveId.call(plugin, './local-module.ts')).toBeNull();
  });
});

describe('smrtPlugin api.options', () => {
  it('exposes the resolved scan options for external manifest generation', () => {
    const plugin: any = smrtPlugin({
      include: ['lib/**/*.ts'],
      exclude: ['**/*.spec.ts'],
      baseClasses: ['SmrtObject', 'CustomBase'],
      followImports: false,
    });
    expect(plugin.api.options).toEqual({
      include: ['lib/**/*.ts'],
      exclude: ['**/*.spec.ts'],
      baseClasses: ['SmrtObject', 'CustomBase'],
      followImports: false,
    });
  });
});

describe('smrtPlugin load (virtual module generation)', () => {
  let projectRoot: string;
  let plugin: any;
  let load: (id: string) => Promise<string | null>;

  beforeAll(async () => {
    // Real mini-project with two @smrt classes that share no collisions plus a
    // custom method, so the generators exercise CRUD + custom-method emission.
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-vite-load-'));
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'mini-app', version: '0.0.1', type: 'module' }),
    );
    writeFileSync(
      join(projectRoot, 'src', 'objects.ts'),
      `import { SmrtObject } from '@happyvertical/smrt-core';

@smrt({ cli: true, api: true })
export class Widget extends SmrtObject {
  name: string = '';
  price: number = 0.0;

  async refresh(): Promise<void> {}
}

@smrt({ cli: { exclude: ['delete'] } })
export class Gizmo extends SmrtObject {
  label: string = '';
}
`,
    );

    plugin = smrtPlugin({
      // Keep type-declaration writing off (it only runs with a dev server).
      generateTypes: false,
      include: ['src/**/*.ts'],
    });

    // Drive configResolved with a minimal resolved-config stand-in. This scans
    // the project and seeds the closure manifest used by the load hook.
    await plugin.configResolved?.call(plugin, {
      root: projectRoot,
      mode: 'production',
      plugins: [],
      build: {},
    } as any);

    load = getHook(plugin, 'load').bind(plugin);
  }, 60_000);

  afterAll(() => {
    if (existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('seeds a manifest containing the scanned objects', () => {
    // configResolved writes the local manifest to .smrt/manifest.json.
    expect(existsSync(join(projectRoot, '.smrt', 'manifest.json'))).toBe(true);
  });

  it('generates the routes module', async () => {
    const code = await load('\0smrt:routes');
    expect(code).toContain('export function setupRoutes');
    expect(code).toContain('export { setupRoutes as default }');
  });

  it('generates a client module with per-object CRUD methods', async () => {
    const code = await load('\0smrt:client');
    expect(code).toContain('export function createClient');
    // CRUD verbs are emitted for the scanned collections.
    expect(code).toContain('list:');
    expect(code).toContain('create:');
    expect(code).toContain('delete:');
    expect(code).toContain('search:');
  });

  it('generates the MCP module wired to SmrtMCPServer', async () => {
    const code = await load('\0smrt:mcp');
    expect(code).toContain('SmrtMCPServer');
    expect(code).toContain('export function createMCPServer');
  });

  it('generates the types module with Request/Response interfaces', async () => {
    const code = await load('\0smrt:types');
    expect(code).toContain('export interface Request');
    expect(code).toContain('export interface Response');
  });

  it('generates the manifest module embedding the manifest JSON', async () => {
    const code = await load('\0smrt:manifest');
    expect(code).toContain('export const manifest =');
    expect(code).toContain('export { manifest as default }');
    expect(code).toContain('Widget');
  });

  it('generates the schema module with a schema registry', async () => {
    const code = await load('\0smrt:schema');
    expect(code).toContain('export const schemaManifest =');
    expect(code).toContain('export function getSchema');
    expect(code).toContain('export const schemas =');
  });

  it('generates the CLI module honoring cli include/exclude config', async () => {
    const code = await load('\0smrt:cli');
    expect(code).toContain('export const cliCommands');
    expect(code).toContain('export function setupCLI');
    // Widget enables cli + has a custom method -> a widget command group exists.
    expect(code).toContain('widget:list');
    // Gizmo excludes delete -> no gizmo:delete command emitted.
    expect(code).not.toContain('gizmo:delete');
  });

  it('loads the default UI module source', async () => {
    const code = await load('\0smrt:ui');
    expect(typeof code).toBe('string');
    expect((code as string).length).toBeGreaterThan(0);
  });

  it('loads the default index.html', async () => {
    const html = await load('\0smrt:index-html');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('SMRT Development UI');
  });

  it('returns null for an unknown virtual id', async () => {
    expect(await load('\0smrt:does-not-exist')).toBeNull();
  });
});
