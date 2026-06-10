import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OxcScanner, scanDirectory } from '../scanner.js';

/**
 * Public-API coverage for OxcScanner: the two-phase guards, cross-package import
 * discovery, external-manifest registration, statistics, and the scanDirectory
 * convenience wrapper.
 */
describe('OxcScanner API', () => {
  let dir: string;

  function write(rel: string, source: string): void {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, source);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-scanner-api-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when resolve() runs before scan()', () => {
    const scanner = new OxcScanner({ cwd: dir });
    expect(() => scanner.resolve()).toThrow(/scan\(\) before resolve\(\)/);
  });

  it('throws when scanSmrtImports() runs before scan()', () => {
    const scanner = new OxcScanner({ cwd: dir });
    expect(() => scanner.scanSmrtImports()).toThrow(
      /scan\(\) before scanSmrtImports\(\)/,
    );
  });

  it('discovers and merges @happyvertical/smrt-* imports across files', async () => {
    write(
      'src/a.ts',
      `import { Person } from '@happyvertical/smrt-profiles';\nexport const a = Person;\n`,
    );
    write(
      'src/b.ts',
      `import { Organization } from '@happyvertical/smrt-profiles';\nexport const b = Organization;\n`,
    );
    const scanner = new OxcScanner({ cwd: dir, include: ['src/**/*.ts'] });
    await scanner.scan();

    const imports = scanner.scanSmrtImports();
    const profiles = imports.get('@happyvertical/smrt-profiles');
    expect(profiles).toBeDefined();
    expect(profiles?.has('Person')).toBe(true);
    expect(profiles?.has('Organization')).toBe(true);
  });

  it('reports per-scan statistics', async () => {
    write(
      'src/widget.ts',
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';\n@smrt()\nexport class Widget extends SmrtObject { name = ''; }\n`,
    );
    const scanner = new OxcScanner({ cwd: dir, include: ['src/**/*.ts'] });
    await scanner.scan();

    const stats = scanner.getStats();
    expect(stats.fileCount).toBeGreaterThanOrEqual(1);
    expect(stats.smrtClasses).toBeGreaterThanOrEqual(1);
    expect(stats.parseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('registers an external manifest for cross-package base resolution', async () => {
    write(
      'src/special.ts',
      `@smrt()\nexport class Special extends BasePerson { nickname = ''; }\n`,
    );
    const scanner = new OxcScanner({ cwd: dir, include: ['src/**/*.ts'] });
    scanner.addExternalManifest({
      packageName: '@happyvertical/smrt-profiles',
      packageVersion: '1.0.0',
      classes: new Map([
        [
          'BasePerson',
          {
            className: 'BasePerson',
            filePath: '',
            extendsClause: null,
            extendsTypeArg: null,
            decoratorConfig: null,
            hasSmartDecorator: true,
            fields: [],
            methods: [],
            startLine: 0,
            endLine: 0,
          },
        ],
      ]),
    });

    const { resolved } = await scanner.scanAndResolve();
    const special = resolved.find((c) => c.className === 'Special');
    expect(special).toBeDefined();
    expect(special?.inheritanceChain).toContain('BasePerson');
  });

  it('surfaces parse errors from scanned files', async () => {
    write(
      'src/broken.ts',
      `@smrt()\nclass Broken extends SmrtObject {\n  name: string = // missing value\n}\n`,
    );
    const scanner = new OxcScanner({ cwd: dir, include: ['src/**/*.ts'] });
    const results = await scanner.scan();
    expect(results.errors.length).toBeGreaterThan(0);
  });

  it('scanDirectory() runs both phases against a directory', async () => {
    write(
      'src/widget.ts',
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';\n@smrt()\nexport class Widget extends SmrtObject { name = ''; }\n`,
    );
    const { results, resolved } = await scanDirectory(dir, {
      include: ['src/**/*.ts'],
    });
    expect(results.errors).toEqual([]);
    expect(resolved.some((c) => c.className === 'Widget')).toBe(true);
  });
});
