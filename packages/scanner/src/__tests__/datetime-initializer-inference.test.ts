import { describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';

function fieldsOf(source: string) {
  const parsed = parseSource(source, '/fixture/dates/models.ts');
  expect(parsed.errors).toEqual([]);
  const resolver = new InheritanceResolver();
  resolver.addClasses(parsed.classes);
  const [entry] = resolver.resolveAll();
  return new ManifestAdapter().toSmartObjectDefinition(entry!, {
    packageName: '@fixture/dates',
  }).fields;
}

describe('datetime inference from a Date initializer', () => {
  it('infers datetime from an unannotated `= new Date()` initializer', () => {
    const fields = fieldsOf(`
      import { smrt, SmrtObject } from '@happyvertical/smrt-core';
      @smrt()
      export class DatedShelfVisit extends SmrtObject {
        recordedAt = new Date();
        startedOn = new Date(0);
        openedWhen = new Date('2026-01-01T00:00:00Z');
        optionalAt? = new Date();
      }
    `);
    for (const name of ['recordedAt', 'startedOn', 'openedWhen', 'optionalAt'])
      expect(fields[name], name).toMatchObject({
        type: 'datetime',
        required: false,
      });
  });

  it('keeps a declared or inferred text type when the initializer is not a Date', () => {
    const fields = fieldsOf(`
      import { field, smrt, SmrtObject } from '@happyvertical/smrt-core';
      @smrt()
      export class TextShelfVisit extends SmrtObject {
        dueDate: string = '';
        noted_at = '';
        @field({ type: 'text' }) decidedAt = new Date();
        label = 'new Date()';
        stamp = new Date().toISOString();
        renderedAt = makeDate();
      }
    `);
    expect(fields.dueDate?.type).toBe('text');
    expect(fields.noted_at?.type).toBe('text');
    // An explicit @field type wins over the initializer.
    expect(fields.decidedAt?.type).toBe('text');
    expect(fields.label?.type).toBe('text');
    expect(fields.stamp?.type).toBe('text');
    expect(fields.renderedAt?.type).toBe('text');
  });

  it('reads the initializer from the AST, so comments and nested calls do not change it', () => {
    const fields = fieldsOf(`
      import { smrt, SmrtObject } from '@happyvertical/smrt-core';
      @smrt()
      export class CommentedShelfVisit extends SmrtObject {
        recordedAt = new Date(/* ) */ 0);
        noticedAt = new Date(Date.parse(')'));
        stamp = new Date(0).getTime();
      }
    `);
    expect(fields.recordedAt?.type).toBe('datetime');
    expect(fields.noticedAt?.type).toBe('datetime');
    expect(fields.stamp?.type).toBe('text');
  });

  it.each([
    ['a named import', "import { Date } from './clock.js';"],
    ['a renamed import', "import { Moment as Date } from './clock.js';"],
    ['a default import', "import Date from './clock.js';"],
    ['a module class', 'class Date { constructor(public at = 0) {} }'],
    ['a module constant', "const Date = globalThis['Clock'];"],
    ['a destructured constant', 'const { Clock: Date } = makeClocks();'],
    ['an exported function', 'export function Date(this: unknown) {}'],
  ])('keeps text when `Date` is %s of the module', (_label, binding) => {
    const fields = fieldsOf(`
      import { smrt, SmrtObject } from '@happyvertical/smrt-core';
      ${binding}
      @smrt()
      export class ShadowedShelfVisit extends SmrtObject {
        recordedAt = new Date();
      }
    `);
    expect(fields.recordedAt?.type).toBe('text');
  });

  it('infers datetime when only a type named Date is imported', () => {
    const fields = fieldsOf(`
      import { smrt, SmrtObject } from '@happyvertical/smrt-core';
      import type { Date as _D } from './clock.js';
      import { type Date } from './other.js';
      @smrt()
      export class TypeOnlyShelfVisit extends SmrtObject {
        recordedAt = new Date();
      }
    `);
    expect(fields.recordedAt?.type).toBe('datetime');
  });

  it('keeps the annotation path: `: Date` is datetime without an initializer', () => {
    const fields = fieldsOf(`
      import { smrt, SmrtObject } from '@happyvertical/smrt-core';
      @smrt()
      export class AnnotatedShelfVisit extends SmrtObject {
        closedAt?: Date;
      }
    `);
    expect(fields.closedAt?.type).toBe('datetime');
  });
});
