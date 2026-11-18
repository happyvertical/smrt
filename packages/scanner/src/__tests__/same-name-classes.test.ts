/**
 * Classes are identified by the file that declares them and their name.
 *
 * Two files may declare a class of the same name. An unrelated helper never
 * takes a model's place in the scan, a class's `extends` binds to the class
 * its own module names, and two MODEL classes of one name fail the scan:
 * a manifest keys a class by `<package>:<ClassName>`, so it could hold only
 * one of them and the other would be missing with no diagnostic.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import { OxcScanner } from '../scanner.js';
import { verifyManifestCompleteness } from '../verify-completeness.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const PACKAGE = '@fixture/ledger';

async function scanProject(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-same-name-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: PACKAGE,
      version: '0.0.0',
      exports: { './manifest': './dist/manifest.json' },
    }),
  );
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  const scanner = new OxcScanner({ cwd: root, include: ['src/**/*.ts'] });
  const { results, resolved } = await scanner.scanAndResolve();
  const errors = results.errors.filter((e) => e.severity === 'error');
  const manifest = () =>
    new ManifestAdapter().toManifest(resolved, {
      packageName: PACKAGE,
      packageVersion: '0.0.0',
      typeAliases: results.typeAliases,
    });
  return { root, errors, resolved, manifest };
}

const CORE = `import { SmrtObject, SmrtCollection, smrt } from '@happyvertical/smrt-core';`;
const MODEL = `${CORE}
@smrt()
export class LedgerInvoice extends SmrtObject {
  total = 0;
}
`;
const HELPER = `export class LedgerInvoice {
  render() { return ''; }
}
`;

describe('classes that share a name across files', () => {
  it('keeps a model when a later file declares an unrelated class of its name', async () => {
    const { errors, manifest, root } = await scanProject({
      'src/models/LedgerInvoice.ts': MODEL,
      'src/pdf/LedgerInvoice.ts': HELPER,
    });

    expect(errors).toHaveLength(0);
    const objects = manifest().objects;
    expect(Object.keys(objects)).toEqual([`${PACKAGE}:LedgerInvoice`]);
    expect(objects[`${PACKAGE}:LedgerInvoice`].filePath).toBe(
      join(root, 'src/models/LedgerInvoice.ts'),
    );
    expect(Object.keys(objects[`${PACKAGE}:LedgerInvoice`].fields)).toEqual([
      'total',
    ]);
  });

  it('keeps the same model whichever file is read first', async () => {
    const before = await scanProject({
      'src/a-pdf/LedgerInvoice.ts': HELPER,
      'src/models/LedgerInvoice.ts': MODEL,
    });
    const after = await scanProject({
      'src/models/LedgerInvoice.ts': MODEL,
      'src/z-pdf/LedgerInvoice.ts': HELPER,
    });

    expect(before.errors).toHaveLength(0);
    expect(Object.keys(before.manifest().objects)).toEqual(
      Object.keys(after.manifest().objects),
    );
  });

  it('expects that model in the published manifest', async () => {
    const { root } = await scanProject({
      'src/models/LedgerInvoice.ts': MODEL,
      'src/pdf/LedgerInvoice.ts': HELPER,
    });

    const result = await verifyManifestCompleteness({ packageDir: root });

    // No manifest was built for the fixture: the guard must notice the model
    // is absent from it rather than find nothing to check.
    expect(result.status).toBe('missing-manifest');
    expect(result.missing).toEqual([`${PACKAGE}:LedgerInvoice`]);
  });

  it('allows unrelated classes to share a name', async () => {
    const { errors, manifest } = await scanProject({
      'src/pdf/LedgerRenderer.ts': `export class LedgerRenderer { render() { return 'pdf'; } }`,
      'src/csv/LedgerRenderer.ts': `export class LedgerRenderer { render() { return 'csv'; } }`,
      'src/models/LedgerInvoice.ts': MODEL,
    });

    expect(errors).toHaveLength(0);
    expect(Object.keys(manifest().objects)).toEqual([
      `${PACKAGE}:LedgerInvoice`,
    ]);
  });

  describe('two model classes of one name', () => {
    it('fails the scan and names both files', async () => {
      const { errors, root, manifest } = await scanProject({
        'src/billing/LedgerInvoice.ts': MODEL.replace(
          'total = 0;',
          `total = 0;\n  billingOnly = '';`,
        ),
        'src/sales/LedgerInvoice.ts': MODEL.replace(
          'total = 0;',
          `total = 0;\n  salesOnly = '';`,
        ),
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('Class name collision');
      expect(errors[0].message).toContain('LedgerInvoice');
      expect(errors[0].message).toContain(
        join(root, 'src/billing/LedgerInvoice.ts'),
      );
      expect(errors[0].message).toContain(
        join(root, 'src/sales/LedgerInvoice.ts'),
      );
      expect(errors[0].filePath).toBe(join(root, 'src/sales/LedgerInvoice.ts'));
      // A caller that ignores the diagnostic still gets no partial manifest.
      expect(() => manifest()).toThrow(/Class name collision/);
    });

    it('fails when one is decorated and the other only extends a framework class', async () => {
      const { errors } = await scanProject({
        'src/models/LedgerInvoice.ts': MODEL,
        'src/legacy/LedgerInvoice.ts': `${CORE}\nexport class LedgerInvoice extends SmrtObject { legacy = ''; }`,
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('Class name collision');
    });

    it('fails for two collections of one name', async () => {
      const { errors } = await scanProject({
        'src/models/LedgerInvoice.ts': MODEL,
        'src/billing/LedgerInvoices.ts': `${CORE}\nimport { LedgerInvoice } from '../models/LedgerInvoice.js';\nexport class LedgerInvoices extends SmrtCollection<LedgerInvoice> {}`,
        'src/sales/LedgerInvoices.ts': `${CORE}\nimport { LedgerInvoice } from '../models/LedgerInvoice.js';\nexport class LedgerInvoices extends SmrtCollection<LedgerInvoice> {}`,
      });

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('LedgerInvoices');
    });

    it('verifyManifestCompleteness reports the collision as a scan error', async () => {
      const { root } = await scanProject({
        'src/billing/LedgerInvoice.ts': MODEL,
        'src/sales/LedgerInvoice.ts': MODEL,
      });

      const result = await verifyManifestCompleteness({ packageDir: root });

      expect(result.status).toBe('scan-error');
      expect(result.reason).toContain('Class name collision');
    });
  });
});

describe('a class that declares another package', () => {
  // An app-side replacement of a package model, as a test fixture writes it:
  // the same class name, declared for the app's package.
  const STAND_IN = `import { smrt } from '@happyvertical/smrt-core';
import { LedgerInvoice as BaseLedgerInvoice } from '../models/LedgerInvoice.js';
@smrt({ packageName: '@fixture/ledger-app', tableName: 'ledger_invoices' })
export class LedgerInvoice extends BaseLedgerInvoice {
  appOnly = '';
}
`;

  it('does not collide with the scanned package own class of that name', async () => {
    const { errors, manifest, root } = await scanProject({
      'src/__tests__/app.fixture.ts': STAND_IN,
      'src/models/LedgerInvoice.ts': MODEL,
    });

    expect(errors).toHaveLength(0);
    const objects = manifest().objects;
    expect(Object.keys(objects)).toEqual([`${PACKAGE}:LedgerInvoice`]);
    // The package's own class is the entry, not the stand-in.
    expect(objects[`${PACKAGE}:LedgerInvoice`].filePath).toBe(
      join(root, 'src/models/LedgerInvoice.ts'),
    );
    expect(objects[`${PACKAGE}:LedgerInvoice`].fields.appOnly).toBeUndefined();
  });

  it('gives the same entry when the stand-in is read last', async () => {
    const { errors, manifest, root } = await scanProject({
      'src/models/LedgerInvoice.ts': MODEL,
      'src/z-app/app.fixture.ts': STAND_IN.replace(
        '../models/LedgerInvoice.js',
        '../models/LedgerInvoice.js',
      ),
    });

    expect(errors).toHaveLength(0);
    expect(manifest().objects[`${PACKAGE}:LedgerInvoice`].filePath).toBe(
      join(root, 'src/models/LedgerInvoice.ts'),
    );
  });

  it('still fails for two classes that declare the same package', async () => {
    const declared = (field: string) =>
      `${CORE}\n@smrt({ packageName: '@fixture/ledger-app' })\nexport class LedgerInvoice extends SmrtObject { ${field} = ''; }`;
    const { errors } = await scanProject({
      'src/a/LedgerInvoice.ts': declared('first'),
      'src/b/LedgerInvoice.ts': declared('second'),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Class name collision');
  });

  it('refuses a manifest for two stand-ins of different packages under one name', async () => {
    const standIn = (packageName: string) =>
      `${CORE}\n@smrt({ packageName: '${packageName}' })\nexport class LedgerInvoice extends SmrtObject { total = 0; }`;
    const { manifest } = await scanProject({
      'src/a/LedgerInvoice.ts': standIn('@fixture/ledger-app'),
      'src/b/LedgerInvoice.ts': standIn('@fixture/ledger-upstream'),
    });

    // Neither is this package's class and one key cannot hold both.
    expect(() => manifest()).toThrow(/Class name collision/);
  });
});

describe('a parent is the class the declaring module names', () => {
  const STI_BASE = `${CORE}
@smrt({ tableStrategy: 'sti', tableName: 'ledger_entries' })
export class LedgerEntry extends SmrtObject {
  amount = 0;
}
`;
  const PLAIN_BASE = `export class LedgerEntry {
  helperOnly = '';
}
`;

  function childOf(
    resolved: Awaited<ReturnType<typeof scanProject>>['resolved'],
    name: string,
  ) {
    return resolved.find((entry) => entry.className === name);
  }

  it('binds a relative import to the file it points at', async () => {
    const { errors, resolved } = await scanProject({
      'src/billing/LedgerEntry.ts': STI_BASE,
      'src/pdf/LedgerEntry.ts': PLAIN_BASE,
      'src/billing/LedgerCharge.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport { LedgerEntry } from './LedgerEntry.js';\n@smrt()\nexport class LedgerCharge extends LedgerEntry { fee = 0; }`,
      'src/pdf/LedgerPage.ts': `import { LedgerEntry } from './LedgerEntry.js';\nexport class LedgerPage extends LedgerEntry { page = 1; }`,
    });

    expect(errors).toHaveLength(0);
    const charge = childOf(resolved, 'LedgerCharge');
    expect(charge?.isSTI).toBe(true);
    expect(charge?.stiBase).toBe('LedgerEntry');
    expect(charge?.allFields.map((field) => field.name)).toEqual([
      'amount',
      'fee',
    ]);
    // The helper's subclass extends the helper, so it is not a model.
    expect(childOf(resolved, 'LedgerPage')).toBeUndefined();
  });

  it('binds an unimported parent to the class in the same file', async () => {
    const { errors, resolved } = await scanProject({
      'src/billing/LedgerEntry.ts': STI_BASE,
      'src/pdf/pages.ts': `${PLAIN_BASE}\nexport class LedgerPage extends LedgerEntry { page = 1; }`,
    });

    expect(errors).toHaveLength(0);
    expect(resolved.map((entry) => entry.className)).toEqual(['LedgerEntry']);
  });

  it('follows a barrel to the declaring file', async () => {
    const { errors, resolved } = await scanProject({
      'src/billing/LedgerEntry.ts': STI_BASE,
      'src/pdf/LedgerEntry.ts': PLAIN_BASE,
      'src/billing/index.ts': `export * from './LedgerEntry.js';`,
      'src/pdf/index.ts': `export { LedgerEntry as PdfEntry } from './LedgerEntry.js';`,
      'src/reports/LedgerCharge.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport { LedgerEntry } from '../billing/index.js';\n@smrt()\nexport class LedgerCharge extends LedgerEntry { fee = 0; }`,
      'src/reports/LedgerPage.ts': `import { PdfEntry } from '../pdf';\nexport class LedgerPage extends PdfEntry { page = 1; }`,
    });

    expect(errors).toHaveLength(0);
    expect(childOf(resolved, 'LedgerCharge')?.isSTI).toBe(true);
    expect(childOf(resolved, 'LedgerPage')).toBeUndefined();
  });

  it('follows a tsconfig path alias to the file it maps to', async () => {
    // `$lib/billing/LedgerEntry` is the STI base, whatever else shares its
    // name: the alias names one file.
    const { errors, resolved } = await scanProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '$lib/*': ['src/*'] } },
      }),
      'src/billing/LedgerEntry.ts': STI_BASE,
      'src/z-pdf/LedgerEntry.ts': PLAIN_BASE,
      'src/reports/LedgerCharge.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport { LedgerEntry } from '$lib/billing/LedgerEntry';\n@smrt()\nexport class LedgerCharge extends LedgerEntry { fee = 0; }`,
    });

    expect(errors).toHaveLength(0);
    const charge = childOf(resolved, 'LedgerCharge');
    expect(charge?.isSTI).toBe(true);
    expect(charge?.allFields.map((field) => field.name)).toEqual([
      'amount',
      'fee',
    ]);
  });

  it('fails when an import cannot be followed, never matching a name', async () => {
    // No tsconfig maps `$lib`: the import names no module the scan can read,
    // so neither same-named class is taken for the parent.
    const { errors } = await scanProject({
      'src/billing/LedgerEntry.ts': STI_BASE,
      'src/z-pdf/LedgerEntry.ts': PLAIN_BASE,
      'src/reports/LedgerCharge.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport { LedgerEntry } from '$lib/billing/LedgerEntry';\n@smrt()\nexport class LedgerCharge extends LedgerEntry { fee = 0; }`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('LedgerCharge extends `LedgerEntry`');
  });

  it('keeps an undecorated subclass of a model in the scan beside a same-named helper', async () => {
    const { errors, resolved } = await scanProject({
      'src/billing/LedgerEntry.ts': `${CORE}\nexport abstract class LedgerEntry extends SmrtObject { amount = 0; }`,
      'src/z-pdf/LedgerEntry.ts': PLAIN_BASE,
      'src/billing/LedgerCharge.ts': `import { LedgerEntry } from './LedgerEntry.js';\nexport class LedgerCharge extends LedgerEntry { fee = 0; }`,
    });

    expect(errors).toHaveLength(0);
    expect(resolved.map((entry) => entry.className).sort()).toEqual([
      'LedgerCharge',
      'LedgerEntry',
    ]);
    expect(childOf(resolved, 'LedgerCharge')?.inheritanceChain).toEqual([
      'SmrtObject',
      'LedgerEntry',
      'LedgerCharge',
    ]);
  });
});
