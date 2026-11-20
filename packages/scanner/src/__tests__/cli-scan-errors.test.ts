/**
 * `smrt-scan` writes a manifest only for a scan without errors.
 *
 * A manifest missing the values or classes a diagnostic names is not a
 * manifest of the source. The CLI reports the diagnostics, exits non-zero and
 * writes nothing: no new file, no change to a manifest already at the output
 * path, and nothing on stdout that could be piped into one.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = join(packageRoot, 'src/cli.ts');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(model: string, dependencies: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-scan-cli-'));
  roots.push(root);
  mkdirSync(join(root, 'src/models'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@fixture/scan-cli',
      version: '0.0.0',
      dependencies: Object.fromEntries(dependencies.map((d) => [d, '*'])),
    }),
  );
  writeFileSync(join(root, 'src/models/CliScanWidget.ts'), model);
  return root;
}

/** Run the CLI from source, the way `bin/smrt-scan.js` does without a build. */
function smrtScan(args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cliEntry, ...args],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const READABLE = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';
@smrt({ tableName: 'cli_scan_widgets', api: false })
export class CliScanWidget extends SmrtObject {
  name = '';
}
`;
const UNREADABLE = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { POLICY } from './policy.js';
@smrt({ tableName: 'cli_scan_widgets', api: POLICY })
export class CliScanWidget extends SmrtObject {
  name = '';
}
`;

describe('smrt-scan with scan errors', () => {
  it('writes the manifest of a scan without errors', () => {
    const root = project(READABLE);
    const output = join(root, 'manifest.json');

    const result = smrtScan([root, '-o', output]);

    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(output, 'utf8'));
    expect(
      manifest.objects['@fixture/scan-cli:CliScanWidget'].decoratorConfig,
    ).toEqual({ tableName: 'cli_scan_widgets', api: false });
  });

  it('exits non-zero, names the file, class and option, and writes no manifest', () => {
    const root = project(UNREADABLE);
    const output = join(root, 'manifest.json');

    const result = smrtScan([root, '-o', output]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(root, 'src/models/CliScanWidget.ts'));
    expect(result.stderr).toContain('POLICY');
    expect(result.stderr).toContain('class `CliScanWidget`');
    expect(result.stderr).toContain('option `api`');
    expect(result.stderr).toContain('No manifest written');
    expect(existsSync(output)).toBe(false);
  });

  it('leaves a manifest already at the output path untouched', () => {
    const root = project(UNREADABLE);
    const output = join(root, 'manifest.json');
    const previous = `${JSON.stringify({ version: '1.0.0', objects: { kept: true } })}\n`;
    writeFileSync(output, previous);

    const result = smrtScan([root, '-o', output]);

    expect(result.status).toBe(1);
    expect(readFileSync(output, 'utf8')).toBe(previous);
  });

  it('prints no manifest to stdout either', () => {
    const root = project(UNREADABLE);

    const result = smrtScan([root]);

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe('');
  });
});

describe('smrt-scan refuses what it cannot confirm', () => {
  const previous = `${JSON.stringify({ version: '1.0.0', objects: { kept: true } })}\n`;

  it.each([
    [
      'a parent that is a package default export',
      `import { smrt } from '@happyvertical/smrt-core';\nimport Agreement from '@fixture/agreements';\n@smrt()\nexport class CliScanWidget extends Agreement { name = ''; }\n`,
    ],
    [
      'a relationship target no class of the scan declares',
      `import { SmrtObject, smrt, foreignKey } from '@happyvertical/smrt-core';\n@smrt()\nexport class CliScanWidget extends SmrtObject {\n  @foreignKey('NoSuchModel') ownerId = '';\n}\n`,
    ],
  ])('exits non-zero for %s and leaves the output untouched', (_label, model) => {
    const root = project(model);
    const output = join(root, 'manifest.json');
    writeFileSync(output, previous);

    const result = smrtScan([root, '-o', output]);

    expect(result.status).toBe(1);
    expect(readFileSync(output, 'utf8')).toBe(previous);
    expect(result.stdout.trim()).toBe('');
  });

  it('refuses a literal target qualified with another package beside a local namesake', () => {
    const root = project(
      `import { SmrtObject, smrt, foreignKey } from '@happyvertical/smrt-core';\n@smrt()\nexport class Account extends SmrtObject {}\n@smrt()\nexport class CliScanWidget extends SmrtObject {\n  @foreignKey('@other/pkg:Account') ownerId = '';\n}\n`,
    );
    const output = join(root, 'manifest.json');
    writeFileSync(output, previous);

    const result = smrtScan([root, '-o', output]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '@other/pkg:Account", another package\'s export',
    );
    expect(readFileSync(output, 'utf8')).toBe(previous);
    expect(result.stdout.trim()).toBe('');
  });

  it('writes a literal target qualified with the own package', () => {
    const root = project(
      `import { SmrtObject, smrt, foreignKey } from '@happyvertical/smrt-core';\n@smrt()\nexport class Account extends SmrtObject {}\n@smrt()\nexport class CliScanWidget extends SmrtObject {\n  @foreignKey('@fixture/scan-cli:Account') ownerId = '';\n}\n`,
    );
    const output = join(root, 'manifest.json');

    const result = smrtScan([root, '-o', output]);

    expect(result.status).toBe(0);
    expect(existsSync(output)).toBe(true);
  });

  it("reports a plain local parent as a non-model chain, not another package's export", () => {
    const root = project(
      `import { smrt } from '@happyvertical/smrt-core';\nclass Helper { name = ''; }\n@smrt()\nexport class CliScanWidget extends Helper {}\n`,
    );

    const result = smrtScan([root]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CliScanWidget extends Helper');
    expect(result.stderr).toContain('not a model');
    expect(result.stderr).not.toContain("another package's export");
  });

  it("refuses a collection whose item is another package's export", () => {
    const root = project(READABLE, ['@fixture/accounts']);
    writeFileSync(
      join(root, 'src/models/CliScanAccounts.ts'),
      `import { SmrtCollection } from '@happyvertical/smrt-core';\nimport { Account } from '@fixture/accounts';\nexport class CliScanAccounts extends SmrtCollection<Account> {\n  static readonly _itemClass = Account;\n}\n`,
    );
    const output = join(root, 'manifest.json');
    writeFileSync(output, previous);

    const result = smrtScan([root, '-o', output]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "CliScanAccounts is a collection of @fixture/accounts:Account, another package's export",
    );
    expect(result.stderr).toContain('No manifest written');
    expect(readFileSync(output, 'utf8')).toBe(previous);
    expect(result.stdout.trim()).toBe('');
  });

  it('writes a collection whose item the scan declares', () => {
    const root = project(READABLE);
    writeFileSync(
      join(root, 'src/models/CliScanWidgets.ts'),
      `import { SmrtCollection } from '@happyvertical/smrt-core';\nimport { CliScanWidget } from './CliScanWidget';\nexport class CliScanWidgets extends SmrtCollection<CliScanWidget> {\n  static readonly _itemClass = CliScanWidget;\n}\n`,
    );
    const output = join(root, 'manifest.json');

    const result = smrtScan([root, '-o', output]);

    expect(result.stderr).not.toContain('Cannot confirm');
    expect(result.status).toBe(0);
    expect(existsSync(output)).toBe(true);
  });

  it('writes a manifest whose targets the scan declares', () => {
    const root = project(
      `import { SmrtObject, smrt, foreignKey } from '@happyvertical/smrt-core';\n@smrt()\nexport class CliScanWidget extends SmrtObject {\n  @foreignKey('CliScanWidget') parentId = '';\n}\n`,
    );
    const output = join(root, 'manifest.json');

    const result = smrtScan([root, '-o', output]);

    expect(result.status).toBe(0);
    expect(existsSync(output)).toBe(true);
  });
});
