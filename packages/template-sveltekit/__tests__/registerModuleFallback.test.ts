/**
 * The generated-registration fallback in `src/lib/server/smrt.ts` (#3369
 * PR review). Only an absent generated register module may be skipped (a
 * fresh checkout before the first build); a missing dependency imported by an
 * existing generated module, or any other failure, must still fail startup.
 *
 * The predicate is evaluated from the template source itself (as shipped)
 * against real errors: Node's own import failures, and Vite's module runner
 * (this test runner) for the absent module.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'template/src/lib/server/smrt.ts'),
  'utf8',
);

/** The shipped `isMissingRegisterModule`, compiled from the template source. */
const isMissingRegisterModule = (() => {
  const start = source.indexOf('function isMissingRegisterModule(');
  const end = source.indexOf('\n}\n', start);
  if (start < 0) throw new Error('isMissingRegisterModule not found');
  const js = ts.transpile(source.slice(start, end + 2), {
    target: ts.ScriptTarget.ES2022,
  });
  return runInNewContext(`${js}\nisMissingRegisterModule`) as (
    error: unknown,
  ) => boolean;
})();

async function importError(specifier: string): Promise<unknown> {
  try {
    await import(/* @vite-ignore */ specifier);
  } catch (error) {
    return error;
  }
  throw new Error(`Expected ${specifier} to fail`);
}

async function inTemporaryServerDirectory(
  fn: (directory: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'smrt-register-'));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('smrt.ts generated-registration fallback', () => {
  it('rethrows unless the fallback predicate matches', () => {
    expect(source).toMatch(
      /await import\('\.\/smrt-register\.js'\);\n\} catch \(error\) \{[\s\S]*?if \(!isMissingRegisterModule\(error\)\) throw error;\n\}/,
    );
    expect(source).not.toContain("message.includes('smrt-register.js')");
  });

  it('skips only the absent generated register module', async () => {
    // Vite's module runner (this test runner), as in `pnpm dev`.
    const viteError = await importError(
      '../template/src/lib/server/smrt-register.js',
    );
    expect(isMissingRegisterModule(viteError)).toBe(true);

    // Node, as for a built server importing a missing module file.
    await inTemporaryServerDirectory(async (root) => {
      const nodeError = await importError(
        pathToFileURL(join(root, 'src/lib/server/smrt-register.js')).href,
      );
      expect((nodeError as { code?: string }).code).toBe(
        'ERR_MODULE_NOT_FOUND',
      );
      expect(isMissingRegisterModule(nodeError)).toBe(true);
    });
  });

  it('fails startup when an existing register module is missing a dependency', async () => {
    await inTemporaryServerDirectory(async (root) => {
      const register = join(root, 'smrt-register.js');
      writeFileSync(
        register,
        "import '@happyvertical/smrt-missing-extension-for-test';\nimport './missing-sibling.js';\n",
      );
      // Missing package, reported as imported FROM smrt-register.js.
      const packageError = await importError(pathToFileURL(register).href);
      expect((packageError as { code?: string }).code).toBe(
        'ERR_MODULE_NOT_FOUND',
      );
      expect(String((packageError as Error).message)).toContain(
        'smrt-register.js',
      );
      expect(isMissingRegisterModule(packageError)).toBe(false);

      // Missing file imported by the generated module.
      writeFileSync(register, "import './missing-sibling.js';\n");
      const fileError = await importError(
        `${pathToFileURL(register).href}?file`,
      );
      expect(isMissingRegisterModule(fileError)).toBe(false);
    });
  });

  it('fails startup for any other error, even one naming the register module', () => {
    expect(
      isMissingRegisterModule(
        new Error('registration failed in smrt-register.js'),
      ),
    ).toBe(false);
    expect(isMissingRegisterModule(undefined)).toBe(false);
  });
});
