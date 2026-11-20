/**
 * A model's parent, relationship targets, report sources and collection item
 * are accepted only in forms the scan can prove from source: a class declared
 * in the same file, a class the relatively imported file declares itself, a
 * framework base exported by the framework package, or an export of a scoped
 * package the nearest package.json declares. Every other form is a scan error
 * whose message names the fix, and nothing is matched by name.
 *
 * Fixtures give the competing classes different table strategies, fields or
 * exposure, so a wrong binding would show in the result.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import { OxcScanner } from '../scanner.js';
import type { RawFieldDefinition } from '../types.js';

const PACKAGE = '@fixture/proof-app';
const PROVIDER = '@fixture/events';
const CORE = `import { SmrtObject, SmrtCollection, smrt, foreignKey, report } from '@happyvertical/smrt-core';`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function write(root: string, files: Record<string, string>) {
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
}

function newRoot(dependencies: string[] = [PROVIDER]) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-proof-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: PACKAGE,
      version: '0.0.0',
      dependencies: Object.fromEntries(dependencies.map((d) => [d, '*'])),
    }),
  );
  return root;
}

async function scanAt(root: string, scanner?: OxcScanner) {
  const active =
    scanner ?? new OxcScanner({ cwd: root, include: ['src/**/*.ts'] });
  const { results, resolved } = await active.scanAndResolve();
  const errors = results.errors.filter((e) => e.severity === 'error');
  const model = (name: string) => resolved.find((c) => c.className === name);
  const manifest = () =>
    new ManifestAdapter().toManifest(resolved, { packageName: PACKAGE });
  return { errors, resolved, model, manifest, scanner: active };
}

async function scanProject(
  files: Record<string, string>,
  options: { dependencies?: string[] } = {},
) {
  const root = newRoot(options.dependencies);
  write(root, files);
  return { root, ...(await scanAt(root)) };
}

/** A single-table model that closes its API: the parent a child must get. */
const CLOSED_BASE = (name: string) =>
  `${CORE}\n@smrt({ tableStrategy: 'sti', api: false })\nexport class ${name} extends SmrtObject {\n  closedOnly = '';\n}\n`;
/** An open, own-table model of the same name: the parent a child must not get. */
const OPEN_BASE = (name: string) =>
  `${CORE}\n@smrt()\nexport class ${name} extends SmrtObject {\n  openOnly = '';\n}\n`;
const CHILD = (importLine: string, parent = 'Event') =>
  `${CORE}\n${importLine}\n@smrt()\nexport class Meeting extends ${parent} {\n  room = '';\n}\n`;

const fieldNames = (fields: RawFieldDefinition[] | undefined) =>
  (fields ?? []).map((field) => field.name);
const messages = (errors: Array<{ message: string }>) =>
  errors.map((e) => e.message).join('\n');

describe('parents', () => {
  it('accepts a parent imported from the file that declares it', async () => {
    const { errors, model } = await scanProject({
      'src/models/Event.ts': CLOSED_BASE('Event'),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Event';`),
    });

    expect(errors).toEqual([]);
    const meeting = model('Meeting');
    expect(meeting?.isSTI).toBe(true);
    expect(fieldNames(meeting?.allFields)).toEqual(['closedOnly', 'room']);
    expect(meeting?.extendsResolution).toBe('local');
  });

  it('accepts a parent declared in the same file', async () => {
    const { errors, model } = await scanProject({
      'src/models/Meeting.ts': `${CLOSED_BASE('Event')}\n@smrt()\nexport class Meeting extends Event {\n  room = '';\n}\n`,
    });

    expect(errors).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it('rejects a parent imported through a relative barrel and names the declaring file', async () => {
    const { errors, model } = await scanProject({
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/index.ts': `export { Event } from './Base';\n`,
      'src/Meeting.ts': CHILD(`import { Event } from './models';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("'./models'");
    expect(errors[0].message).toContain('re-exports `Event` from');
    expect(errors[0].message).toContain('./Base');
    expect(errors[0].message).toContain(
      'import it from the file that declares it',
    );
    expect(model('Meeting')?.extendsResolution).toBe('unresolved');
  });

  it('rejects a parent reached through export *', async () => {
    const { errors } = await scanProject({
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/index.ts': `export * from './Base';\n`,
      'src/Meeting.ts': CHILD(`import { Event } from './models';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('export *');
  });

  it('rejects a parent re-exported with import-then-export', async () => {
    const { errors } = await scanProject({
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/index.ts': `import { Event } from './Base';\nexport { Event };\n`,
      'src/Meeting.ts': CHILD(`import { Event } from './models';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('passes on `Event`');
  });

  it('accepts a default import of a file that declares the default class', async () => {
    const { errors, model } = await scanProject({
      'src/models/Event.ts': `${CORE}\n@smrt({ tableStrategy: 'sti', api: false })\nexport default class Event extends SmrtObject {\n  closedOnly = '';\n}\n`,
      'src/models/Meeting.ts': CHILD(`import Base from './Event';`, 'Base'),
    });

    expect(errors).toEqual([]);
    expect(model('Meeting')?.extendsName).toBe('Event');
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it('rejects a default re-exported from another file', async () => {
    const { errors } = await scanProject({
      'src/models/Event.ts': `${CORE}\n@smrt()\nexport default class Event extends SmrtObject {}\n`,
      'src/models/barrel.ts': `export { default } from './Event';\n`,
      'src/models/Meeting.ts': CHILD(`import Base from './barrel';`, 'Base'),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('re-exports `default`');
  });

  it('rejects a parent imported through a tsconfig paths alias', async () => {
    const { errors } = await scanProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
      }),
      'src/models/Event.ts': CLOSED_BASE('Event'),
      'src/Meeting.ts': CHILD(`import { Event } from '@app/models/Event';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('@app/models is not declared');
  });

  it('never takes the open fallback of a two-target paths alias', async () => {
    const { errors, model } = await scanProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '#models/*': ['restricted/*', 'src/models/*'] },
        },
      }),
      'restricted/Event.ts': CLOSED_BASE('Event'),
      'src/models/Event.ts': OPEN_BASE('Event'),
      'src/Meeting.ts': CHILD(`import { Event } from '#models/Event';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      'neither a relative path nor a scoped package',
    );
    expect(fieldNames(model('Meeting')?.allFields)).not.toContain('openOnly');
  });

  it('rejects a baseUrl bare import of a closed single-table parent', async () => {
    const { errors } = await scanProject({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
      'src/models/BaseEvent.ts': CLOSED_BASE('BaseEvent'),
      'src/Meeting.ts': CHILD(
        `import { BaseEvent } from 'models/BaseEvent';`,
        'BaseEvent',
      ),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("'models/BaseEvent'");
    expect(errors[0].message).toContain('import it by relative path');
  });

  it('rejects a parent from an unscoped package', async () => {
    const { errors } = await scanProject(
      { 'src/Meeting.ts': CHILD(`import { Event } from 'some-lib';`) },
      { dependencies: ['some-lib'] },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('scoped package');
  });

  it('rejects a scoped specifier the package.json does not declare, at scan time', async () => {
    const { errors } = await scanProject(
      { 'src/Meeting.ts': CHILD(`import { Event } from '@app/models';`) },
      { dependencies: [] },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('@app/models is not declared in');
  });

  it("qualifies ns.Event and ns['Event'] from a declared package", async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Meeting.ts': `${CORE}\nimport * as provider from '${PROVIDER}';\n@smrt()\nexport class Meeting extends provider.Event {}\n@smrt()\nexport class Call extends provider['Event'] {}\n`,
    });

    expect(errors).toEqual([]);
    const objects = manifest().objects;
    expect(objects[`${PACKAGE}:Meeting`]?.extendsQualified).toBe(
      `${PROVIDER}:Event`,
    );
    expect(objects[`${PACKAGE}:Call`]?.extendsQualified).toBe(
      `${PROVIDER}:Event`,
    );
    expect(objects[`${PACKAGE}:Call`]?.extendsImportPath).toBe(PROVIDER);
  });

  it('records the full specifier of a parent imported from a subpath', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Meeting.ts': CHILD(
        `import { Event } from '${PROVIDER}/models';`,
      ),
    });

    expect(errors).toEqual([]);
    const meeting = manifest().objects[`${PACKAGE}:Meeting`];
    expect(meeting?.extendsQualified).toBe(`${PROVIDER}:Event`);
    expect(meeting?.extendsImportPath).toBe(`${PROVIDER}/models`);
  });

  it('rejects a default import from a package', async () => {
    const { errors } = await scanProject({
      'src/Meeting.ts': CHILD(`import Event from '${PROVIDER}';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(`default export of ${PROVIDER}`);
  });

  it("rejects a parent imported through the package's own name", async () => {
    const { errors } = await scanProject({
      'src/models/Event.ts': CLOSED_BASE('Event'),
      'src/Meeting.ts': CHILD(`import { Event } from '${PACKAGE}';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('own name');
    expect(errors[0].message).toContain('relative path');
  });

  it('rejects a parent wrapped in a type assertion', async () => {
    const { errors } = await scanProject({
      'src/models/Event.ts': CLOSED_BASE('Event'),
      'src/Meeting.ts': CHILD(
        `import { Event } from './models/Event';`,
        '(Event as typeof Event)',
      ),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('TSAsExpression');
    expect(errors[0].message).toContain('write `extends Event`');
  });

  it.each([
    ['non-null', 'Event!'],
    ['satisfies', '(Event satisfies typeof Event)'],
  ])('rejects a %s superclass expression', async (_label, superClass) => {
    const { errors } = await scanProject({
      'src/models/Event.ts': CLOSED_BASE('Event'),
      'src/Meeting.ts': CHILD(
        `import { Event } from './models/Event';`,
        superClass,
      ),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('write `extends Event`');
  });

  it.each([
    ['string-literal member', "Base['Inner']", "Base['Inner']"],
    ['dotted member', 'Base.Inner', 'Base.Inner'],
  ])('rejects a %s of an imported class as the superclass', async (_label, superClass, shown) => {
    // `Base` is an open model; its static property holds the closed one.
    const { errors, model } = await scanProject({
      'src/models/Inner.ts': CLOSED_BASE('Inner'),
      'src/models/Base.ts': `${CORE}\nimport { Inner } from './Inner';\n@smrt()\nexport class Base extends SmrtObject {\n  static Inner = Inner;\n  openOnly = '';\n}\n`,
      'src/Meeting.ts': CHILD(
        `import { Base } from './models/Base';`,
        superClass,
      ),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toContain('Meeting.ts');
    expect(errors[0].message).toContain(
      `\`${shown}\` is a property of a value`,
    );
    expect(fieldNames(model('Meeting')?.allFields)).not.toContain('openOnly');
  });

  it('reports an undecorated collection whose superclass is a member of a model', async () => {
    // `Base.Inner` holds a concrete collection; the undecorated class over it
    // must not drop out of the manifest without a diagnostic.
    const { errors, model } = await scanProject({
      'src/models/Base.ts': `${CORE}\n@smrt()\nexport class Base extends SmrtObject {\n  name = '';\n}\nexport class BaseCollection extends SmrtCollection<Base> {\n  static readonly _itemClass = Base;\n}\nexport class Holder extends SmrtObject {\n  static Inner = BaseCollection;\n}\nexport class Children extends Holder['Inner'] {}\n`,
    });

    expect(model('Children')).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Children extends `Holder['Inner']`");
    expect(errors[0].message).toContain('property of a value');
  });

  it('reports an undecorated collection over a scanned collection imported through a barrel', async () => {
    const { errors, model } = await scanProject({
      'src/models/Base.ts': `${CORE}\n@smrt()\nexport class Base extends SmrtObject {\n  name = '';\n}\nexport class BaseCollection extends SmrtCollection<Base> {\n  static readonly _itemClass = Base;\n}\n`,
      'src/models/index.ts': `export { BaseCollection } from './Base';\n`,
      'src/Children.ts': `import { BaseCollection } from './models/index';\nexport class Children extends BaseCollection {}\n`,
    });

    expect(model('Children')).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Children extends `BaseCollection`');
    expect(errors[0].message).toContain('re-exports `BaseCollection`');
  });

  it('reports an undecorated collection over a directory whose package.json alone selects the declaring file', async () => {
    const { errors, model } = await scanProject({
      'src/models/package.json': JSON.stringify({ main: './base.ts' }),
      'src/models/base.ts': `${CORE}\n@smrt()\nexport class Base extends SmrtObject {\n  name = '';\n}\nexport class BaseCollection extends SmrtCollection<Base> {\n  static readonly _itemClass = Base;\n}\n`,
      'src/Children.ts': `import { BaseCollection } from './models/';\nexport class Children extends BaseCollection {}\n`,
    });

    expect(model('Children')).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Children extends `BaseCollection`');
    expect(errors[0].message).toContain('declares the entry it loads');
  });

  it('ignores an undecorated class over a directory whose package.json selects no candidate', async () => {
    const { errors } = await scanProject({
      'src/vendor/package.json': JSON.stringify({ main: './widget.ts' }),
      'src/vendor/widget.ts': `export class Widget {}\n`,
      'src/Gadget.ts': `import { Widget } from './vendor/';\nexport class Gadget extends Widget {}\n`,
    });

    expect(errors).toEqual([]);
  });

  it('reports an undecorated class whose superclass is a call over a framework base', async () => {
    const { errors, model } = await scanProject({
      'src/models/Mixed.ts': `${CORE}\nfunction Mixin<T>(base: T) { return base; }\nexport class Mixed extends Mixin(SmrtObject) {\n  name = '';\n}\n`,
    });

    expect(model('Mixed')).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Mixed extends');
    expect(errors[0].message).toContain('CallExpression');
  });

  it.each([
    [
      'a mixin over an aliased framework import',
      {
        'src/models/Mixed.ts': `import { SmrtObject as FrameworkObject } from '@happyvertical/smrt-core';\nfunction Mixin<T>(base: T) { return base; }\nexport class Mixed extends Mixin(FrameworkObject) {\n  name = '';\n}\n`,
      },
      'Mixed extends',
    ],
    [
      'a mixin over a namespace member that is a model',
      {
        'src/models/Base.ts': OPEN_BASE('Base'),
        'src/models/Mixed.ts': `import * as models from './Base';\nfunction Mixin<T>(base: T) { return base; }\nexport class Mixed extends Mixin(models.Base) {}\n`,
      },
      'Mixed extends',
    ],
  ])('reports an undecorated class over %s', async (_label, files, reason) => {
    const { errors, model } = await scanProject(files);

    expect(model('Mixed')).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(reason);
    expect(errors[0].message).toContain('CallExpression');
  });

  // A helper whose superclass only shares a model's spelling is no model
  // candidate: what decides is the binding the superclass references.
  it.each([
    [
      'an unimported global named like a model',
      {
        'src/models/Event.ts': OPEN_BASE('Event'),
        'src/reminders.ts': `export class ReminderEvent extends Event {}\n`,
      },
    ],
    [
      'the global Image beside a model named Image',
      {
        'src/models/Image.ts': OPEN_BASE('Image'),
        'src/thumbs.ts': `export class Thumb extends Image {}\n`,
      },
    ],
    [
      'an unscoped package import named like a model',
      {
        'src/models/Invoice.ts': OPEN_BASE('Invoice'),
        'src/pdf.ts': `import { Invoice } from 'pdf-invoice-lib';\nexport class PdfInvoice extends Invoice {}\n`,
      },
    ],
    [
      'an alias import named like a model',
      {
        'src/models/Invoice.ts': OPEN_BASE('Invoice'),
        'src/pdf.ts': `import { Invoice } from '$lib/pdf/Invoice';\nexport class PdfInvoice extends Invoice {}\n`,
      },
    ],
    [
      'a factory call with a string label naming a framework base',
      {
        'src/models/Base.ts': OPEN_BASE('Base'),
        'src/widgets.ts': `function makeWidget(label: string) { return class { label = label; }; }\nexport class Helper extends makeWidget('SmrtObject') {}\nexport class Other extends makeWidget('Base') {}\n`,
      },
    ],
  ])('ignores an undecorated helper over %s', async (_label, files) => {
    const { errors } = await scanProject(files);

    expect(errors).toEqual([]);
  });

  it('ignores an undecorated helper over a generic member of an unrelated value', async () => {
    const { errors } = await scanProject({
      'src/models/Base.ts': OPEN_BASE('Base'),
      'src/util.ts': `const utilities = { Widget: class<T> { value?: T; } };\nexport class Helper extends utilities.Widget<string> {}\n`,
    });

    expect(errors).toEqual([]);
  });

  it('ignores an undecorated class over a member of an unrelated value', async () => {
    const { errors } = await scanProject({
      'src/models/Base.ts': OPEN_BASE('Base'),
      'src/util.ts': `const widgets = { Button: class {} };\nexport class FancyButton extends widgets['Button'] {}\n`,
    });

    expect(errors).toEqual([]);
  });

  it('rejects an inline mixin call as the superclass', async () => {
    const { errors } = await scanProject({
      'src/Meeting.ts': `${CORE}\nfunction Mixin<T>(base: T) { return base; }\n@smrt()\nexport class Meeting extends Mixin(SmrtObject) {}\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('CallExpression');
  });

  it('rejects a model over an undecorated intermediate of a package class', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Bridge.ts': `import { ProviderBase } from '${PROVIDER}';\nexport class Bridge extends ProviderBase {}\n`,
      'src/models/Child.ts': `${CORE}\nimport { Bridge } from './Bridge';\n@smrt()\nexport class Child extends Bridge {}\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Child extends Bridge');
    expect(errors[0].message).toContain('not a model');
    expect(errors[0].message).toContain('@smrt({ abstract: true })');
    expect(
      manifest().objects[`${PACKAGE}:Child`]?.extendsQualified,
    ).toBeUndefined();
  });

  it("rejects a model over a plain helper that shares a model's name", async () => {
    const { errors } = await scanProject({
      'src/legacy/Event.ts': `export class Event {\n  helperOnly = '';\n}\n`,
      'src/billing/Event.ts': CLOSED_BASE('Event'),
      'src/legacy/Meeting.ts': CHILD(`import { Event } from './Event';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Meeting extends Event');
    expect(errors[0].message).toContain('not a model');
  });

  it('takes a base exported by the framework package as the framework', async () => {
    const { errors, model, manifest } = await scanProject({
      'src/reports/Tally.ts': `import { SmrtReportCollection } from '@happyvertical/smrt-reports';\nexport class TallyCollection extends SmrtReportCollection {}\n`,
      'src/models/Event.ts': OPEN_BASE('Event'),
    });

    expect(errors).toEqual([]);
    expect(model('TallyCollection')?.extendsResolution).toBe('framework');
    expect(
      manifest().objects[`${PACKAGE}:Event`]?.extendsQualified,
    ).toBeUndefined();
  });

  it('does not take a same-named class from another package for a framework base', async () => {
    const { model } = await scanProject({
      'src/reports/Tally.ts': `import { SmrtReportCollection } from '${PROVIDER}';\nexport class TallyCollection extends SmrtReportCollection {}\n`,
    });

    expect(model('TallyCollection')).toBeUndefined();
  });

  it('rejects a default import named SmrtObject', async () => {
    const { errors } = await scanProject({
      'src/Meeting.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport SmrtObject from '${PROVIDER}';\n@smrt()\nexport class Meeting extends SmrtObject {}\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(`default export of ${PROVIDER}`);
  });

  it('rejects an unimported global SmrtObject: only the import proves the framework base', async () => {
    const { errors } = await scanProject({
      'src/Meeting.ts': `import { smrt } from '@happyvertical/smrt-core';\n@smrt()\nexport class Meeting extends SmrtObject {}\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      "import { SmrtObject } from '@happyvertical/smrt-core'",
    );
  });

  it('reports a barrel import on an ancestor of a model', async () => {
    const { errors } = await scanProject({
      'src/models/Root.ts': CLOSED_BASE('Root'),
      'src/models/index.ts': `export { Root } from './Root';\n`,
      'src/models/Mid.ts': `${CORE}\nimport { Root } from './index';\n@smrt()\nexport class Mid extends Root {}\n`,
      'src/models/Leaf.ts': `${CORE}\nimport { Mid } from './Mid';\n@smrt()\nexport class Leaf extends Mid {}\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toContain('Mid.ts');
    expect(errors[0].message).toContain('Mid extends `Root`');
  });

  it('ignores a barrel import in a helper outside every model', async () => {
    const { errors } = await scanProject({
      'src/models/Root.ts': `export class Root {}\n`,
      'src/models/index.ts': `export { Root } from './Root';\n`,
      'src/models/Helper.ts': `import { Root } from './index';\nexport class Helper extends Root {}\n`,
    });

    expect(errors).toEqual([]);
  });

  it("reports the helper's barrel import once a model extends it", async () => {
    const { errors } = await scanProject({
      'src/models/Root.ts': CLOSED_BASE('Root'),
      'src/models/index.ts': `export { Root } from './Root';\n`,
      'src/models/Helper.ts': `import { Root } from './index';\nexport class Helper extends Root {}\n`,
      'src/models/Leaf.ts': `${CORE}\nimport { Helper } from './Helper';\n@smrt()\nexport class Leaf extends Helper {}\n`,
    });

    expect(messages(errors)).toContain('Helper extends `Root`');
  });

  // A relative specifier is accepted only when exactly one file on disk can
  // satisfy it: which of several TypeScript loads depends on the resolution
  // mode. The other file of each pair is named `OpenEvent`, since two models
  // named `Event` in one scan collide.
  const OPEN_OTHER = OPEN_BASE('Event').replace(
    'class Event',
    'class OpenEvent',
  );
  it.each([
    [
      'a file and a directory index',
      './Base',
      {
        'src/models/Base.ts': CLOSED_BASE('Event'),
        'src/models/Base/index.ts': OPEN_OTHER,
      },
    ],
    [
      'a JavaScript file and a directory index (bundler checks the file first)',
      './Base',
      {
        'tsconfig.json': JSON.stringify({
          compilerOptions: { moduleResolution: 'bundler' },
        }),
        'src/models/Base.js': 'export class Event {}\n',
        'src/models/Base/index.ts': OPEN_BASE('Event'),
      },
    ],
  ])('rejects a specifier that could name %s', async (_label, specifier, files) => {
    const root = newRoot();
    write(root, {
      ...files,
      'src/models/Meeting.ts': CHILD(`import { Event } from '${specifier}';`),
    });
    const scanner = new OxcScanner({
      cwd: root,
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    });
    const { errors, model } = await scanAt(root, scanner);

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toContain('Meeting.ts');
    expect(errors[0].message).toContain('could name more than one file');
    expect(errors[0].message).toContain(
      'make the import name exactly one file',
    );
    expect(fieldNames(model('Meeting')?.allFields)).toEqual(['room']);
  });

  it('rejects a file and an index even when the scan reads only one of them', async () => {
    const root = newRoot();
    write(root, {
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/Base/index.ts': OPEN_BASE('Event'),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });
    const scanner = new OxcScanner({
      cwd: root,
      include: ['src/**/*.ts'],
      exclude: ['src/models/Base.ts'],
    });
    const { errors, model } = await scanAt(root, scanner);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('could name more than one file');
    expect(fieldNames(model('Meeting')?.allFields)).not.toContain('openOnly');
  });

  // A module-suffix variant (`Base.ios.ts`) beside a file the specifier names
  // is a file a tsconfig `moduleSuffixes` or a bundler may load instead. The
  // scan reads no tsconfig, so a variant on disk is an error with or without
  // one, including before a generated config exists or when the config comes
  // from a package the scan cannot read.
  it.each([
    [
      'a variant of the same extension',
      './Base',
      {
        'src/models/Base.ios.ts': CLOSED_BASE('Event'),
        'src/models/Base.ts': OPEN_OTHER,
      },
    ],
    [
      'a variant of another extension',
      './Base',
      {
        'src/models/Base.ts': CLOSED_BASE('Event'),
        'src/models/Base.ios.tsx': OPEN_OTHER,
      },
    ],
    [
      'a variant behind an explicit .js extension',
      './Base.js',
      {
        'src/models/Base.ios.ts': CLOSED_BASE('Event'),
        'src/models/Base.ts': OPEN_OTHER,
      },
    ],
    [
      'only a variant',
      './Base',
      { 'src/models/Base.ios.ts': CLOSED_BASE('Event') },
    ],
    [
      'a compound platform variant',
      './Base',
      {
        'src/models/Base.native.ios.ts': CLOSED_BASE('Event'),
        'src/models/Base.ts': OPEN_OTHER,
      },
    ],
    [
      'a platform variant of a declaration file',
      './Base',
      {
        'src/models/Base.web.d.ts': 'export declare class Event {}\n',
        'src/models/Base.ts': OPEN_OTHER,
      },
    ],
    [
      'a variant of a directory index',
      './Base/',
      {
        'src/models/Base/index.native.ts': CLOSED_BASE('Event'),
        'src/models/Base/index.ts': OPEN_OTHER,
      },
    ],
    [
      'a variant while a tsconfig that sets no suffixes extends a missing generated config',
      './Base',
      {
        'tsconfig.json': JSON.stringify({
          extends: './.svelte-kit/tsconfig.json',
        }),
        'src/models/Base.ios.ts': CLOSED_BASE('Event'),
        'src/models/Base.ts': OPEN_OTHER,
      },
    ],
    [
      'a variant while the tsconfig comes from a config package',
      './Base',
      {
        'tsconfig.json': JSON.stringify({ extends: '@fixture/tsconfig' }),
        'node_modules/@fixture/tsconfig/package.json': JSON.stringify({
          name: '@fixture/tsconfig',
          main: 'index.js',
          tsconfig: 'base.json',
        }),
        'node_modules/@fixture/tsconfig/index.js': 'module.exports = {};\n',
        'node_modules/@fixture/tsconfig/base.json': JSON.stringify({
          compilerOptions: { moduleSuffixes: ['.ios', ''] },
        }),
        'src/models/Base.ios.ts': CLOSED_BASE('Event'),
        'src/models/Base.ts': OPEN_OTHER,
      },
    ],
  ])('rejects a specifier beside %s', async (_label, specifier, files) => {
    const root = newRoot();
    write(root, {
      ...files,
      'src/models/Meeting.ts': CHILD(`import { Event } from '${specifier}';`),
    });
    const scanner = new OxcScanner({
      cwd: root,
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    });
    const { errors, model } = await scanAt(root, scanner);

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toContain('Meeting.ts');
    expect(errors[0].message).toContain('could also name');
    expect(errors[0].message).toContain('module-suffix variant');
    expect(fieldNames(model('Meeting')?.allFields)).toEqual(['room']);
  });

  it('rejects a specifier beside a variant the scan does not read', async () => {
    const root = newRoot();
    write(root, {
      'src/models/Base.ios.ts': CLOSED_BASE('Event'),
      'src/models/Base.ts': OPEN_BASE('Event'),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });
    const scanner = new OxcScanner({
      cwd: root,
      include: ['src/**/*.ts'],
      exclude: ['src/models/Base.ios.ts'],
    });
    const { errors, model } = await scanAt(root, scanner);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('could also name');
    expect(fieldNames(model('Meeting')?.allFields)).not.toContain('openOnly');
  });

  it('accepts a file beside companion files that are not platform variants, and parses no tsconfig', async () => {
    const { errors, model } = await scanProject({
      // Unparseable: the scan never parses it.
      'tsconfig.json': '{ "compilerOptions": { "strict": true ',
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/Base.test.ts': `export const tested = true;\n`,
      'src/models/Base.spec.ts': `export const specified = true;\n`,
      'src/models/Base.stories.tsx': `export const story = {};\n`,
      'src/models/Base.config.ts': `export const config = {};\n`,
      'src/models/Base.mock.ts': `export const mock = {};\n`,
      'src/models/Base.fixtures.ts': `export const fixtures = [];\n`,
      'src/models/Base.e2e.ts': `export const e2e = true;\n`,
      'src/models/Base.bench.ts': `export const bench = true;\n`,
      'src/models/Base.types.ts': `export type EventKind = 'a' | 'b';\n`,
      'src/models/Base.schema.ts': `export const eventSchema = {};\n`,
      'src/models/Base.server.ts': `export const load = () => ({});\n`,
      'src/models/Base.svelte.ts': `export const state = { open: false };\n`,
      'src/models/Base.utils.ts': `export const format = () => '';\n`,
      'src/models/Base.constants.ts': `export const LIMIT = 3;\n`,
      'src/models/Base.native.test.ts': `export const nativeTested = true;\n`,
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });

    expect(errors).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it('accepts a directory import beside an index companion file', async () => {
    const { errors, model } = await scanProject({
      'src/models/index.ts': CLOSED_BASE('Event'),
      'src/models/index.types.ts': `export type EventKind = 'a';\n`,
      'src/Meeting.ts': CHILD(`import { Event } from './models/';`),
    });

    expect(errors).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it.each([
    [
      'tsconfig.json',
      '{ "compilerOptions": { "moduleSuffixes": [".mock", ""] } }',
    ],
    // Not parsed: a mention in any form, even in unreadable JSON, fails.
    [
      'tsconfig.app.json',
      '{ "compilerOptions": { "moduleSuffixes": [".native.ios", "" ',
    ],
  ])('fails the scan when %s, which the project config extends, mentions moduleSuffixes', async (name, text) => {
    const { errors, model } = await scanProject({
      ...(name === 'tsconfig.json'
        ? {}
        : { 'tsconfig.json': '{ "extends": "./tsconfig.app" }' }),
      [name]: text,
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/Base.mock.ts': OPEN_OTHER,
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toContain(name);
    expect(errors[0].message).toContain(
      'moduleSuffixes is unsupported by the scanner',
    );
    expect(errors[0].message).toContain(
      'import files explicitly (`./Base.ios`) or remove the option',
    );
    expect(model('Meeting')).toBeDefined();
  });

  it.each([
    [
      'a commented-out option in tsconfig.json',
      {
        'tsconfig.json':
          '{\n  // "moduleSuffixes": [".ios", ""],\n  /* "moduleSuffixes": [] */\n  "compilerOptions": { "strict": true, },\n}\n',
      },
    ],
    [
      'an unused sibling config',
      {
        'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
        'tsconfig.test.json':
          '{ "compilerOptions": { "moduleSuffixes": [".mock", ""] } }',
      },
    ],
    [
      'a commented-out option in an extended config',
      {
        'tsconfig.json': '{ "extends": "./tsconfig.base.json" }',
        'tsconfig.base.json':
          '{ "compilerOptions": { /* "moduleSuffixes": [".mock", ""] */ } }',
      },
    ],
    [
      'a config package nothing reads',
      { 'tsconfig.json': '{ "extends": "@fixture/tsconfig" }' },
    ],
  ])('scans a project with %s, which sets no module suffixes', async (_label, configs) => {
    const { errors, model } = await scanProject({
      ...configs,
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });

    expect(errors).toEqual([]);
    expect(model('Meeting')).toBeDefined();
  });

  it.each([
    [
      'a config the project config extends through an array',
      {
        'tsconfig.json':
          '{ "extends": ["./tsconfig.a.json", "./configs/tsconfig.b"] }',
        'tsconfig.a.json': '{}',
        'configs/tsconfig.b.json': '{ "extends": "../tsconfig.c.json" }',
        'tsconfig.c.json': '{ "compilerOptions": { "moduleSuffixes": [""] } }',
      },
      'tsconfig.c.json',
    ],
    [
      'a project reference',
      {
        'tsconfig.json':
          '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
        'tsconfig.app.json':
          '{ "compilerOptions": { "moduleSuffixes": [""] } }',
      },
      'tsconfig.app.json',
    ],
  ])('fails the scan for %s that sets moduleSuffixes', async (_label, configs, file) => {
    const { errors } = await scanProject({
      ...configs,
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toContain(file);
    expect(errors[0].message).toContain('moduleSuffixes is unsupported');
  });

  it('reads a trailing slash as the directory, not a sibling file', async () => {
    const { errors, model } = await scanProject({
      'src/models/Base.ts': OPEN_OTHER,
      'src/models/Base/index.ts': CLOSED_BASE('Event'),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base/';`),
    });

    expect(errors).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it.each([
    './models/',
    './models',
  ])('accepts %s when the directory package.json only marks the module format', async (specifier) => {
    const { errors, model } = await scanProject({
      'src/models/package.json': JSON.stringify({ type: 'module' }),
      'src/models/index.ts': CLOSED_BASE('Event'),
      'src/Meeting.ts': CHILD(`import { Event } from '${specifier}';`),
    });

    expect(errors).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it.each([
    [
      'beside the index it could also load',
      { main: './index.js' },
      true,
      'could name more than one file',
    ],
    [
      'as the only candidate',
      { exports: { '.': './lib/event.js' } },
      false,
      'declares the entry it loads',
    ],
  ])('rejects a directory whose package.json declares an entry %s', async (_label, manifest, withIndex, reason) => {
    const { errors, model } = await scanProject({
      'src/models/package.json': JSON.stringify(manifest),
      ...(withIndex ? { 'src/models/index.ts': OPEN_BASE('Event') } : {}),
      'src/Meeting.ts': CHILD(`import { Event } from './models/';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(reason);
    expect(errors[0].message).toContain(join('src', 'models', 'package.json'));
    expect(fieldNames(model('Meeting')?.allFields)).toEqual(['room']);
  });

  it('accepts a variant imported by its full name', async () => {
    const { errors, model } = await scanProject({
      'src/models/Base.ios.ts': CLOSED_BASE('Event'),
      'src/models/Base.ts': OPEN_OTHER,
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base.ios';`),
    });

    expect(errors).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it('fails when the one file a specifier names is outside the scan', async () => {
    const root = newRoot();
    write(root, {
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });
    const scanner = new OxcScanner({
      cwd: root,
      include: ['src/**/*.ts'],
      exclude: ['src/models/Base.ts'],
    });
    const { errors } = await scanAt(root, scanner);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(join('src/models/Base.ts'));
    expect(errors[0].message).toContain('add the file to the scan include');
  });

  it('rejects the one file a specifier names when it is JavaScript', async () => {
    const { errors } = await scanProject({
      'src/models/Base.js': 'export class Event {}\n',
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('not TypeScript source');
  });

  it('rejects a relative file that exports another class under the imported name', async () => {
    const { errors, model } = await scanProject({
      'src/models/Event.ts': `${CORE}\n@smrt({ tableStrategy: 'sti', api: false })\nclass Event extends SmrtObject {\n  closedOnly = '';\n}\n@smrt()\nclass OpenEvent extends SmrtObject {\n  openOnly = '';\n}\nexport { OpenEvent as Event };\nexport const keep = Event;\n`,
      'src/models/Meeting.ts': CHILD(`import { Event } from './Event';`),
    });

    expect(messages(errors)).toContain(
      'exports `OpenEvent` under the name `Event`',
    );
    expect(fieldNames(model('Meeting')?.allFields)).not.toContain('closedOnly');
  });

  it('rejects a package import that loads a different installed copy than the build reads', async () => {
    const root = newRoot();
    write(root, {
      [`node_modules/${PROVIDER}/package.json`]: JSON.stringify({
        name: PROVIDER,
        version: '2.0.0',
      }),
      [`src/nested/node_modules/${PROVIDER}/package.json`]: JSON.stringify({
        name: PROVIDER,
        version: '1.0.0',
      }),
      'src/nested/Meeting.ts': CHILD(`import { Event } from '${PROVIDER}';`),
    });
    const { errors } = await scanAt(root);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(`two copies of ${PROVIDER}`);
  });

  it('accepts a package import when the file and the build load the same copy', async () => {
    const root = newRoot();
    write(root, {
      [`node_modules/${PROVIDER}/package.json`]: JSON.stringify({
        name: PROVIDER,
      }),
      'src/nested/Meeting.ts': CHILD(`import { Event } from '${PROVIDER}';`),
    });
    const { errors } = await scanAt(root);

    expect(errors).toEqual([]);
  });

  it('keeps an undecorated collection whose superclass is wrapped, and reports it', async () => {
    const { errors, model } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/models/Accounts.ts': `${CORE}\nimport { Account } from './Account';\nexport class AccountCollection extends (SmrtCollection as typeof SmrtCollection)<Account> {}\n`,
    });

    expect(model('AccountCollection')).toBeDefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('AccountCollection');
    expect(errors[0].message).toContain('write `extends SmrtCollection`');
  });
});

describe('relationship targets and report sources', () => {
  const ACCOUNT = `${CORE}\n@smrt()\nexport class Account extends SmrtObject {\n  name = '';\n}\n`;
  const holder = (imports: string, decorator: string) =>
    `${CORE}\n${imports}\n@smrt()\nexport class Holder extends SmrtObject {\n  ${decorator}\n}\n`;
  const target = (
    scanned: Awaited<ReturnType<typeof scanProject>>,
    field = 'ownerId',
  ) =>
    scanned.model('Holder')?.fields.find((f) => f.name === field)?.decorators[0]
      .argumentValues?.[0];

  it('records a target by its declaring class through an aliased direct import', async () => {
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/holder.ts': holder(
        `import { Account as Owner } from './account';`,
        `@foreignKey(Owner) ownerId = '';\n  @foreignKey(() => Owner) payerId = '';`,
      ),
    });

    expect(scanned.errors).toEqual([]);
    expect(target(scanned)?.value).toBe('Account');
    expect(target(scanned, 'payerId')?.value).toBe('Account');
  });

  it('rejects a relationship target imported through a barrel', async () => {
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/index.ts': `export { Account } from './account';\n`,
      'src/models/holder.ts': holder(
        `import { Account } from './index';`,
        `@foreignKey(Account) ownerId = '';`,
      ),
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain('Holder.ownerId');
    expect(scanned.errors[0].message).toContain('re-exports `Account`');
  });

  it('records a target column written as a string after the class name', async () => {
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/holder.ts': holder(
        '',
        `@foreignKey('Account.name') ownerName = '';`,
      ),
    });

    expect(scanned.errors).toEqual([]);
    expect(target(scanned, 'ownerName')).toEqual({ value: 'Account.name' });
  });

  it.each([
    ['inline', "@foreignKey(Account.email) ownerEmail = '';"],
    ['thunk', "@foreignKey(() => Account.email) ownerEmail = '';"],
  ])('rejects a class member as a %s target and names both supported spellings', async (_label, decorator) => {
    // `Account.email` is an instance field: undefined on the class, which
    // the runtime decorator rejects.
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/holder.ts': holder(
        `import { Account } from './account';`,
        decorator,
      ),
    });

    expect(scanned.errors).toHaveLength(1);
    const { message } = scanned.errors[0];
    expect(message).toContain('`Account.email` is a property of `Account`');
    expect(message).toContain('To target the class, write `Account`');
    expect(message).toContain("write the string 'Account.email'");
  });

  it.each([
    ['inline', "@foreignKey(Account.name) ownerId = '';"],
    ['thunk', "@foreignKey(() => Account.name) ownerId = '';"],
  ])("points a %s `Target.name` target at the class it names at runtime, not at a 'name' column", async (_label, decorator) => {
    // `Account.name` is the string 'Account', which the decorator reads as
    // the class; 'Account.name' would reference the column `name`.
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/holder.ts': holder(
        `import { Account } from './account';`,
        decorator,
      ),
    });

    expect(scanned.errors).toHaveLength(1);
    const { message } = scanned.errors[0];
    expect(message).toContain('reads as the class `Account`');
    expect(message).toContain("write `Account` (or 'Account')");
    expect(message).not.toContain("'Account.name'");
  });

  it.each([
    ['name', 'write `Owner` to keep that target', "'Owner'"],
    ['email', "'<declared class name>.email'", "'Owner.email'"],
  ])("never offers a default import's local name as a string for `Owner.%s`", async (member, offered, never) => {
    // The runtime reads the declared name 'Account', not 'Owner'.
    const scanned = await scanProject({
      'src/models/account.ts': `${CORE}\n@smrt()\nexport default class Account extends SmrtObject {\n  email = '';\n}\n`,
      'src/models/holder.ts': holder(
        `import Owner from './account';`,
        `@foreignKey(Owner.${member}) ownerId = '';`,
      ),
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain(offered);
    expect(scanned.errors[0].message).not.toContain(never);
  });

  it('rejects a relationship target imported through a tsconfig alias', async () => {
    const scanned = await scanProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '$lib/*': ['src/*'] } },
      }),
      'src/models/account.ts': ACCOUNT,
      'src/models/holder.ts': holder(
        `import { Account } from '$lib/models/account';`,
        `@foreignKey(Account) ownerId = '';`,
      ),
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain('$lib/models/account');
  });

  it('records a report source from a declared package subpath', async () => {
    const scanned = await scanProject({
      'src/models/Tally.ts': `${CORE}\nimport { Attendance } from '${PROVIDER}/attendance';\n@report({ source: Attendance })\nexport class Tally extends SmrtObject {\n  total = 0;\n}\n`,
    });

    expect(scanned.errors).toEqual([]);
    const report = scanned.model('Tally')?.decoratorConfig?.report as Record<
      string,
      unknown
    >;
    expect(report.sourceQualified).toBe(`${PROVIDER}:Attendance`);
    expect(report.sourceImportPath).toBe(`${PROVIDER}/attendance`);
  });

  it("rejects a report source imported through the package's own name on a clean build", async () => {
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/Tally.ts': `${CORE}\nimport { Account } from '${PACKAGE}';\n@report({ source: Account })\nexport class Tally extends SmrtObject {\n  total = 0;\n}\n`,
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain('@report() source');
    expect(scanned.errors[0].message).toContain('own name');
  });

  it("confirms an STI field override's target in its declaring module", async () => {
    const scanned = await scanProject({
      'src/models/Owner.ts': `${CORE}\n@smrt()\nexport class Owner extends SmrtObject {}\n`,
      'src/models/OwnerAlias.ts': `${CORE}\n@smrt()\nexport class OwnerAlias extends SmrtObject {}\n`,
      'src/models/Base.ts': `${CORE}\n@smrt({ tableStrategy: 'sti' })\nexport class Base extends SmrtObject {\n  @foreignKey('OwnerAlias') ownerId = '';\n}\n`,
      'src/models/Child.ts': `${CORE}\nimport { Base } from './Base';\nimport { Owner as OwnerAlias } from './Owner';\n@smrt()\nexport class Child extends Base {\n  @foreignKey(OwnerAlias) override ownerId = '';\n}\n`,
    });

    expect(scanned.errors).toEqual([]);
    const child = scanned.model('Child');
    const merged = child?.allFields.find((f) => f.name === 'ownerId');
    expect(merged?.decorators[0].argumentValues?.[0]?.value).toBe('Owner');
    const converted =
      scanned.manifest().objects[`${PACKAGE}:Child`]?.fields.ownerId;
    expect(converted?.related).toBe('Owner');
  });

  it("rejects an STI field override's target imported through a barrel", async () => {
    const scanned = await scanProject({
      'src/models/Owner.ts': `${CORE}\n@smrt()\nexport class Owner extends SmrtObject {}\n`,
      'src/models/index.ts': `export { Owner } from './Owner';\n`,
      'src/models/Base.ts': `${CORE}\n@smrt({ tableStrategy: 'sti' })\nexport class Base extends SmrtObject {\n  @foreignKey('Owner') ownerId = '';\n}\n`,
      'src/models/Child.ts': `${CORE}\nimport { Base } from './Base';\nimport { Owner } from './index';\n@smrt()\nexport class Child extends Base {\n  @foreignKey(Owner) override ownerId = '';\n}\n`,
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain('Child.ownerId');
  });

  it('rejects a package target the package.json does not declare', async () => {
    const scanned = await scanProject(
      {
        'src/models/holder.ts': holder(
          `import { Account } from '@fixture/accounts';`,
          `@foreignKey(Account) ownerId = '';`,
        ),
      },
      { dependencies: [] },
    );

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain(
      '@fixture/accounts is not declared',
    );
  });

  it('rejects a relative target that is a plain class while a model of that name exists', async () => {
    const scanned = await scanProject({
      'src/models/Account.ts': ACCOUNT,
      'src/legacy/Account.ts': `export class Account {}\n`,
      'src/legacy/holder.ts': holder(
        `import { Account } from './Account';`,
        `@foreignKey(Account) ownerId = '';`,
      ),
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain('is not a model');
  });

  it('rejects a same-file target that is a plain class', async () => {
    const scanned = await scanProject({
      'src/models/Account.ts': ACCOUNT,
      'src/legacy/holder.ts': `${CORE}\nclass Account {}\n@smrt()\nexport class Holder extends SmrtObject {\n  @foreignKey(Account) ownerId = '';\n}\nexport const keep = Account;\n`,
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain('is not a model');
  });

  it('rejects a report source that is a plain class', async () => {
    const scanned = await scanProject({
      'src/models/Account.ts': ACCOUNT,
      'src/legacy/Account.ts': `export class Account {}\n`,
      'src/legacy/Tally.ts': `${CORE}\nimport { Account } from './Account';\n@report({ source: Account })\nexport class Tally extends SmrtObject {\n  total = 0;\n}\n`,
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain('@report() source');
    expect(scanned.errors[0].message).toContain('is not a model');
  });

  it('rejects a reference to a stand-in for another package', async () => {
    const scanned = await scanProject({
      'src/models/Account.ts': ACCOUNT,
      'src/fixtures/Account.ts': `${CORE}\n@smrt({ packageName: '@fixture/other' })\nexport class Account extends SmrtObject {\n  standInOnly = '';\n}\n`,
      'src/models/holder.ts': holder(
        `import { Account } from '../fixtures/Account';`,
        `@foreignKey(Account) ownerId = '';`,
      ),
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain('stand-in');
  });
});

describe('collection items', () => {
  it('records an item imported from a declared package by its identity', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Accounts.ts': `${CORE}\nimport { Account } from '${PROVIDER}';\nexport class AccountCollection extends SmrtCollection<Account> {}\n`,
    });

    expect(errors).toEqual([]);
    const collection = manifest().objects[`${PACKAGE}:AccountCollection`];
    expect(collection?.extendsTypeArgQualified).toBe(`${PROVIDER}:Account`);
    expect(collection?.extendsTypeArgImportPath).toBe(PROVIDER);
  });

  it('proves an item named by a type-only import, beside a runtime alias for _itemClass', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/models/Accounts.ts': `${CORE}\nimport type { Account } from '${PROVIDER}';\nimport { Account as RuntimeAccount } from '${PROVIDER}';\nexport class AccountCollection extends SmrtCollection<Account> {\n  static readonly _itemClass = RuntimeAccount;\n}\n`,
    });

    expect(errors).toEqual([]);
    const collection = manifest().objects[`${PACKAGE}:AccountCollection`];
    expect(collection?.extendsTypeArgQualified).toBe(`${PROVIDER}:Account`);
  });

  it.each([
    [
      'a type-only import through a barrel',
      {
        'src/models/Account.ts': OPEN_BASE('Account'),
        'src/models/index.ts': `export { Account } from './Account';\n`,
        'src/models/Accounts.ts': `${CORE}\nimport type { Account } from './index';\nexport class AccountCollection extends SmrtCollection<Account> {}\n`,
      },
      're-exports `Account`',
    ],
    [
      'a type-only import whose runtime _itemClass is another class',
      {
        'src/models/Account.ts': OPEN_BASE('Account'),
        'src/models/Accounts.ts': `${CORE}\nimport type { Account } from '${PROVIDER}';\nimport { Account as LocalAccount } from './Account';\nexport class AccountCollection extends SmrtCollection<Account> {\n  static readonly _itemClass = LocalAccount;\n}\n`,
      },
      'static _itemClass',
    ],
    [
      'a name neither imported, declared nor a type parameter',
      {
        'src/models/Account.ts': OPEN_BASE('Account'),
        'src/models/Accounts.ts': `${CORE}\nexport class AccountCollection extends SmrtCollection<Account> {}\n`,
      },
      'neither declared in this file nor imported',
    ],
  ])('rejects a collection item named by %s', async (_label, files, reason) => {
    const { errors } = await scanProject(files);

    expect(messages(errors)).toContain(reason);
  });

  it("skips the class's own type parameter and a type keyword", async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/models/Bases.ts': `${CORE}\nexport abstract class TypedCollection<Account extends SmrtObject> extends SmrtCollection<Account> {}\nexport class AnyCollection extends SmrtCollection<any> {}\n`,
    });

    expect(errors).toEqual([]);
    const typed = manifest().objects[`${PACKAGE}:TypedCollection`];
    expect(typed?.extendsTypeArgQualified).toBeUndefined();
    // The parameter's spelling never reaches generation's name lookup.
    expect(typed?.extendsTypeArg).toBeUndefined();
    expect(
      manifest().objects[`${PACKAGE}:AnyCollection`]?.extendsTypeArg,
    ).toBeUndefined();
  });

  it('takes the item of a type-parameter collection from its static _itemClass', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/models/Ledger.ts': `${CORE}\nimport { Account as VendorAccount } from '${PROVIDER}';\nexport class Ledger<Account extends VendorAccount> extends SmrtCollection<Account> {\n  static readonly _itemClass = VendorAccount;\n}\n`,
    });

    expect(errors).toEqual([]);
    const ledger = manifest().objects[`${PACKAGE}:Ledger`];
    expect(ledger?.extendsTypeArg).toBe('Account');
    expect(ledger?.extendsTypeArgQualified).toBe(`${PROVIDER}:Account`);
  });

  it.each([
    [
      'a plain class',
      `export class Plain {}\nexport class Ledger<Account> extends SmrtCollection<any> {\n  static readonly _itemClass = Plain;\n}\n`,
      'is not a model',
    ],
    [
      'an expression',
      `export class Ledger<Account> extends SmrtCollection<Account> {\n  static readonly _itemClass = pick();\n}\n`,
      'is not a class reference',
    ],
  ])('rejects a type-parameter collection whose static _itemClass is %s', async (_label, source, reason) => {
    const { errors } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/models/Ledger.ts': `${CORE}\nconst pick = () => null;\n${source}`,
    });

    expect(messages(errors)).toContain(`static _itemClass`);
    expect(messages(errors)).toContain(reason);
  });

  it('rejects a static _itemClass that names another class than the type argument', async () => {
    const { errors } = await scanProject({
      'src/models/Account.ts': `${CORE}\n@smrt()\nexport class Account extends SmrtObject {}\n@smrt()\nexport class Ledger extends SmrtObject {}\n`,
      'src/models/Accounts.ts': `${CORE}\nimport { Account, Ledger } from './Account';\nexport class AccountCollection extends SmrtCollection<Account> {\n  static readonly _itemClass = Ledger;\n}\n`,
    });

    expect(messages(errors)).toContain('static _itemClass');
  });

  it('records the row model of a junction collection imported from a declared package by its identity', async () => {
    const JUNCTIONS = `import { SmrtJunction, SmrtJunctionBase } from '@happyvertical/smrt-core';`;
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/models/Links.ts': `${JUNCTIONS}\nimport { Account } from '${PROVIDER}';\nexport class AccountLinks extends SmrtJunction<Account> {}\nexport class AccountPairs extends SmrtJunctionBase<Account> {}\n`,
    });

    expect(errors).toEqual([]);
    const objects = manifest().objects;
    for (const name of ['AccountLinks', 'AccountPairs']) {
      expect(objects[`${PACKAGE}:${name}`]?.extendsTypeArgQualified).toBe(
        `${PROVIDER}:Account`,
      );
    }
  });

  it('rejects a junction collection whose row is a plain class', async () => {
    const { errors } = await scanProject({
      'src/models/Link.ts': `export class Link {}\n`,
      'src/models/Links.ts': `import { SmrtJunction } from '@happyvertical/smrt-core';\nimport { Link } from './Link';\nexport class LinkCollection extends SmrtJunction<Link> {}\n`,
    });

    expect(messages(errors)).toContain('is not a model');
  });

  it('rejects an item that is a plain class', async () => {
    const { errors } = await scanProject({
      'src/models/Account.ts': `export class Account {}\n`,
      'src/models/Accounts.ts': `${CORE}\nimport { Account } from './Account';\nexport class AccountCollection extends SmrtCollection<Account> {}\n`,
    });

    expect(messages(errors)).toContain('is not a model');
  });
});

describe('collection items through an app-level generic collection', () => {
  const GENERIC_BASE = `${CORE}\nexport abstract class BaseCollection<T extends SmrtObject> extends SmrtCollection<T> {}\n`;

  it('proves the item named through one or two generic collection ancestors by identity', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/collections/BaseCollection.ts': GENERIC_BASE,
      'src/collections/MidCollection.ts': `${CORE}\nimport { BaseCollection } from './BaseCollection';\nexport abstract class MidCollection<Item extends SmrtObject> extends BaseCollection<Item> {}\n`,
      'src/collections/VendorAccounts.ts': `${CORE}\nimport { Account } from '${PROVIDER}';\nimport { BaseCollection } from './BaseCollection';\nexport class VendorAccounts extends BaseCollection<Account> {\n  static readonly _itemClass = Account;\n}\n`,
      'src/collections/DeepAccounts.ts': `${CORE}\nimport type { Account } from '${PROVIDER}';\nimport { MidCollection } from './MidCollection';\nexport class DeepAccounts extends MidCollection<Account> {}\n`,
    });

    expect(errors).toEqual([]);
    const objects = manifest().objects;
    for (const name of ['VendorAccounts', 'DeepAccounts']) {
      expect(objects[`${PACKAGE}:${name}`]?.extendsTypeArgQualified).toBe(
        `${PROVIDER}:Account`,
      );
    }
    // The generic ancestors name no item at all.
    expect(
      objects[`${PACKAGE}:BaseCollection`]?.extendsTypeArg,
    ).toBeUndefined();
    expect(objects[`${PACKAGE}:MidCollection`]?.extendsTypeArg).toBeUndefined();
  });

  it('takes the item an ancestor fixes, not the type argument the subclass passes', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/models/Closed.ts': CLOSED_BASE('ClosedEntry'),
      'src/collections/Entries.ts': `${CORE}\nimport { ClosedEntry } from '../models/Closed';\nexport abstract class EntryCollection<Tag> extends SmrtCollection<ClosedEntry> {}\n`,
      'src/collections/Tagged.ts': `${CORE}\nimport { Account } from '../models/Account';\nimport { EntryCollection } from './Entries';\nexport class TaggedEntries extends EntryCollection<Account> {}\n`,
    });

    expect(errors).toEqual([]);
    const tagged = manifest().objects[`${PACKAGE}:TaggedEntries`];
    expect(tagged?.extendsTypeArg).toBe('ClosedEntry');
  });

  it('rejects a subclass whose generic ancestor passes another type parameter than its first, and records no item', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/collections/Pair.ts': `${CORE}\nexport abstract class PairCollection<Tag, T extends SmrtObject> extends SmrtCollection<T> {}\n`,
      'src/collections/Accounts.ts': `${CORE}\nimport { Account } from '../models/Account';\nimport { PairCollection } from './Pair';\nexport class Accounts extends PairCollection<string, Account> {}\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Accounts');
    expect(errors[0].message).toContain('not its first');
    expect(manifest().objects[`${PACKAGE}:Accounts`]?.extendsTypeArg).toBe(
      undefined,
    );
  });

  it("takes the model a static _itemClass narrows an ancestor item to, and gives a class naming no item the ancestor's item", async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/models/Closed.ts': `${CLOSED_BASE('ClosedEntry')}\n@smrt()\nexport class SpecialEntry extends ClosedEntry {}\n`,
      'src/collections/Entries.ts': `${CORE}\nimport { ClosedEntry } from '../models/Closed';\nexport abstract class EntryCollection extends SmrtCollection<ClosedEntry> {}\n`,
      'src/collections/Special.ts': `${CORE}\nimport { SpecialEntry } from '../models/Closed';\nimport { EntryCollection } from './Entries';\nexport class SpecialEntries extends EntryCollection {\n  static readonly _itemClass = SpecialEntry;\n}\nexport class PlainEntries extends EntryCollection {}\n`,
    });

    expect(errors).toEqual([]);
    const objects = manifest().objects;
    expect(objects[`${PACKAGE}:SpecialEntries`]?.extendsTypeArg).toBe(
      'SpecialEntry',
    );
    expect(objects[`${PACKAGE}:PlainEntries`]?.extendsTypeArg).toBe(
      'ClosedEntry',
    );
  });

  it('takes the _itemClass a generic ancestor declares over the type argument a subclass passes for its parameter', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': `${OPEN_BASE('Account')}\n@smrt({ api: false })\nexport class PrivateAccount extends Account {}\n@smrt({ api: false })\nexport class AuditedAccount extends PrivateAccount {}\n`,
      'src/collections/AccountBase.ts': `${CORE}\nimport { PrivateAccount } from '../models/Account';\nexport abstract class AccountBase<T extends SmrtObject> extends SmrtCollection<T> {\n  static readonly _itemClass = PrivateAccount;\n}\n`,
      'src/collections/Accounts.ts': `${CORE}\nimport { Account, AuditedAccount } from '../models/Account';\nimport { AccountBase } from './AccountBase';\nexport class OpenAccounts extends AccountBase<Account> {}\nexport class AuditedAccounts extends AccountBase<AuditedAccount> {\n  static readonly _itemClass = AuditedAccount;\n}\n`,
    });

    expect(errors).toEqual([]);
    const objects = manifest().objects;
    expect(objects[`${PACKAGE}:OpenAccounts`]?.extendsTypeArg).toBe(
      'PrivateAccount',
    );
    // A subclass still narrows the inherited item with its own _itemClass.
    expect(objects[`${PACKAGE}:AuditedAccounts`]?.extendsTypeArg).toBe(
      'AuditedAccount',
    );
  });

  it('records the item an ancestor fixes for a subclass named after another model, with neither type argument nor _itemClass', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/models/Closed.ts': CLOSED_BASE('PrivateEntry'),
      'src/collections/ClosedEntries.ts': `${CORE}\nimport { PrivateEntry } from '../models/Closed';\nexport abstract class ClosedEntries extends SmrtCollection<PrivateEntry> {\n  static readonly _itemClass = PrivateEntry;\n}\n`,
      'src/collections/AccountCollection.ts': `${CORE}\nimport { ClosedEntries } from './ClosedEntries';\nexport class AccountCollection extends ClosedEntries {}\n`,
    });

    expect(errors).toEqual([]);
    expect(
      manifest().objects[`${PACKAGE}:AccountCollection`]?.extendsTypeArg,
    ).toBe('PrivateEntry');
  });

  it('rejects a static _itemClass that is not a model, below an ancestor that fixes the item', async () => {
    const { errors } = await scanProject({
      'src/models/Closed.ts': CLOSED_BASE('ClosedEntry'),
      'src/helpers/Plain.ts': 'export class Plain {}\n',
      'src/collections/Entries.ts': `${CORE}\nimport { ClosedEntry } from '../models/Closed';\nexport abstract class EntryCollection extends SmrtCollection<ClosedEntry> {}\n`,
      'src/collections/Wrong.ts': `${CORE}\nimport { Plain } from '../helpers/Plain';\nimport { EntryCollection } from './Entries';\nexport class WrongEntries extends EntryCollection {\n  static readonly _itemClass = Plain;\n}\n`,
    });

    expect(messages(errors)).toContain('static _itemClass');
    expect(messages(errors)).toContain('not a model');
  });

  it('rejects a collection item that is a stand-in for another package, by type argument and by _itemClass', async () => {
    const { errors } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/fixtures/Account.ts': `${CORE}\n@smrt({ packageName: '@fixture/other', api: false })\nexport class Account extends SmrtObject {\n  standInOnly = '';\n}\n`,
      'src/collections/BaseCollection.ts': GENERIC_BASE,
      'src/collections/ByArgument.ts': `${CORE}\nimport { Account } from '../fixtures/Account';\nimport { BaseCollection } from './BaseCollection';\nexport class ByArgument extends BaseCollection<Account> {}\n`,
      'src/collections/ByField.ts': `${CORE}\nimport { Account } from '../fixtures/Account';\nexport class ByField<T> extends SmrtCollection<T> {\n  static readonly _itemClass = Account;\n}\n`,
    });

    const text = messages(errors);
    expect(text).toContain('ByArgument');
    expect(text).toContain('ByField');
    expect(text).toContain('stand-in');
  });

  it('accepts a stand-in item that no model of the package shares a name with', async () => {
    const { errors } = await scanProject({
      'src/fixtures/Account.ts': `${CORE}\n@smrt({ packageName: '@fixture/other', api: false })\nexport class Account extends SmrtObject {}\nexport class Accounts extends SmrtCollection<Account> {\n  static readonly _itemClass = Account;\n}\n`,
    });

    expect(errors).toEqual([]);
  });

  it('accepts a stand-in item beside a plain helper class of the package with its name', async () => {
    const { errors } = await scanProject({
      'src/helpers/Account.ts':
        'export class Account {\n  format() {\n    return "";\n  }\n}\n',
      'src/fixtures/Account.ts': `${CORE}\n@smrt({ packageName: '@fixture/other', api: false })\nexport class Account extends SmrtObject {}\nexport class Accounts extends SmrtCollection<Account> {\n  static readonly _itemClass = Account;\n}\n`,
    });

    expect(errors).toEqual([]);
  });

  it('records no item for a generic subclass that passes its own type parameter on', async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Account.ts': OPEN_BASE('Account'),
      'src/collections/BaseCollection.ts': GENERIC_BASE,
      'src/collections/Typed.ts': `${CORE}\nimport { BaseCollection } from './BaseCollection';\nexport abstract class TypedCollection<Account extends SmrtObject> extends BaseCollection<Account> {}\n`,
    });

    expect(errors).toEqual([]);
    expect(
      manifest().objects[`${PACKAGE}:TypedCollection`]?.extendsTypeArg,
    ).toBeUndefined();
  });
});

describe('repeated scans and project roots', () => {
  it('a second scan in one process sees the barrel replaced by a direct import', async () => {
    const root = newRoot();
    write(root, {
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/index.ts': `export { Event } from './Base';\n`,
      'src/Meeting.ts': CHILD(`import { Event } from './models';`),
    });
    const scanner = new OxcScanner({ cwd: root, include: ['src/**/*.ts'] });
    const first = await scanAt(root, scanner);
    expect(first.errors).toHaveLength(1);

    write(root, {
      'src/Meeting.ts': CHILD(`import { Event } from './models/Base';`),
    });
    const second = await scanAt(root, scanner);
    expect(second.errors).toEqual([]);
    expect(
      second.resolved.filter((c) => c.className === 'Meeting'),
    ).toHaveLength(1);
    expect(fieldNames(second.model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it('a second scan in one process sees a dependency added to package.json', async () => {
    const root = newRoot([]);
    write(root, {
      'src/Meeting.ts': CHILD(`import { Event } from '${PROVIDER}';`),
    });
    const scanner = new OxcScanner({ cwd: root, include: ['src/**/*.ts'] });
    const first = await scanAt(root, scanner);
    expect(first.errors).toHaveLength(1);

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: PACKAGE, dependencies: { [PROVIDER]: '*' } }),
    );
    const second = await scanAt(root, scanner);
    expect(second.errors).toEqual([]);
  });

  it.each([
    [{ type: 'module' }],
    [{ sideEffects: false }],
    [{ type: 'module', sideEffects: ['*.css'] }],
  ])('looks past a nested package.json that only marks the module format: %j', async (marker) => {
    // The dist/esm layout: `{ "type": "module" }` or `{ "sideEffects":
    // false }` declares no package, so the package.json above it still
    // decides which packages are declared.
    const root = newRoot();
    write(root, {
      'src/esm/package.json': JSON.stringify(marker),
      'src/esm/Meeting.ts': CHILD(`import { Event } from '${PROVIDER}';`),
    });
    const { errors } = await scanAt(root);

    expect(errors).toEqual([]);
  });

  it('stops at an unnamed private project below a root that declares the package', async () => {
    // Only a module-format marker is looked past: a nested private app with
    // scripts is its own project, and declares no dependency on the provider.
    const root = newRoot();
    write(root, {
      'src/app/package.json': JSON.stringify({
        private: true,
        scripts: { dev: 'vite' },
      }),
      'src/app/Meeting.ts': CHILD(`import { Event } from '${PROVIDER}';`),
    });
    const { errors } = await scanAt(root);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(`${PROVIDER} is not declared in`);
    expect(errors[0].message).toContain(join('src', 'app', 'package.json'));
  });

  it('without projectRoot, the nearest package.json decides; none makes a package parent an error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-proof-loose-'));
    roots.push(root);
    write(root, {
      'pkg/package.json': JSON.stringify({
        name: '@fixture/nested',
        dependencies: { [PROVIDER]: '*' },
      }),
      'pkg/src/Meeting.ts': CHILD(`import { Event } from '${PROVIDER}';`),
    });
    const declared = await scanAt(
      root,
      new OxcScanner({ cwd: join(root, 'pkg'), include: ['src/**/*.ts'] }),
    );
    expect(declared.errors).toEqual([]);

    // A source file with no package.json of its own above it. Whether the
    // lookup then finds none or one above the temporary directory, neither
    // declares the fixture package, so the import is undeclared either way.
    const bare = mkdtempSync(join(tmpdir(), 'smrt-proof-bare-'));
    roots.push(bare);
    write(bare, {
      'src/Meeting.ts': CHILD(`import { Event } from '${PROVIDER}';`),
    });
    const undeclared = await scanAt(
      bare,
      new OxcScanner({ cwd: bare, include: ['src/**/*.ts'] }),
    );
    expect(undeclared.errors).toHaveLength(1);
    expect(undeclared.errors[0].message).toContain('not declared');
  });
});

// Manifest readers across the framework classify an entry by its parent's
// bare name (`extends === 'SmrtCollection'`), so a class of another package
// carrying a framework base's name is a scan error, decorated or not.
describe('framework base names', () => {
  it.each([
    [
      'an undecorated generic SmrtCollection and a model extending it',
      {
        'src/SmrtCollection.ts': `${CORE}\nexport class SmrtCollection<T> extends SmrtObject {\n  item?: T;\n}\n`,
        'src/Ledger.ts': `${CORE.replace('SmrtCollection, ', '')}\nimport { SmrtCollection } from './SmrtCollection';\n@smrt()\nexport class Ledger extends SmrtCollection<string> {}\n`,
      },
      'SmrtCollection',
    ],
    [
      'a decorated model named SmrtObject',
      {
        'src/SmrtObject.ts': `import { smrt } from '@happyvertical/smrt-core';\n@smrt()\nexport class SmrtObject {\n  title = '';\n}\n`,
      },
      'SmrtObject',
    ],
    [
      'a plain class named SmrtReport that extends nothing',
      { 'src/SmrtReport.ts': 'export class SmrtReport {}\n' },
      'SmrtReport',
    ],
  ])('fails the scan for %s', async (_label, files, name) => {
    const { errors } = await scanProject(files);
    const reserved = errors.filter((error) =>
      error.message.includes('the framework reserves this class name'),
    );

    expect(reserved).toHaveLength(1);
    expect(reserved[0].message).toContain(`${name} is the name of`);
    expect(reserved[0].message).toContain('rename it');
    expect(reserved[0].filePath).toContain(`${name}.ts`);
  });

  it('fails the scan for a model published under a framework base name by its name option', async () => {
    const { errors } = await scanProject({
      'src/InternalBase.ts': `${CORE}\n@smrt({ name: 'SmrtClass', api: false })\nexport class InternalBase extends SmrtObject {}\n`,
      'src/Fine.ts': `${CORE}\n@smrt({ name: 'Renamed' })\nexport class Fine extends SmrtObject {}\n`,
    });
    const reserved = errors.filter((error) =>
      error.message.includes('the framework reserves this class name'),
    );

    expect(reserved).toHaveLength(1);
    expect(reserved[0].message).toContain(
      'InternalBase is published under the public name SmrtClass',
    );
    expect(reserved[0].filePath).toContain('InternalBase.ts');
  });

  it('accepts the framework package declaring its own base, and a name that only starts like one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-proof-framework-'));
    roots.push(root);
    write(root, {
      'package.json': JSON.stringify({
        name: '@happyvertical/smrt-reports',
        version: '0.0.0',
        dependencies: { '@happyvertical/smrt-core': '*' },
      }),
      'src/report.ts': `${CORE}\n@smrt({ api: false })\nexport class SmrtReport extends SmrtObject {\n  title = '';\n}\n`,
      'src/view.ts': `${CORE}\n@smrt()\nexport class SmrtCollectionView extends SmrtObject {\n  label = '';\n}\n`,
    });
    const { errors, model } = await scanAt(root);

    expect(errors).toEqual([]);
    expect(model('SmrtCollectionView')).toBeDefined();
  });
});
