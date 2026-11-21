/**
 * A junction collection's item, traced through real sources by the real
 * scanner and stamped by manifest generation. JavaScript's own binding rules
 * decide the item: a module's explicit export wins over any `export *`
 * whatever the statement order, two stars naming different declarations
 * export nothing, and a class's type parameter shadows an import or class of
 * the same name. The published manifest never carries the scanning machine's
 * paths.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { afterEach, describe, expect, it } from 'vitest';
import { findAbsoluteManifestFilePaths } from '../../manifest/file-paths';
import { ManifestGenerator } from '../manifest-generator';
import type { SmartObjectManifest } from '../types';

const PKG = '@fixture/item-trace';
const MODEL = (name: string) =>
  `import { smrt, SmrtObject } from '@happyvertical/smrt-core';\n@smrt() export class ${name} extends SmrtObject { label = ''; }\n`;

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function scan(
  files: Record<string, string>,
): Promise<SmartObjectManifest> {
  root = mkdtempSync(join(tmpdir(), 'item-trace-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const { resolved } = await new OxcScanner({
    cwd: root,
    include: ['src/**/*.ts'],
  }).scanAndResolve();
  const manifest = new ManifestAdapter().toManifest(resolved, {
    packageName: PKG,
  }) as SmartObjectManifest;
  new ManifestGenerator().applyGenerationPasses(manifest, { packageName: PKG });
  return manifest;
}

const entry = (manifest: SmartObjectManifest, className: string) => {
  const found = manifest.objects[`${PKG}:${className}`];
  if (!found) throw new Error(`missing ${className}`);
  return found;
};

const LINKS = `import { SmrtJunction } from '@happyvertical/smrt-core';
import { Tag } from './barrel';
export class TagLinks extends SmrtJunction<Tag> {}
`;

describe('junction item traced through a barrel', () => {
  for (const [order, barrel] of [
    [
      'star first',
      "export * from './models/tag';\nexport { Label as Tag } from './models/label';\n",
    ],
    [
      'explicit first',
      "export { Label as Tag } from './models/label';\nexport * from './models/tag';\n",
    ],
  ] as const) {
    it(`an explicit re-export wins over a star of the same name (${order})`, async () => {
      const manifest = await scan({
        'src/models/tag.ts': MODEL('Tag'),
        'src/models/label.ts': MODEL('Label'),
        'src/barrel.ts': barrel,
        'src/links.ts': LINKS,
      });
      expect(entry(manifest, 'TagLinks').junctionOf).toBe(`${PKG}:Label`);
      expect(entry(manifest, 'Label').internal).toBe('junction');
      expect(entry(manifest, 'Tag').internal).toBeUndefined();
    });
  }

  it('two stars naming different declarations leave the item unresolved', async () => {
    const manifest = await scan({
      'src/models/tag.ts': MODEL('Tag'),
      'src/other/tag.ts': `${MODEL('Marker')}export { Marker as Tag };\n`,
      'src/barrel.ts':
        "export * from './models/tag';\nexport * from './other/tag';\n",
      'src/links.ts': LINKS,
    });
    const links = entry(manifest, 'TagLinks');
    expect(links.junctionOf).toBeUndefined();
    expect(links.junctionItemUnresolved).toBe(true);
  });

  for (const [kind, explicit] of [
    ['type alias', 'export type Tag = Label;'],
    ['interface', 'export interface Tag { label: string }'],
    ['const', 'export const Tag = Label;'],
    ['enum', 'export enum Tag { One }'],
    ['function', 'export function Tag() { return Label; }'],
  ] as const) {
    for (const order of ['star first', 'explicit first'] as const) {
      it(`an explicit ${kind} export of the name is not the star's class (${order})`, async () => {
        const star = "export * from './models/tag';";
        const head = "import { Label } from './models/label';";
        const manifest = await scan({
          'src/models/tag.ts': MODEL('Tag'),
          'src/models/label.ts': MODEL('Label'),
          'src/barrel.ts':
            order === 'star first'
              ? `${head}\n${star}\n${explicit}\n`
              : `${head}\n${explicit}\n${star}\n`,
          'src/links.ts': LINKS,
        });
        const links = entry(manifest, 'TagLinks');
        expect(links.junctionOf).toBeUndefined();
        expect(links.junctionItemUnresolved).toBe(true);
        expect(entry(manifest, 'Tag').internal).toBeUndefined();
      });
    }
  }

  it('a single star still resolves (negative control)', async () => {
    const manifest = await scan({
      'src/models/tag.ts': MODEL('Tag'),
      'src/barrel.ts': "export * from './models/tag';\n",
      'src/links.ts': LINKS,
    });
    expect(entry(manifest, 'TagLinks').junctionOf).toBe(`${PKG}:Tag`);
    expect(entry(manifest, 'Tag').internal).toBe('junction');
  });
});

describe('a class type parameter shadows module bindings', () => {
  it('an imported model of the same name is not the item', async () => {
    const manifest = await scan({
      'src/models/tag.ts': MODEL('Tag'),
      'src/links.ts': `import { SmrtJunction, SmrtObject } from '@happyvertical/smrt-core';
import { Tag } from './models/tag';
export class LinkBase<Tag extends SmrtObject> extends SmrtJunction<Tag> {}
`,
    });
    const base = entry(manifest, 'LinkBase');
    expect(base.junctionOf).toBeUndefined();
    expect(base.junctionItemUnresolved).toBe(true);
    expect(entry(manifest, 'Tag').internal).toBeUndefined();
  });

  it('a file-local model of the same name is not the item', async () => {
    const manifest = await scan({
      'src/links.ts': `import { smrt, SmrtJunction, SmrtObject } from '@happyvertical/smrt-core';
@smrt() export class Tag extends SmrtObject { label = ''; }
export class LinkBase<Tag extends SmrtObject> extends SmrtJunction<Tag> {}
export class TagLinks extends SmrtJunction<Tag> {}
`,
    });
    expect(entry(manifest, 'LinkBase').junctionItemUnresolved).toBe(true);
    // Outside the class the same spelling still names the model.
    expect(entry(manifest, 'TagLinks').junctionOf).toBe(`${PKG}:Tag`);
  });
});

describe('published item provenance', () => {
  it('carries no path of the scanning machine', async () => {
    const manifest = await scan({
      'src/models/tag.ts': MODEL('Tag'),
      'src/barrel.ts': "export * from './models/tag';\n",
      'src/links.ts': LINKS,
    });
    const links = entry(manifest, 'TagLinks');
    expect(links.junctionOf).toBe(`${PKG}:Tag`);
    expect(links.itemBindings).toEqual([
      { via: 'typeArg', name: 'Tag', source: './barrel' },
    ]);
    expect(findAbsoluteManifestFilePaths(manifest).join('\n')).not.toMatch(
      /itemBindings/,
    );
    // (`filePath` is made package-relative when the manifest is written.)
    expect(JSON.stringify(links.itemBindings)).not.toContain(root as string);
  });
});
