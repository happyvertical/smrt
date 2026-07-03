/**
 * Tests for the `@happyvertical/smrt-virt-web` virtual module (spike #1756).
 *
 * The generator is module-private; it is reached the way Vite does — through
 * the plugin's `resolveId`/`load` hooks over a real mini-project scan
 * (mirroring load-hooks.test.ts). The fixture deliberately includes a
 * transitive collection subclass (SpecialWidgetCollection extends
 * WidgetCollection) — regression for the selection bug where only direct
 * `extends SmrtCollection` was treated as a collection class and the deeper
 * subclass claimed the model's REST collection definition.
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

function getHook(plugin: Record<string, unknown>, name: string) {
  const hook = plugin[name] as
    | ((...args: unknown[]) => unknown)
    | { handler: (...args: unknown[]) => unknown };
  return typeof hook === 'function' ? hook : hook.handler;
}

describe('smrtPlugin load (\0smrt:web virtual module)', () => {
  let projectRoot: string;
  // biome config exempts tests from noExplicitAny; Vite plugin hooks are duck-typed here
  let plugin: any;
  let load: (id: string) => Promise<string | null>;

  beforeAll(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-vite-web-'));
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'mini-web-app',
        version: '0.0.1',
        type: 'module',
      }),
    );
    writeFileSync(
      join(projectRoot, 'src', 'objects.ts'),
      `import { SmrtCollection, SmrtObject } from '@happyvertical/smrt-core';

// STI child declared BEFORE its base: the base model must still own the
// shared table's collection definition (regression: Material extends Product
// claimed 'products' by iteration order).
@smrt({ api: { include: ['list', 'get', 'create'] } })
export class FancyWidget extends Widget {
  shine: string = '';
}

@smrt({ api: { include: ['list', 'get', 'create'] }, tableStrategy: 'sti' })
export class Widget extends SmrtObject {
  name: string = '';
  price: number = 0.0;
  inStock: boolean = true;
}

export class WidgetCollection extends SmrtCollection<Widget> {
  static readonly _itemClass = Widget;
}

// Transitive collection subclass: no type argument of its own — must still
// be excluded from web collection definitions via the extends chain.
export class SpecialWidgetCollection extends WidgetCollection {}

@smrt({ api: false })
export class HiddenGadget extends SmrtObject {
  label: string = '';
}
`,
    );

    plugin = smrtPlugin({
      generateTypes: false,
      include: ['src/**/*.ts'],
    });

    await plugin.configResolved?.call(plugin, {
      root: projectRoot,
      mode: 'production',
      plugins: [],
      build: {},
    });

    load = getHook(plugin, 'load').bind(plugin) as typeof load;
  }, 60_000);

  afterAll(() => {
    if (existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves the virt-web specifier to its \0-prefixed id', () => {
    const resolveId = getHook(plugin, 'resolveId');
    expect(resolveId.call(plugin, '@happyvertical/smrt-virt-web')).toBe(
      '\0smrt:web',
    );
  });

  it('emits one typed definition per API-exposed REST collection', async () => {
    const code = await load('\0smrt:web');
    expect(code).toContain('export const collectionDefinitions');
    expect(code).toContain('export function getCollectionDefinition');

    const definitions = extractDefinitions(code as string);
    expect(Object.keys(definitions)).toEqual(['widgets']);

    const widgets = definitions.widgets as Record<string, unknown>;
    expect(widgets.className).toBe('Widget');
    expect(widgets.endpoint).toBe('/widgets');
    expect(widgets.idField).toBe('id');
    expect(widgets.actions).toEqual(['create', 'get', 'list']);
    expect(widgets.fields).toMatchObject({
      name: { type: 'text' },
      price: { type: 'decimal' },
      inStock: { type: 'boolean' },
    });
  });

  it('folds STI children into the base model definition even when the child is scanned first', async () => {
    const code = (await load('\0smrt:web')) as string;
    const definitions = extractDefinitions(code);
    // FancyWidget shares the widgets table; the base Widget owns the
    // definition regardless of declaration/scan order.
    const widgets = definitions.widgets as Record<string, unknown>;
    expect(widgets.className).toBe('Widget');
    expect(code).not.toContain('FancyWidget');
  });

  it('excludes collection classes across the whole extends chain', async () => {
    const code = (await load('\0smrt:web')) as string;
    // Neither the direct nor the transitive collection subclass may appear.
    expect(code).not.toContain('WidgetCollection');
    expect(code).not.toContain('SpecialWidgetCollection');
  });

  it('excludes api:false objects (no read surface)', async () => {
    const code = (await load('\0smrt:web')) as string;
    expect(code).not.toContain('HiddenGadget');
  });
});

/** Parse the emitted `export const collectionDefinitions = {...}` literal. */
function extractDefinitions(code: string): Record<string, unknown> {
  const match = code.match(
    /export const collectionDefinitions = (\{[\s\S]*?\n\});/,
  );
  if (!match) {
    throw new Error('collectionDefinitions literal not found in emitted code');
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}
