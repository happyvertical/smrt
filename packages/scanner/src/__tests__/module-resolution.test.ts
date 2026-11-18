/**
 * Parents, relationship targets and report sources resolve through the
 * module graph to exactly one declaration, or the scan fails. A class of the
 * same name elsewhere is never taken for the one a module names.
 *
 * Each case has a competing namesake, and the two candidates differ in what
 * they would give the model (table strategy, fields, exposure).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import { OxcScanner } from '../scanner.js';
import type { RawFieldDefinition } from '../types.js';

const PACKAGE = '@fixture/resolution-app';
const CORE = `import { SmrtObject, smrt, foreignKey, report } from '@happyvertical/smrt-core';`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function scanProject(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-resolution-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: PACKAGE, version: '0.0.0' }),
  );
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  const scanner = new OxcScanner({ cwd: root, include: ['src/**/*.ts'] });
  const { results, resolved } = await scanner.scanAndResolve();
  const errors = results.errors.filter((e) => e.severity === 'error');
  const model = (name: string) => resolved.find((c) => c.className === name);
  const manifest = () =>
    new ManifestAdapter().toManifest(resolved, { packageName: PACKAGE });
  return { errors, resolved, model, manifest };
}

/** A single-table model that closes its API: the parent a child must get. */
const CLOSED_BASE = (name: string) =>
  `${CORE}\n@smrt({ tableStrategy: 'sti', api: false })\nexport class ${name} extends SmrtObject {\n  closedOnly = '';\n}\n`;
/** An open, own-table model of the same name: the parent a child must not get. */
const OPEN_BASE = (name: string) =>
  `${CORE}\n@smrt()\nexport class ${name} extends SmrtObject {\n  openOnly = '';\n}\n`;

const fieldNames = (fields: RawFieldDefinition[] | undefined) =>
  (fields ?? []).map((field) => field.name);

describe('parents', () => {
  it('follows a path alias subpath to its one file, past a sibling namesake', async () => {
    const { errors, model } = await scanProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
      }),
      'src/models/legacy/Event.ts': CLOSED_BASE('Event'),
      'src/models/billing/Event.ts': OPEN_BASE('Event'),
      'src/models/Meeting.ts': `${CORE}\nimport { Event } from '@app/models/legacy/Event';\n@smrt()\nexport class Meeting extends Event {\n  room = '';\n}\n`,
    });

    expect(errors.filter((e) => !e.message.includes('collision'))).toEqual([]);
    const meeting = model('Meeting');
    expect(meeting?.isSTI).toBe(true);
    expect(fieldNames(meeting?.allFields)).toEqual(['closedOnly', 'room']);
    expect(meeting?.extendsResolution).toBe('local');
  });

  it('prefers the project alias over an installed package of that name', async () => {
    const { model, manifest } = await scanProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: { '@shared/models': ['./src/shared/Event.ts'] },
        },
      }),
      'node_modules/@shared/models/package.json': JSON.stringify({
        name: '@shared/models',
      }),
      'src/shared/Event.ts': CLOSED_BASE('Event'),
      'src/models/Meeting.ts': `${CORE}\nimport { Event } from '@shared/models';\n@smrt()\nexport class Meeting extends Event {\n  room = '';\n}\n`,
    });

    expect(model('Meeting')?.extendsResolution).toBe('local');
    expect(
      manifest().objects[`${PACKAGE}:Meeting`]?.extendsQualified,
    ).toBeUndefined();
  });

  it('fails for a default import named like the framework base', async () => {
    const { errors } = await scanProject({
      'src/models/Event.ts': OPEN_BASE('Event'),
      'src/models/Meeting.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport SmrtObject from '@fixture/events';\n@smrt()\nexport class Meeting extends SmrtObject {\n  room = '';\n}\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('default export of @fixture/events');
  });

  it("qualifies provider['Event'] like provider.Event", async () => {
    const { errors, manifest } = await scanProject({
      'src/models/Event.ts': OPEN_BASE('Event'),
      'src/models/Meeting.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport * as provider from '@fixture/events';\n@smrt()\nexport class Meeting extends provider['PrivateEvent'] {\n  room = '';\n}\n`,
    });

    expect(errors).toEqual([]);
    expect(manifest().objects[`${PACKAGE}:Meeting`]?.extendsQualified).toBe(
      '@fixture/events:PrivateEvent',
    );
  });

  it('follows `import { A }; export { A }` to the declaring class', async () => {
    const { errors, model } = await scanProject({
      'src/models/legacy/Event.ts': CLOSED_BASE('Event'),
      'src/models/billing/Event.ts': OPEN_BASE('Event'),
      'src/models/index.ts': `import { Event } from './legacy/Event';\nexport { Event };\n`,
      'src/models/Meeting.ts': `${CORE}\nimport { Event } from './index';\n@smrt()\nexport class Meeting extends Event {\n  room = '';\n}\n`,
    });

    expect(errors.filter((e) => !e.message.includes('collision'))).toEqual([]);
    expect(fieldNames(model('Meeting')?.allFields)).toEqual([
      'closedOnly',
      'room',
    ]);
  });

  it('fails for a parent the module does not export', async () => {
    const { errors } = await scanProject({
      'src/models/Event.ts': `${CORE}\n@smrt({ tableStrategy: 'sti' })\nclass Event extends SmrtObject {}\nexport class Other extends SmrtObject {}\n`,
      'src/models/Meeting.ts': `${CORE}\nimport { Event } from './Event';\n@smrt()\nexport class Meeting extends Event {}\n`,
    });

    expect(
      errors.some((e) => e.message.includes('Meeting extends `Event`')),
    ).toBe(true);
  });
});

describe('framework bases', () => {
  it('recognizes a base exported by the framework package that declares it', async () => {
    const { model } = await scanProject({
      'src/reports/Tally.ts': `import { SmrtReportCollection } from '@happyvertical/smrt-reports';\nexport class TallyCollection extends SmrtReportCollection {}\n`,
    });

    expect(model('TallyCollection')?.extendsResolution).toBe('framework');
  });

  it('does not take a same-named class from another package for one', async () => {
    const { model } = await scanProject({
      'src/reports/Tally.ts': `import { SmrtReportCollection } from '@fixture/not-framework';\nexport class TallyCollection extends SmrtReportCollection {}\n`,
    });

    expect(model('TallyCollection')).toBeUndefined();
  });
});

describe('relationship targets and report sources', () => {
  const ACCOUNT = `${CORE}\n@smrt()\nexport class Account extends SmrtObject {\n  name = '';\n}\n`;
  const holder = (
    imports: string,
    decorator = `@foreignKey(OwnerModel) ownerId = '';`,
  ) =>
    `${CORE}\n${imports}\n@smrt()\nexport class TargetHolder extends SmrtObject {\n  ${decorator}\n}\n`;
  const target = (resolved: Awaited<ReturnType<typeof scanProject>>) =>
    resolved.model('TargetHolder')?.fields.find((f) => f.name === 'ownerId')
      ?.decorators[0].argumentValues?.[0];

  it('takes a barrel re-export over a private namesake the barrel declares', async () => {
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/index.ts': `class OwnerModel {}\nexport { Account as OwnerModel } from './account';\nexport const keep = OwnerModel;\n`,
      'src/models/holder.ts': holder(`import { OwnerModel } from './index';`),
    });

    expect(scanned.errors).toEqual([]);
    expect(target(scanned)?.value).toBe('Account');
  });

  it('follows `import { A }; export { A }` for a target', async () => {
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/index.ts': `import { Account } from './account';\nexport { Account as OwnerModel };\n`,
      'src/models/holder.ts': holder(`import { OwnerModel } from './index';`),
    });

    expect(scanned.errors).toEqual([]);
    expect(target(scanned)?.value).toBe('Account');
  });

  it.each([
    ['an imported string constant', `export const OwnerModel = 'Account';\n`],
    [
      'a default export that is not a class',
      `export default 'Account';\nexport const x = 1;\n`,
    ],
  ])('fails on a target given as %s', async (_label, targets) => {
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/targets.ts': targets,
      'src/models/holder.ts': holder(
        _label.startsWith('a default')
          ? `import OwnerModel from './targets';`
          : `import { OwnerModel } from './targets';`,
      ),
    });

    expect(scanned.errors).toHaveLength(1);
    expect(scanned.errors[0].message).toContain('TargetHolder.ownerId');
  });

  it('resolves a default-exported class', async () => {
    const scanned = await scanProject({
      'src/models/account.ts': `${CORE}\n@smrt()\nexport default class Account extends SmrtObject {\n  name = '';\n}\n`,
      'src/models/holder.ts': holder(`import OwnerModel from './account';`),
    });

    expect(scanned.errors).toEqual([]);
    expect(target(scanned)?.value).toBe('Account');
  });

  it('keeps a package target as its package identity beside an app namesake', async () => {
    const scanned = await scanProject({
      'src/models/OwnerModel.ts': `${CORE}\n@smrt()\nexport class OwnerModel extends SmrtObject {}\n`,
      'src/models/holder.ts': holder(
        `import { OwnerModel } from '@fixture/accounts';`,
      ),
    });

    expect(scanned.errors).toEqual([]);
    const fields =
      scanned.manifest().objects[`${PACKAGE}:TargetHolder`]?.fields;
    expect(fields?.ownerId?.relatedQualified).toBe(
      '@fixture/accounts:OwnerModel',
    );
  });

  it('records a report source through a barrel, past a namesake', async () => {
    const scanned = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/OwnerModel.ts': `${CORE}\n@smrt()\nexport class OwnerModel extends SmrtObject {}\n`,
      'src/models/index.ts': `export { Account as OwnerModel } from './account';\n`,
      'src/models/Tally.ts': `${CORE}\nimport { OwnerModel } from './index';\n@report({ source: OwnerModel, joins: { owners: { source: OwnerModel, on: { id: 'id' } } } })\nexport class Tally extends SmrtObject {\n  total = 0;\n}\n`,
    });

    expect(scanned.errors).toEqual([]);
    const report = scanned.model('Tally')?.decoratorConfig?.report as {
      source: string;
      joins: { owners: { source: string } };
    };
    expect(report.source).toBe('Account');
    expect(report.joins.owners.source).toBe('Account');
  });

  it('does not stop the scan for a helper outside every model, but does once a model inherits it', async () => {
    const helper = `import { foreignKey } from '@happyvertical/smrt-core';\nimport { OwnerTarget } from './targets';\nexport class TargetHelper {\n  @foreignKey(OwnerTarget) ownerId = '';\n}\n`;
    const unused = await scanProject({
      'src/models/targets.ts': `export const OwnerTarget = 'Account';\n`,
      'src/models/helper.ts': helper,
    });
    expect(unused.errors).toEqual([]);

    const inherited = await scanProject({
      'src/models/targets.ts': `export const OwnerTarget = 'Account';\n`,
      'src/models/helper.ts': `import { SmrtObject, smrt, foreignKey } from '@happyvertical/smrt-core';\nimport { OwnerTarget } from './targets';\n@smrt({ tableStrategy: 'sti' })\nexport class TargetHelper extends SmrtObject {\n  @foreignKey(OwnerTarget) ownerId = '';\n}\n`,
      'src/models/child.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport { TargetHelper } from './helper';\n@smrt()\nexport class TargetChild extends TargetHelper {}\n`,
    });
    expect(inherited.errors.length).toBeGreaterThan(0);
  });
});

describe('class decorators reached through a computed namespace member', () => {
  it('reports the sole model decorator even when the class is not a model without it', async () => {
    const { errors } = await scanProject({
      'src/models/Vault.ts': `import * as core from '@happyvertical/smrt-core';\nimport { ExternalBase } from '@fixture/external';\nlet KEY = 'smrt';\n@(core[KEY])({ api: false })\nexport class Vault extends ExternalBase {}\n`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('core[KEY]');
    expect(errors[0].message).toContain('Vault');
  });

  it('reads a key given as a same-file string constant', async () => {
    const { errors, model } = await scanProject({
      'src/models/Vault.ts': `import * as core from '@happyvertical/smrt-core';\nconst KEY = 'smrt';\n@(core[KEY])({ api: false })\nexport class Vault extends core.SmrtObject {}\n`,
    });

    expect(errors).toEqual([]);
    expect(model('Vault')?.decoratorConfig).toMatchObject({ api: false });
  });
});
