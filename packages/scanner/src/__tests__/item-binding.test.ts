/**
 * A collection's item reference (the generic argument of its `extends` clause
 * and its `static _itemClass` initializer) is recorded by binding, not by
 * spelling: the exported name and the module it comes from, so manifest
 * generation can tell a local model from a same-named model of another
 * package.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseFile, parseSource } from '../oxc-parser.js';
import type { FileScanResult } from '../types.js';

const PKG = '@itembinding/app';

function objectsOf(parsed: FileScanResult) {
  expect(parsed.errors).toEqual([]);
  const resolver = new InheritanceResolver();
  resolver.addClasses(parsed.classes);
  return new ManifestAdapter().toManifest(resolver.resolveAll(), {
    packageName: PKG,
  }).objects;
}

const bindingsOf = (source: string, className: string) =>
  objectsOf(parseSource(source, '/app/src/links.ts'))[`${PKG}:${className}`]
    ?.itemBindings;

describe('collection item bindings', () => {
  it('records a generic argument declared in the same file by name only', () => {
    expect(
      bindingsOf(
        `import { smrt, SmrtObject, SmrtJunction } from '@happyvertical/smrt-core';
         @smrt() export class Tag extends SmrtObject {}
         export class TagLinks extends SmrtJunction<Tag> {}`,
        'TagLinks',
      ),
    ).toEqual([{ via: 'typeArg', name: 'Tag' }]);
  });

  it('records an aliased type-only package import by its exported name and package', () => {
    expect(
      bindingsOf(
        `import { SmrtJunction } from '@happyvertical/smrt-core';
         import type { Tag as T } from '@itembinding/tags/server';
         export class TagLinks extends SmrtJunction<T> {}`,
        'TagLinks',
      ),
    ).toEqual([
      {
        via: 'typeArg',
        name: 'Tag',
        source: '@itembinding/tags/server',
        package: '@itembinding/tags',
      },
    ]);
  });

  it('records a namespace member through its namespace import', () => {
    expect(
      bindingsOf(
        `import { SmrtJunction } from '@happyvertical/smrt-core';
         import * as tags from '@itembinding/tags';
         export class TagLinks extends SmrtJunction<tags.Tag> {}`,
        'TagLinks',
      ),
    ).toEqual([
      {
        via: 'typeArg',
        name: 'Tag',
        source: '@itembinding/tags',
        package: '@itembinding/tags',
      },
    ]);
  });

  it('records both the generic argument and the _itemClass initializer', () => {
    expect(
      bindingsOf(
        `import { SmrtJunction } from '@happyvertical/smrt-core';
         import { Link } from './link';
         export class LinkCollection extends SmrtJunction<Link> {
           static readonly _itemClass = Link;
         }`,
        'LinkCollection',
      ),
    ).toEqual([
      { via: 'typeArg', name: 'Link', source: './link' },
      { via: 'itemClass', name: 'Link', source: './link' },
    ]);
  });

  it('marks an item that is neither declared nor imported, or default-imported, as unresolved', () => {
    expect(
      bindingsOf(
        `import { SmrtJunction } from '@happyvertical/smrt-core';
         import Defaulted from '@itembinding/tags';
         export class GhostLinks extends SmrtJunction<Ghost> {}
         export class DefaultLinks extends SmrtJunction<Defaulted> {}`,
        'GhostLinks',
      ),
    ).toEqual([{ via: 'typeArg', name: 'Ghost', unresolved: true }]);
    expect(
      bindingsOf(
        `import { SmrtJunction } from '@happyvertical/smrt-core';
         import Defaulted from '@itembinding/tags';
         export class DefaultLinks extends SmrtJunction<Defaulted> {}`,
        'DefaultLinks',
      ),
    ).toEqual([{ via: 'typeArg', name: 'Defaulted', unresolved: true }]);
  });

  it('records no binding for a class without a generic argument or _itemClass', () => {
    expect(
      bindingsOf(
        `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
         @smrt() export class Plain extends SmrtObject {}`,
        'Plain',
      ),
    ).toBeUndefined();
  });

  describe('relative imports on disk', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('follows local re-exports to the file that declares the item', () => {
      dir = mkdtempSync(join(tmpdir(), 'item-binding-'));
      mkdirSync(join(dir, 'models'), { recursive: true });
      writeFileSync(
        join(dir, 'models/tag.ts'),
        `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
         @smrt() export class Tag extends SmrtObject {}`,
      );
      writeFileSync(
        join(dir, 'models/index.ts'),
        `export { Tag as Label } from './tag.js';`,
      );
      writeFileSync(join(dir, 'barrel.ts'), `export * from './models/index';`);
      const links = join(dir, 'links.ts');
      writeFileSync(
        links,
        `import { SmrtJunction } from '@happyvertical/smrt-core';
         import { Label } from './barrel';
         export class LabelLinks extends SmrtJunction<Label> {}`,
      );
      expect(
        objectsOf(parseFile(links))[`${PKG}:LabelLinks`]?.itemBindings,
      ).toEqual([
        {
          via: 'typeArg',
          name: 'Tag',
          source: './barrel',
          file: join(dir, 'models/tag.ts'),
        },
      ]);
    });

    for (const order of ['star first', 'explicit first'] as const) {
      it(`an explicit re-export wins over a star of the same name (${order})`, () => {
        dir = mkdtempSync(join(tmpdir(), 'item-binding-'));
        writeFileSync(
          join(dir, 'tag.ts'),
          `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
           @smrt() export class Tag extends SmrtObject {}`,
        );
        writeFileSync(
          join(dir, 'label.ts'),
          `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
           @smrt() export class Label extends SmrtObject {}`,
        );
        const star = `export * from './tag';`;
        const explicit = `export { Label as Tag } from './label';`;
        writeFileSync(
          join(dir, 'barrel.ts'),
          order === 'star first'
            ? `${star}\n${explicit}`
            : `${explicit}\n${star}`,
        );
        const links = join(dir, 'links.ts');
        writeFileSync(
          links,
          `import { SmrtJunction } from '@happyvertical/smrt-core';
           import { Tag } from './barrel';
           export class TagLinks extends SmrtJunction<Tag> {}`,
        );
        expect(
          objectsOf(parseFile(links))[`${PKG}:TagLinks`]?.itemBindings,
        ).toEqual([
          {
            via: 'typeArg',
            name: 'Label',
            source: './barrel',
            file: join(dir, 'label.ts'),
          },
        ]);
      });
    }

    for (const explicit of [
      'export type Tag = Label;',
      'export interface Tag { label: string }',
      'export const Tag = Label;',
      'export enum Tag { One }',
      'export function Tag() { return Label; }',
    ]) {
      for (const order of ['star first', 'explicit first'] as const) {
        it(`an explicit non-class export leaves the star's class untraced: ${explicit} (${order})`, () => {
          dir = mkdtempSync(join(tmpdir(), 'item-binding-'));
          writeFileSync(
            join(dir, 'tag.ts'),
            `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
             @smrt() export class Tag extends SmrtObject {}`,
          );
          writeFileSync(
            join(dir, 'label.ts'),
            `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
             @smrt() export class Label extends SmrtObject {}`,
          );
          const star = `export * from './tag';`;
          writeFileSync(
            join(dir, 'barrel.ts'),
            `import { Label } from './label';\n${
              order === 'star first'
                ? `${star}\n${explicit}`
                : `${explicit}\n${star}`
            }`,
          );
          const links = join(dir, 'links.ts');
          writeFileSync(
            links,
            `import { SmrtJunction } from '@happyvertical/smrt-core';
             import { Tag } from './barrel';
             export class TagLinks extends SmrtJunction<Tag> {}`,
          );
          expect(
            objectsOf(parseFile(links))[`${PKG}:TagLinks`]?.itemBindings,
          ).toEqual([{ via: 'typeArg', name: 'Tag', source: './barrel' }]);
        });
      }
    }
  });

  it('a class type parameter shadows an import of the same name', () => {
    expect(
      bindingsOf(
        `import { SmrtJunction, SmrtObject } from '@happyvertical/smrt-core';
         import { Tag } from '@itembinding/tags';
         export class LinkBase<Tag extends SmrtObject> extends SmrtJunction<Tag> {}`,
        'LinkBase',
      ),
    ).toEqual([{ via: 'typeArg', name: 'Tag', unresolved: true }]);
  });
});
