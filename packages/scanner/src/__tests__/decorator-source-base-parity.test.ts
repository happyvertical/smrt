/**
 * Which decorator the scanner reads as SMRT's is the base scanner's rule: a
 * field decorator by its local identifier, a class or method decorator also
 * through a renamed import, and never a namespace member. A field keeps the
 * options of the SMRT decorator it carries beside another library's.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import { OxcScanner } from '../scanner.js';

const PACKAGE = '@fixture/decorator-source';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function apiSecret(prelude: string, decorators: string) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-decorator-source-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: PACKAGE,
      version: '0.0.0',
      dependencies: { '@happyvertical/smrt-core': '*', 'forms-lib': '*' },
    }),
    'src/models/Account.ts': `import { SmrtObject, smrt, field } from '@happyvertical/smrt-core';\n${prelude}\n@smrt()\nexport class Account extends SmrtObject {\n  ${decorators}\n  apiSecret: string = '';\n}\n`,
  };
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  const { results, resolved } = await new OxcScanner({
    cwd: root,
    include: ['src/**/*.ts'],
  }).scanAndResolve();
  const manifest = new ManifestAdapter().toManifest(resolved, {
    packageName: PACKAGE,
  });
  const account = Object.values(manifest.objects).find(
    (entry) => entry.className === 'Account',
  );
  return {
    errors: results.errors.filter((error) => error.severity === 'error'),
    sensitive: account?.fields.apiSecret?.sensitive,
  };
}

describe('decorator source recognition, as the base scanner reads it', () => {
  it('reads an SMRT field decorator imported by its own name', async () => {
    const { errors, sensitive } = await apiSecret(
      '',
      '@field({ sensitive: true })',
    );
    expect(errors).toEqual([]);
    expect(sensitive).toBe(true);
  });

  it("does not read another library's field decorator imported under an alias", async () => {
    const { errors, sensitive } = await apiSecret(
      "import { field as formField } from 'forms-lib';",
      '@field({ sensitive: true })\n  @formField({ sensitive: false })',
    );
    expect(errors).toEqual([]);
    expect(sensitive).toBe(true);
  });

  it("does not read another library's namespaced field decorator", async () => {
    const { errors, sensitive } = await apiSecret(
      "import * as forms from 'forms-lib';",
      '@field({ sensitive: true })\n  @forms.field({ sensitive: false })',
    );
    expect(errors).toEqual([]);
    expect(sensitive).toBe(true);
  });

  it("neither reads nor fails on another library's decorator under a computed constant key", async () => {
    const { errors, sensitive } = await apiSecret(
      "import * as forms from 'forms-lib';\nconst KEY = 'field';",
      '@field({ sensitive: true })\n  @(forms[KEY])({ sensitive: false })',
    );
    expect(errors).toEqual([]);
    expect(sensitive).toBe(true);
  });
});
