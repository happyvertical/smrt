/**
 * NPM Loader — config-loading and discovery tests.
 *
 * Complements npm-loader.spec.ts (which mocks fs/fast-glob) by driving the real
 * dynamic-import + validation paths against on-disk template.config.js files in
 * a temp directory. We chdir into the temp project so resolveNpmPackage,
 * findTemplateInPackages, and discoverInstalledTemplates resolve real paths.
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverInstalledTemplates,
  findTemplateInPackages,
  loadNpmTemplate,
  resolveNpmPackage,
} from './npm-loader.js';

let tempDir: string;
let originalCwd: string;

function writeConfigModule(
  dir: string,
  config: Record<string, unknown> | string,
): string {
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'template.config.js');
  const body =
    typeof config === 'string'
      ? config
      : `export default ${JSON.stringify(config)};`;
  writeFileSync(configPath, body, 'utf-8');
  return configPath;
}

const validConfig = {
  name: 'Sample Template',
  description: 'A sample template',
  dependencies: { '@happyvertical/smrt-core': '^1.0.0' },
};

describe('npm-loader (real filesystem)', () => {
  beforeEach(() => {
    // realpathSync resolves macOS's /var -> /private/var symlink so paths
    // returned by fast-glob (which canonicalizes) match our expectations.
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-npm-loader-')));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadNpmTemplate', () => {
    it('loads a valid template.config.js from a directory', async () => {
      const dir = join(tempDir, 'pkg');
      writeConfigModule(dir, validConfig);

      const config = await loadNpmTemplate(dir);

      expect(config.name).toBe('Sample Template');
      expect(config.dependencies).toEqual({
        '@happyvertical/smrt-core': '^1.0.0',
      });
    });

    it('accepts a direct path to a template.config.js file', async () => {
      const dir = join(tempDir, 'pkg');
      const configPath = writeConfigModule(dir, validConfig);

      const config = await loadNpmTemplate(configPath);

      expect(config.description).toBe('A sample template');
    });

    it('throws when no template.config file is found in the directory', async () => {
      const dir = join(tempDir, 'empty');
      mkdirSync(dir, { recursive: true });

      await expect(loadNpmTemplate(dir)).rejects.toThrow(
        /No template\.config\.js or template\.config\.ts found/,
      );
    });

    it('throws when the config is missing a required field', async () => {
      const dir = join(tempDir, 'bad');
      writeConfigModule(dir, {
        name: 'Missing deps',
        description: 'No dependencies field',
      });

      await expect(loadNpmTemplate(dir)).rejects.toThrow(
        /missing required field 'dependencies'/,
      );
    });

    it('throws when dependencies is not an object', async () => {
      const dir = join(tempDir, 'baddeps');
      writeConfigModule(dir, {
        name: 'Bad deps type',
        description: 'deps is a string',
        dependencies: 'not-an-object',
      });

      await expect(loadNpmTemplate(dir)).rejects.toThrow(
        /'dependencies' must be an object/,
      );
    });

    it('throws when devDependencies is present but not an object', async () => {
      const dir = join(tempDir, 'baddev');
      writeConfigModule(dir, {
        ...validConfig,
        devDependencies: 'nope',
      });

      await expect(loadNpmTemplate(dir)).rejects.toThrow(
        /'devDependencies' must be an object/,
      );
    });
  });

  describe('resolveNpmPackage', () => {
    it('throws a helpful error for a non-existent package', async () => {
      await expect(
        resolveNpmPackage('definitely-not-installed-zzz'),
      ).rejects.toThrow(/not found\. Install with: npm install/);
    });

    it('resolves a package present in node_modules by directory access', async () => {
      const pkgDir = join(tempDir, 'node_modules', 'local-template-pkg');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'local-template-pkg', version: '1.0.0' }),
        'utf-8',
      );

      const resolved = await resolveNpmPackage('local-template-pkg');
      expect(resolved).toContain('local-template-pkg');
    });

    // Regression for the ESM crash (#1385): the loader used bare `require`/
    // `module` in a "type":"module" package. The fix recreates `require` via
    // createRequire and uses `require.resolve.paths(...)`. cwd is the empty
    // temp dir, so a successful resolve here must have gone through the
    // module-resolution paths (where the dependency is actually installed),
    // exercising the new `require.resolve.paths` code path rather than the
    // node_modules/<cwd> access fallback.
    it('resolves an installed dependency via require.resolve (not cwd access)', async () => {
      // `fast-glob` is a real dependency of this package but is NOT under the
      // temp project cwd, so the access() fallback cannot find it.
      const resolved = await resolveNpmPackage('fast-glob');
      expect(resolved).toContain('fast-glob');
      // The access() fallback would return `${cwd}/node_modules/...`; the
      // require.resolve path points at the real install location instead.
      expect(resolved).not.toContain(join(tempDir, 'node_modules'));
    });
  });

  describe('findTemplateInPackages', () => {
    it('finds a template under a scoped templates directory', async () => {
      const dir = join(
        tempDir,
        'node_modules',
        '@org',
        'templates',
        'my-template',
      );
      writeConfigModule(dir, validConfig);

      const result = await findTemplateInPackages('my-template');
      expect(result).toBe(dir);
    });

    it('returns null when no matching template exists', async () => {
      mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
      const result = await findTemplateInPackages('nonexistent-template');
      expect(result).toBeNull();
    });
  });

  describe('discoverInstalledTemplates', () => {
    it('discovers templates and extracts their package source', async () => {
      writeConfigModule(
        join(tempDir, 'node_modules', '@org', 'templates', 'alpha'),
        { ...validConfig, name: 'Alpha' },
      );
      writeConfigModule(join(tempDir, 'node_modules', 'beta-template'), {
        ...validConfig,
        name: 'Beta',
      });

      const templates = await discoverInstalledTemplates();
      const names = templates.map((template) => template.name).sort();

      expect(names).toContain('Alpha');
      expect(names).toContain('Beta');
      const alpha = templates.find((template) => template.name === 'Alpha');
      expect(alpha?.source).toBe('@org/templates/alpha');
    });

    it('skips templates that fail to load and returns the rest', async () => {
      writeConfigModule(join(tempDir, 'node_modules', 'good-template'), {
        ...validConfig,
        name: 'Good',
      });
      // A config module that throws on import.
      writeConfigModule(
        join(tempDir, 'node_modules', 'broken-template'),
        'throw new Error("boom");',
      );

      const templates = await discoverInstalledTemplates();
      const names = templates.map((template) => template.name);

      expect(names).toContain('Good');
      expect(names).not.toContain('broken-template');
    });

    it('returns an empty list when node_modules has no templates', async () => {
      mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
      const templates = await discoverInstalledTemplates();
      expect(templates).toEqual([]);
    });
  });
});

/**
 * Regression guard for the ESM `require`/`module` crash (#1385).
 *
 * Both npm-loader and template-loader live in a pure-ESM ("type":"module")
 * package, where the CommonJS `require`/`module` globals are undefined. The
 * shipped dist had no shim, so `smrt gnode create --template <npm-pkg>` threw
 * `ReferenceError` against the built artifact (the test suite ran through
 * Vite's transform, which silently shims `require`/`module`).
 *
 * The in-process tests above run under Vite's shim and therefore cannot observe
 * the native-ESM failure. This static check asserts the source uses
 * `createRequire(import.meta.url)` and has eliminated the bare `module.paths`
 * ESM-global reference — it fails on the exact pre-fix code.
 */
describe('loader ESM require safety (regression #1385)', () => {
  const loaderFiles = ['npm-loader.ts', 'template-loader.ts'];

  for (const file of loaderFiles) {
    it(`${file} recreates require via createRequire and avoids the bare module global`, async () => {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { dirname, join: joinPath } = await import('node:path');
      const here = dirname(fileURLToPath(import.meta.url));
      const src = readFileSync(joinPath(here, file), 'utf-8');

      // The fix: import createRequire and bind a real `require`.
      expect(src).toContain("import { createRequire } from 'node:module'");
      expect(src).toContain('createRequire(import.meta.url)');

      // The bug: spreading the undefined ESM `module` global's `.paths`.
      expect(src).not.toMatch(/\.\.\.module\.paths/);
    });
  }
});
