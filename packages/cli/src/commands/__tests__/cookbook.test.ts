import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cookbook } from '@happyvertical/smrt-types';
import { create } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCookbook, nextSteps } from '../cookbook/apply.js';
import {
  createRecipeIndex,
  loadManifestPath,
  loadRegistryManifest,
  manifestPathForPackageDir,
  registryForPackage,
  resolveRecipeIndex,
} from '../cookbook/recipe-index.js';
import {
  parseForResolution,
  validateCookbookText,
} from '../cookbook/validate.js';
import { cookbookCommands } from '../cookbook.js';

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../core/src/cookbook/__fixtures__',
);
const FIXTURES = ['bakery', 'mechanic', 'welder', 'yoga-studio'] as const;

const readFixture = (name: string) =>
  readFileSync(join(fixtureDir, `${name}.cookbook.json`), 'utf-8');

let work: string;
let manifests: string;
let template: string;

/** Package that owns each recipe prefix in the stub manifests. */
const PACKAGE_FOR: Record<string, string> = {
  commerce: '@happyvertical/smrt-commerce',
  inventory: '@happyvertical/smrt-inventory',
  ledgers: '@happyvertical/smrt-ledgers',
  products: '@happyvertical/smrt-products',
  events: '@happyvertical/smrt-events',
};

/**
 * Stub manifests built from the fixture cookbooks themselves, so the tests
 * are hermetic: every recipe id and policy target they mention exists, and
 * `commerce.invoicing` requires `commerce.customers`.
 */
function writeStubManifests(dir: string) {
  const byPackage = new Map<
    string,
    { recipes: Set<string>; fields: Map<string, Set<string>> }
  >();
  const entry = (pkg: string) => {
    let value = byPackage.get(pkg);
    if (!value) {
      value = { recipes: new Set(), fields: new Map() };
      byPackage.set(pkg, value);
    }
    return value;
  };
  for (const name of FIXTURES) {
    const cookbook = JSON.parse(readFixture(name));
    for (const id of cookbook.recipes as string[]) {
      entry(PACKAGE_FOR[id.split('.')[0]]).recipes.add(id);
    }
    for (const ref of [
      ...cookbook.features,
      ...cookbook.policies.map((p: { objectRef: string }) => p.objectRef),
    ] as string[]) {
      const [pkg] = ref.split(':');
      entry(pkg).fields.set(ref, new Set());
    }
    for (const p of cookbook.policies as {
      objectRef: string;
      fieldName: string;
    }[]) {
      entry(p.objectRef.split(':')[0])
        .fields.get(p.objectRef)
        ?.add(p.fieldName);
    }
  }
  mkdirSync(dir, { recursive: true });
  for (const [pkg, value] of byPackage) {
    writeFileSync(
      join(dir, `${pkg.replace(/[@/]/g, '_')}.json`),
      JSON.stringify({
        packageName: pkg,
        packageVersion: '0.55.10',
        objects: Object.fromEntries(
          [...value.fields].map(([ref, fields]) => [
            ref,
            { fields: Object.fromEntries([...fields].map((f) => [f, {}])) },
          ]),
        ),
        recipes: [...value.recipes].map((id) => ({
          id,
          requires: id === 'commerce.invoicing' ? ['commerce.customers'] : [],
          requiresAny:
            id === 'commerce.estimates'
              ? [['commerce.sales', 'commerce.customers']]
              : [],
          models: [],
          options: id === 'products.simple' ? { Product: {} } : undefined,
          demoSeed: id === 'inventory.stock' ? { data: [] } : undefined,
        })),
      }),
    );
  }
}

function writeTemplate(dir: string) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: '@smrt-app/start',
        version: '0.0.1',
        scripts: {
          'app:setup': 'smrt app setup',
          'app:doctor': 'smrt app doctor',
        },
        dependencies: {
          '@happyvertical/smrt-core': '^0.55.1',
          '@happyvertical/smrt-users': '^0.55.1',
        },
      },
      null,
      2,
    )}\n`,
  );
}

const doc = (extra: Record<string, unknown>) =>
  JSON.stringify({ version: 1, features: [], policies: [], ...extra });

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf-8'));

/** Validate against the real workspace manifests (built locally). */
async function validateReal(text: string) {
  const index = await resolveRecipeIndex(parseForResolution(text), {
    dir: dirname(fileURLToPath(import.meta.url)),
    registry: false,
  });
  return validateCookbookText(text, index);
}

/** Validate against stub manifests, for error cases. */
async function validate(text: string) {
  const index = await resolveRecipeIndex(parseForResolution(text), {
    dir: work,
    manifests: [manifests],
    registry: false,
  });
  return validateCookbookText(text, index);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'cookbook-test-'));
  manifests = join(work, 'manifests');
  template = join(work, 'template');
  writeStubManifests(manifests);
  writeTemplate(template);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cookbook validate', () => {
  it.each(
    FIXTURES,
  )('accepts the %s cookbook (real manifests)', async (name) => {
    const report = await validateReal(readFixture(name));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.packages).toContain('@happyvertical/smrt-commerce');
    expect(report.packages).toContain('@happyvertical/smrt-products');
  });

  it('rejects an unknown recipe', async () => {
    const text = doc({ recipes: ['nope.thing'] });
    const report = await validate(text);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toContain('recipe "nope.thing" does not exist');
  });

  it('rejects a missing requires and an unmet requiresAny', async () => {
    const report = await validate(doc({ recipes: ['commerce.invoicing'] }));
    expect(report.errors).toEqual([
      'recipe "commerce.invoicing" requires "commerce.customers", which is missing',
    ]);
    const index = createRecipeIndex();
    loadManifestPath(index, manifests);
    index.recipes.set('x.any', {
      id: 'x.any',
      packageName: 'p',
      requires: [],
      requiresAny: [['commerce.sales', 'commerce.vendors']],
      models: [],
      hasOptions: false,
      hasDemoSeed: false,
    });
    const any = validateCookbookText(doc({ recipes: ['x.any'] }), index);
    expect(any.errors[0]).toContain('requires one of');
  });

  it('rejects unknown policy and feature targets', async () => {
    const bad = doc({
      recipes: ['commerce.customers'],
      features: ['@happyvertical/smrt-commerce:Ghost'],
      policies: [
        {
          objectRef: '@happyvertical/smrt-commerce:Customer',
          fieldName: 'nonexistent',
          scopeType: 'app',
        },
      ],
    });
    const report = await validate(bad);
    expect(report.errors.some((e) => e.includes('Ghost'))).toBe(true);
    expect(report.errors.some((e) => e.includes('"nonexistent"'))).toBe(true);
  });

  it('reports structural errors', async () => {
    expect((await validate('not json')).errors).toEqual(['not valid JSON']);
    expect((await validate('{"version": 2}')).ok).toBe(false);
  });

  it('exits non-zero with --json output on failure', async () => {
    const file = join(work, 'bad.json');
    writeFileSync(file, doc({ recipes: ['nope.x'] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(
      cookbookCommands['cookbook validate'].handler?.([file], {
        json: true,
        manifests: [manifests],
        'no-registry': true,
      }),
    ).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    const printed = JSON.parse(log.mock.calls[0][0] as string);
    expect(printed.ok).toBe(false);
    expect(printed.errors[0]).toContain('nope.x');
  });
});

describe('cookbook apply', () => {
  async function apply(
    name: string,
    dir: string,
    extra: Partial<Parameters<typeof applyCookbook>[0]> = {},
  ) {
    const report = await validateReal(readFixture(name));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    return {
      report,
      result: applyCookbook({
        cookbook: report.cookbook as Cookbook,
        packages: report.packages,
        dir,
        template,
        install: false,
        cliVersion: '9.9.9',
        cwd: work,
        ...extra,
      }),
    };
  }

  it.each(FIXTURES)('creates a project from the %s cookbook', async (name) => {
    const dir = join(work, `out-${name}`);
    const { report, result } = await apply(name, dir);
    expect(result.plan.mode).toBe('new');
    const pkg = readJson(join(dir, 'package.json'));
    for (const dep of report.packages) {
      expect(pkg.dependencies[dep]).toBeDefined();
    }
    // The template's framework line, not the CLI version.
    expect(pkg.dependencies['@happyvertical/smrt-commerce']).toBe('^0.55.1');
    // Existing dependencies untouched, deps sorted.
    expect(pkg.dependencies['@happyvertical/smrt-users']).toBe('^0.55.1');
    expect(Object.keys(pkg.dependencies)).toEqual(
      [...Object.keys(pkg.dependencies)].sort((a, b) => a.localeCompare(b)),
    );
    // Named from the directory, never the template's shared identity.
    expect(pkg.name).toBe(`out-${name}`);
    expect(readJson(join(dir, 'smrt.cookbook.json'))).toEqual(report.cookbook);
    // Template files copied, .git left behind.
    expect(existsSync(join(dir, 'src', 'app.ts'))).toBe(true);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(result.nextSteps.join(' ')).toContain('pnpm install');
    expect(result.nextSteps.join(' ')).toContain('pnpm app:setup');
    expect(result.nextSteps.join(' ')).toContain('pnpm app:doctor');
  });

  it('names the project from cookbook.name', async () => {
    const dir = join(work, 'named');
    const text = doc({
      name: 'Sourdough & Co',
      recipes: ['commerce.customers'],
    });
    const report = await validate(text);
    expect(report.ok).toBe(true);
    applyCookbook({
      cookbook: report.cookbook as Cookbook,
      packages: report.packages,
      dir,
      template,
      install: false,
      cliVersion: '9.9.9',
      cwd: work,
    });
    expect(readJson(join(dir, 'package.json')).name).toBe('sourdough-co');
  });

  it('names the project from the target directory when the cookbook has no name', async () => {
    const cases: Array<[string, string]> = [
      ['My Cool_App!', 'my-cool-app'],
      ['___', 'smrt-app'],
    ];
    for (const [dirName, expected] of cases) {
      const dir = join(work, dirName);
      const report = await validate(doc({ recipes: ['commerce.customers'] }));
      applyCookbook({
        cookbook: report.cookbook as Cookbook,
        packages: report.packages,
        dir,
        template,
        install: false,
        cliVersion: '9.9.9',
        cwd: work,
      });
      const name = readJson(join(dir, 'package.json')).name;
      expect(name).toBe(expected);
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('is idempotent and preserves user edits when re-applying an edited cookbook', async () => {
    const dir = join(work, 'idem');
    await apply('yoga-studio', dir);
    const before = readFileSync(join(dir, 'package.json'), 'utf-8');

    const again = await apply('yoga-studio', dir);
    expect(again.result.plan.mode).toBe('update');
    expect(again.result.plan.config).toBe('unchanged');
    expect(again.result.written).toEqual([]);
    expect(readFileSync(join(dir, 'package.json'), 'utf-8')).toBe(before);

    // User edits elsewhere.
    const pkgPath = join(dir, 'package.json');
    const pkg = readJson(pkgPath);
    pkg.scripts.custom = 'echo hi';
    pkg.dependencies['@happyvertical/smrt-commerce'] = '~0.55.9';
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(join(dir, 'src', 'app.ts'), '// mine\n');

    // Edited cookbook: the bakery adds the products package and more.
    const edited = await apply('bakery', dir);
    expect(edited.result.plan.mode).toBe('update');
    expect(edited.result.plan.config).toBe('update');
    const after = readJson(pkgPath);
    expect(after.scripts.custom).toBe('echo hi');
    expect(after.dependencies['@happyvertical/smrt-commerce']).toBe('~0.55.9');
    expect(after.name).toBe('idem');
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf-8')).toBe('// mine\n');
    expect(readJson(join(dir, 'smrt.cookbook.json')).recipes).toContain(
      'commerce.wholesale',
    );
  });

  it('applies --into an existing project', async () => {
    const dir = join(work, 'existing');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'mine',
        dependencies: { '@happyvertical/smrt-core': '^1.2.3' },
      }),
    );
    const { result } = await apply('welder', dir, { into: true });
    expect(result.plan.mode).toBe('update');
    const pkg = readJson(join(dir, 'package.json'));
    expect(pkg.name).toBe('mine');
    expect(pkg.dependencies['@happyvertical/smrt-commerce']).toBe('^1.2.3');
    expect(existsSync(join(dir, 'smrt.cookbook.json'))).toBe(true);
  });

  it('refuses a non-empty directory that is not a prior apply', async () => {
    const dir = join(work, 'busy');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    await expect(apply('bakery', dir)).rejects.toThrow(/not empty/);
  });

  it('--dry-run writes nothing', async () => {
    const dir = join(work, 'dry');
    const { result } = await apply('mechanic', dir, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.written).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(Object.keys(result.plan.addDependencies)).toContain(
      '@happyvertical/smrt-commerce',
    );
    expect(readdirSync(work)).not.toContain('dry');
  });

  it('falls back to the CLI release line without a framework dependency', async () => {
    const bare = join(work, 'bare-template');
    mkdirSync(bare);
    writeFileSync(join(bare, 'package.json'), '{"name":"bare"}\n');
    const { result } = await apply('yoga-studio', join(work, 'bare-out'), {
      template: bare,
    });
    expect(result.plan.addDependencies['@happyvertical/smrt-commerce']).toBe(
      '^9.9.9',
    );
  });
});

describe('registry fallback', () => {
  it('reads the exported manifest from the package tarball', async () => {
    const pkgDir = join(work, 'tarball', 'package', 'dist', 'lib');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(work, 'tarball', 'package', 'package.json'),
      JSON.stringify({ exports: { './manifest': './dist/lib/manifest.json' } }),
    );
    writeFileSync(
      join(pkgDir, 'manifest.json'),
      JSON.stringify({
        packageName: '@happyvertical/smrt-widgets',
        packageVersion: '1.0.0',
        recipes: [{ id: 'widgets.basic', requires: [] }],
      }),
    );
    const tgz = join(work, 'widgets.tgz');
    await create({ gzip: true, file: tgz, cwd: join(work, 'tarball') }, [
      'package',
    ]);
    const bytes = readFileSync(tgz);
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      const ok = url.endsWith('/latest') || url.endsWith('.tgz');
      return {
        ok,
        status: ok ? 200 : 404,
        json: async () => ({
          version: '1.0.0',
          dist: { tarball: 'https://registry.example/widgets.tgz' },
        }),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      };
    };
    const index = createRecipeIndex();
    const loaded = await loadRegistryManifest(
      index,
      '@happyvertical/smrt-widgets',
      {
        registryUrl: 'https://registry.example',
        versionHint: '0.5.0',
        fetchImpl,
      },
    );
    expect(loaded).toBe(true);
    expect(index.recipes.get('widgets.basic')?.packageName).toBe(
      '@happyvertical/smrt-widgets',
    );
    expect(urls[0]).toBe(
      'https://registry.example/@happyvertical%2Fsmrt-widgets/0.5.0',
    );
  });
});

describe('manifest and registry resolution', () => {
  it('resolves the manifest through package.json exports, then fallbacks', () => {
    const lib = join(work, 'lib-pkg');
    mkdirSync(join(lib, 'dist', 'lib'), { recursive: true });
    writeFileSync(join(lib, 'dist', 'lib', 'manifest.json'), '{}');
    writeFileSync(
      join(lib, 'package.json'),
      JSON.stringify({ exports: { './manifest': './dist/lib/manifest.json' } }),
    );
    expect(manifestPathForPackageDir(lib)).toBe(
      join(lib, 'dist', 'lib', 'manifest.json'),
    );
    const plain = join(work, 'plain-pkg');
    mkdirSync(join(plain, 'dist'), { recursive: true });
    writeFileSync(join(plain, 'dist', 'manifest.json'), '{}');
    expect(manifestPathForPackageDir(plain)).toBe(
      join(plain, 'dist', 'manifest.json'),
    );
    expect(manifestPathForPackageDir(join(work, 'nope'))).toBeNull();
  });

  it('reads the scope registry from .npmrc before npm_config_registry', () => {
    writeFileSync(
      join(work, '.npmrc'),
      '@happyvertical:registry=https://npm.example.test/\n//npm.example.test/:_authToken=sekret\n',
    );
    vi.stubEnv('npm_config_registry', 'https://env.example.test/');
    expect(registryForPackage('@happyvertical/smrt-products', work)).toEqual({
      url: 'https://npm.example.test',
      token: 'sekret',
    });
    vi.unstubAllEnvs();
  });

  it('falls back to npm_config_registry for an unscoped package', () => {
    vi.stubEnv('npm_config_registry', 'https://env.example.test/');
    expect(registryForPackage('left-pad', work).url).toBe(
      'https://env.example.test',
    );
    vi.unstubAllEnvs();
  });
});

describe('drive-by fixes found while building smrt kitchen (#3750)', () => {
  it('names a project outside the working tree by its absolute path', () => {
    const cwd = join(work, 'here');
    expect(nextSteps(join(cwd, 'app'), {}, true, cwd)[0]).toBe('cd app');
    const outside = join(work, 'elsewhere', 'app');
    expect(nextSteps(outside, {}, true, cwd)[0]).toBe(`cd ${outside}`);
  });

  it('does not read a JavaScript ./manifest export as a JSON manifest', () => {
    const pkg = join(work, 'js-manifest');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ exports: { './manifest': './dist/manifest.js' } }),
    );
    writeFileSync(join(pkg, 'dist', 'manifest.js'), 'export const x = 1;');
    expect(manifestPathForPackageDir(pkg)).toBeNull();
    writeFileSync(join(pkg, 'dist', 'manifest.json'), '{}');
    expect(manifestPathForPackageDir(pkg)).toBe(
      join(pkg, 'dist', 'manifest.json'),
    );
  });
});
