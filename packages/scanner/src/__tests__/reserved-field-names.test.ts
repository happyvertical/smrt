import { describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';
import {
  isReservedModelFieldName,
  SMRT_RESERVED_FIELD_NAMES,
} from '../reserved-field-names.js';

function scan(source: string) {
  const parsed = parseSource(source, '/fixture/reserved/models.ts');
  expect(parsed.errors).toEqual([]);
  const resolver = new InheritanceResolver();
  resolver.addClasses(parsed.classes);
  const adapter = new ManifestAdapter();
  return resolver.resolveAll().map((entry) =>
    adapter.toSmartObjectDefinition(entry, {
      packageName: '@fixture/reserved',
    }),
  );
}

describe('reserved model field names', () => {
  it.each([
    ['options', "@field({ type: 'text' }) options: string = '';"],
    ['db', 'db = 0;'],
    ['ai', "ai: string = '';"],
    ['save', "save: string = '';"],
    ['tableName', "tableName: string = '';"],
    ['_skipLoad', '_skipLoad = false;'],
    ['_db', '_db = 0;'],
  ])('rejects a model field named %s, naming the model, field and fix', (name, line) => {
    expect(() =>
      scan(`
        import { field, smrt, SmrtObject } from '@happyvertical/smrt-core';
        @smrt()
        export class ReservedNameShelf extends SmrtObject {
          ${line}
        }
      `),
    ).toThrow(
      new RegExp(
        `Model ReservedNameShelf declares a field named "${name}".*Rename the field.*models\\.ts`,
      ),
    );
  });

  it('accepts ordinary names, framework columns, service-option names and editor-only words', () => {
    const [shelf] = scan(`
      import { smrt, SmrtObject } from '@happyvertical/smrt-core';
      @smrt()
      export class OrdinaryNameShelf extends SmrtObject {
        key: string = '';
        order = 0;
        group: string = '';
        optionsList: string = '';
        metrics: string = '[]';
        logging = false;
        slug: string = '';
        static db = 1;
        protected _context = '';
      }
    `);
    expect(Object.keys(shelf?.fields ?? {})).toEqual(
      expect.arrayContaining([
        'key',
        'order',
        'group',
        'optionsList',
        'metrics',
        'logging',
      ]),
    );
  });

  it('leaves a collection its own options member', () => {
    const objects = scan(`
      import { smrt, SmrtCollection, SmrtObject } from '@happyvertical/smrt-core';
      @smrt()
      export class ShelfItem extends SmrtObject {
        label: string = '';
      }
      @smrt()
      export class ShelfItems extends SmrtCollection<ShelfItem> {
        public options: Record<string, unknown> = {};
      }
    `);
    expect(objects.map((entry) => entry.className)).toContain('ShelfItem');
  });

  it('leaves a report collection subclass and a junction their own options member', () => {
    const objects = scan(`
      import { smrt, SmrtJunction, SmrtObject } from '@happyvertical/smrt-core';
      import { SmrtReport, SmrtReportCollection } from '@happyvertical/smrt-reports';
      @smrt()
      export class ShelfTally extends SmrtReport {
        total = 0;
      }
      @smrt()
      export class ShelfTallies extends SmrtReportCollection<ShelfTally> {
        public options: Record<string, unknown> = {};
      }
      @smrt()
      export class ShelfLink extends SmrtObject {
        shelfId: string = '';
      }
      export class ShelfLinks extends SmrtJunction<ShelfLink> {
        public options: Record<string, unknown> = {};
      }
    `);
    expect(objects.map((entry) => entry.className)).toContain('ShelfTally');
  });

  it('applies the rule to report models, which are SmrtObjects', () => {
    expect(() =>
      scan(`
        import { smrt } from '@happyvertical/smrt-core';
        import { SmrtReport } from '@happyvertical/smrt-reports';
        @smrt()
        export class ShelfTally extends SmrtReport {
          save: string = '';
        }
      `),
    ).toThrow(/Model ShelfTally declares a field named "save"/);
  });

  it('accepts SmrtObject member names on a plain SmrtClass service', () => {
    const objects = scan(`
      import { smrt, SmrtClass } from '@happyvertical/smrt-core';
      @smrt()
      export class ShelfService extends SmrtClass {
        save: string = '';
        toJSON: string = '';
      }
    `);
    expect(objects.map((entry) => entry.className)).toContain('ShelfService');
  });

  it('accepts a type-only declare field that narrows a runtime member', () => {
    const [shelf] = scan(`
      import { smrt, SmrtObject, type SmrtObjectOptions } from '@happyvertical/smrt-core';
      interface ShelfOptions extends SmrtObjectOptions { shelfSize?: number }
      @smrt()
      export class DeclaredOptionsShelf extends SmrtObject {
        declare options: ShelfOptions;
        public declare _context: string;
        label: string = '';
      }
    `);
    expect(shelf?.className).toBe('DeclaredOptionsShelf');
  });

  it.each([
    ['save', "['save']: any = null;"],
    ['options', '["options"] = {};'],
    ['toJSON', '[`toJSON`] = null;'],
  ])('rejects a field named %s through a literal computed key', (name, line) => {
    expect(() =>
      scan(`
        import { smrt, SmrtObject } from '@happyvertical/smrt-core';
        @smrt()
        export class ComputedNameShelf extends SmrtObject {
          ${line}
        }
      `),
    ).toThrow(
      new RegExp(`Model ComputedNameShelf declares a field named "${name}"`),
    );
  });

  it('ignores computed keys that are not string literals, static or private', () => {
    const objects = scan(`
      import { smrt, SmrtObject } from '@happyvertical/smrt-core';
      const key = 'save';
      @smrt()
      export class ComputedOrdinaryShelf extends SmrtObject {
        [key]: any = null;
        static ['save'] = 1;
        protected ['options'] = {};
        ['label'] = '';
      }
    `);
    expect(objects.map((entry) => entry.className)).toContain(
      'ComputedOrdinaryShelf',
    );
  });

  it('keeps framework columns, service-option names and SQL words out of the reserved set', () => {
    for (const name of [
      'id',
      'slug',
      'context',
      'created_at',
      'metrics',
      'logging',
      'usage',
      'key',
      'order',
    ])
      expect(isReservedModelFieldName(name), name).toBe(false);
    for (const name of [
      'options',
      'ai',
      'fs',
      'db',
      'save',
      '_db',
      '_skipLoad',
    ])
      expect(SMRT_RESERVED_FIELD_NAMES, name).toContain(name);
  });
});
