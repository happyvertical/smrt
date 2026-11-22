/**
 * A `@report` source keeps the identity of the value the decorator actually
 * receives: when a later property or spread replaces a class reference, the
 * earlier reference's import no longer decides the source.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OxcScanner } from '../scanner.js';

const PACKAGE = '@fixture/report-app';
const PROVIDER = '@fixture/accounts';
const CORE = `import { SmrtObject, smrt, report } from '@happyvertical/smrt-core';`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function scanReport(header: string, config: string) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-report-provenance-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: PACKAGE,
      dependencies: { [PROVIDER]: '*' },
    }),
    'src/models/Invoice.ts': `${CORE}\n@smrt()\nexport class Invoice extends SmrtObject {\n  total = 0;\n}\n`,
    'src/models/Tally.ts': `${CORE}\nimport { Account as ImportedAccount } from '${PROVIDER}';\n${header}\n@report(${config})\nexport class Tally extends SmrtObject {\n  total = 0;\n}\n`,
  };
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  const { results, resolved } = await new OxcScanner({
    cwd: root,
    include: ['src/**/*.ts'],
  }).scanAndResolve();
  const errors = results.errors.filter((e) => e.severity === 'error');
  const report = resolved.find((c) => c.className === 'Tally')?.decoratorConfig
    ?.report as Record<string, unknown> & {
    joins?: Record<string, Record<string, unknown>>;
  };
  return { errors, report };
}

const OVERRIDES = `const overrides = { source: 'Invoice' };`;

describe('report source provenance', () => {
  it('keeps the overriding source when a spread follows the class reference', async () => {
    const { errors, report } = await scanReport(
      OVERRIDES,
      `{ source: ImportedAccount, ...overrides }`,
    );

    expect(errors).toEqual([]);
    expect(report.source).toBe('Invoice');
    expect(report.sourceQualified).toBeUndefined();
    expect(report.sourceImportPath).toBeUndefined();
  });

  it('keeps the class reference when it follows the spread', async () => {
    const { errors, report } = await scanReport(
      OVERRIDES,
      `{ ...overrides, source: ImportedAccount }`,
    );

    expect(errors).toEqual([]);
    expect(report.source).toBe('Account');
    expect(report.sourceQualified).toBe(`${PROVIDER}:Account`);
  });

  it('applies both orders to joins.*.source', async () => {
    const before = await scanReport(
      `const join = { source: 'Invoice' };`,
      `{ source: 'Invoice', joins: { owners: { source: ImportedAccount, ...join, on: { id: 'id' } } } }`,
    );
    expect(before.errors).toEqual([]);
    expect(before.report.joins?.owners.source).toBe('Invoice');
    expect(before.report.joins?.owners.sourceQualified).toBeUndefined();

    const after = await scanReport(
      `const join = { source: 'Invoice' };`,
      `{ source: 'Invoice', joins: { owners: { ...join, source: ImportedAccount, on: { id: 'id' } } } }`,
    );
    expect(after.errors).toEqual([]);
    expect(after.report.joins?.owners.source).toBe('Account');
    expect(after.report.joins?.owners.sourceQualified).toBe(
      `${PROVIDER}:Account`,
    );
  });

  it('drops a source a later property replaces with a string', async () => {
    const { errors, report } = await scanReport(
      '',
      `{ source: ImportedAccount, source: 'Invoice' }`,
    );

    expect(errors).toEqual([]);
    expect(report.source).toBe('Invoice');
    expect(report.sourceQualified).toBeUndefined();
  });
});
