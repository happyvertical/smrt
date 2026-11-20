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

  it('selects the file TypeScript selects, and fails when it is outside the scan', async () => {
    // `./Base` names `Base.ts` before `Base/index.ts`; the scan reads only
    // the directory index, so it must not stand in for the excluded file.
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
    expect(errors[0].message).toContain(join('src/models/Base.ts'));
    expect(errors[0].message).toContain('add the file to the scan include');
    expect(fieldNames(model('Meeting')?.allFields)).not.toContain('openOnly');
  });

  it('applies the project moduleSuffixes in their order', async () => {
    const { errors, model } = await scanProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { moduleSuffixes: ['.ios', ''] },
      }),
      'src/models/Base.ios.ts': CLOSED_BASE('Event'),
      'src/models/Base.ts': OPEN_BASE('Event').replace(
        'class Event',
        'class OpenEvent',
      ),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });

    expect(errors).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it('tries every module suffix within one extension before the next extension', async () => {
    // TypeScript's order for `./Base` with ['.ios', '']: Base.ios.ts,
    // Base.ts, Base.ios.tsx, Base.tsx, ... so `Base.ts` decides.
    const root = newRoot();
    write(root, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { moduleSuffixes: ['.ios', ''] },
      }),
      'src/models/Base.ts': CLOSED_BASE('Event'),
      // Another name: two models named `Event` in one scan collide.
      'src/models/Base.ios.tsx': OPEN_BASE('Event').replace(
        'class Event',
        'class OpenEvent',
      ),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });
    const scanner = new OxcScanner({
      cwd: root,
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    });
    const { errors, model } = await scanAt(root, scanner);

    expect(errors).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it('fails when the suffixed file TypeScript selects is outside the scan', async () => {
    const root = newRoot();
    write(root, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { moduleSuffixes: ['.ios', ''] },
      }),
      'src/models/Base.ts': CLOSED_BASE('Event'),
      'src/models/Base.ios.tsx': OPEN_BASE('Event'),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base';`),
    });
    const scanner = new OxcScanner({
      cwd: root,
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/models/Base.ts'],
    });
    const { errors, model } = await scanAt(root, scanner);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(join('src/models/Base.ts'));
    expect(errors[0].message).toContain('add the file to the scan include');
    expect(fieldNames(model('Meeting')?.allFields)).not.toContain('openOnly');
  });

  it('applies module suffixes to an explicit .js extension in the same order', async () => {
    const root = newRoot();
    write(root, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { moduleSuffixes: ['.ios', ''] },
      }),
      'src/models/Base.ts': OPEN_BASE('Event').replace(
        'class Event',
        'class OpenEvent',
      ),
      'src/models/Base.ios.ts': CLOSED_BASE('Event'),
      'src/models/Meeting.ts': CHILD(`import { Event } from './Base.js';`),
    });
    const { errors, model } = await scanAt(root);

    expect(errors).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
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

  it('rejects a static _itemClass that names another class than the type argument', async () => {
    const { errors } = await scanProject({
      'src/models/Account.ts': `${CORE}\n@smrt()\nexport class Account extends SmrtObject {}\n@smrt()\nexport class Ledger extends SmrtObject {}\n`,
      'src/models/Accounts.ts': `${CORE}\nimport { Account, Ledger } from './Account';\nexport class AccountCollection extends SmrtCollection<Account> {\n  static readonly _itemClass = Ledger;\n}\n`,
    });

    expect(messages(errors)).toContain('static _itemClass');
  });

  it('rejects an item that is a plain class', async () => {
    const { errors } = await scanProject({
      'src/models/Account.ts': `export class Account {}\n`,
      'src/models/Accounts.ts': `${CORE}\nimport { Account } from './Account';\nexport class AccountCollection extends SmrtCollection<Account> {}\n`,
    });

    expect(messages(errors)).toContain('is not a model');
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

    // A source file with no package.json above it within the tree.
    const bare = mkdtempSync(join('/dev/shm', 'smrt-proof-bare-'));
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
