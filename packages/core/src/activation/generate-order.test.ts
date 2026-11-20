/**
 * Generated activation registers a parent before its same-named replacement
 * and its subtypes, whatever order the manifest lists them in (#5143).
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConsumerWorkspace,
  manifestEntry,
} from '../registry/__tests__/helpers/consumer-workspace.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { generateSvelteKitRoutes } from '../vite-plugin/sveltekit-generator.js';
import {
  buildActivationManifest,
  generateActivationRegistration,
} from './generate.js';
import { activationClosure } from './manifest.js';

const core = fileURLToPath(new URL('../..', import.meta.url));
const HOST = '@activation/app';
const workspaces: ReturnType<typeof createConsumerWorkspace>[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

interface Spec {
  /** `package:Class`; the host package's classes are local source files. */
  key: string;
  /** Qualified parent key (`extendsQualified`). */
  parent?: string;
  /** Raw overrides applied last. */
  extra?: Partial<SmartObjectDefinition>;
  replace?: boolean;
  /** Local classes sharing a file share a module. */
  file?: string;
  table?: string;
  /** Marks a collection of this item key. */
  collectionOf?: string;
  sti?: boolean;
}

const nameOf = (key: string) => key.slice(key.lastIndexOf(':') + 1);
const packageOf = (key: string) => key.slice(0, key.lastIndexOf(':'));

function project(specs: Spec[]) {
  const files = createConsumerWorkspace('activation-order');
  workspaces.push(files);
  files.write(
    'package.json',
    JSON.stringify({ name: HOST, type: 'module', private: true }),
  );
  const coreLink = files.path('node_modules/@happyvertical/smrt-core');
  mkdirSync(dirname(coreLink), { recursive: true });
  symlinkSync(core, coreLink, 'dir');
  const objects: Record<string, SmartObjectDefinition> = {};
  const exported = new Map<string, string[]>();
  for (const spec of specs) {
    const name = nameOf(spec.key);
    const pkg = packageOf(spec.key);
    const table = spec.table ?? `fixture_${name.toLowerCase()}`;
    let filePath: string;
    if (pkg === HOST) {
      filePath = files.path(`src/lib/${spec.file ?? name.toLowerCase()}.js`);
      const prior = exported.get(filePath) ?? [];
      prior.push(name);
      exported.set(filePath, prior);
    } else {
      filePath = files.path(`node_modules/${pkg}/index.js`);
      const prior = exported.get(filePath) ?? [];
      prior.push(name);
      exported.set(filePath, prior);
      files.write(
        `node_modules/${pkg}/package.json`,
        JSON.stringify({ name: pkg, type: 'module', exports: './index.js' }),
      );
    }
    const entry = manifestEntry({
      className: name,
      packageName: pkg,
      filePath,
      tableName: table,
      fields: { title: { type: 'text' } },
    });
    entry.schema!.columns = {
      id: { type: 'TEXT', primaryKey: true },
      title: { type: 'TEXT' },
    };
    if (pkg !== HOST) entry.importPath = pkg;
    if (spec.parent) {
      entry.extends = nameOf(spec.parent);
      entry.extendsQualified = spec.parent;
    }
    if (spec.replace !== undefined)
      entry.decoratorConfig = {
        ...entry.decoratorConfig,
        replaceParent: spec.replace,
      };
    if (spec.sti) entry.decoratorConfig.tableStrategy = 'sti';
    if (spec.collectionOf) {
      entry.extends = 'SmrtCollection';
      entry.extendsTypeArg = spec.collectionOf;
      entry.collectionOf = spec.collectionOf;
      delete entry.schema;
    }
    Object.assign(entry, spec.extra);
    objects[spec.key] = entry;
  }
  const specOf = new Map(specs.map((spec) => [spec.key, spec]));
  const fileOf = (key: string) => objects[key].filePath as string;
  const specifierFrom = (from: string, key: string) => {
    const pkg = packageOf(key);
    if (pkg !== HOST) return pkg;
    const path = relative(dirname(from), fileOf(key)).replaceAll('\\', '/');
    return path.startsWith('.') ? path : `./${path}`;
  };
  const depth = (key: string) => {
    let count = 0;
    for (
      let next = specOf.get(key)?.parent;
      next && specOf.has(next) && count < 10;
      next = specOf.get(next)?.parent
    )
      count += 1;
    return count;
  };
  for (const file of exported.keys()) {
    const keys = specs
      .filter((spec) => fileOf(spec.key) === file)
      .map((spec) => spec.key)
      .sort((a, b) => depth(a) - depth(b));
    const header = new Set<string>([
      "import { SmrtObject, SmrtCollection } from '@happyvertical/smrt-core';",
    ]);
    const body = keys.map((key, index) => {
      const spec = specOf.get(key) as Spec;
      let base = spec.collectionOf ? 'SmrtCollection' : 'SmrtObject';
      if (spec.parent && specOf.has(spec.parent)) {
        if (fileOf(spec.parent) === file) base = nameOf(spec.parent);
        else {
          base = `Parent${index}`;
          header.add(
            `import { ${nameOf(spec.parent)} as ${base} } from '${specifierFrom(file, spec.parent)}';`,
          );
        }
      }
      return `export class ${nameOf(key)} extends ${base} {}`;
    });
    files.write(
      file.slice(files.root.length + 1),
      `${[...header].join('\n')}\n${body.join('\n')}\n`,
    );
  }
  const manifest: SmartObjectManifest = {
    version: '1',
    timestamp: 0,
    packageName: HOST,
    objects,
  };
  return { files, manifest };
}

function reorder(manifest: SmartObjectManifest, keys: string[]) {
  return {
    ...manifest,
    objects: Object.fromEntries(
      keys.map((key) => [key, manifest.objects[key]]),
    ),
  } as SmartObjectManifest;
}

function generate(
  files: ReturnType<typeof project>['files'],
  manifest: SmartObjectManifest,
  options: { splitDeclarations?: boolean } = {},
) {
  return generateActivationRegistration(manifest, {
    projectRoot: files.root,
    outputDir: files.path('.smrt'),
    ...options,
  });
}

/** Registration keys in the order the real coordinator runs the loaders. */
function sequence(generated: ReturnType<typeof generate>): string[] {
  const modules = activationClosure(
    generated.manifest,
    Object.keys(generated.manifest.models),
  ).modules;
  const bodies = new Map<string, string>();
  const parts = generated.source.split(/^"(.+?)": async \(\) => \{$/m);
  for (let index = 1; index < parts.length; index += 2)
    bodies.set(JSON.parse(`"${parts[index]}"`), parts[index + 1]);
  const out: string[] = [];
  for (const module of modules) {
    const body = bodies.get(module) ?? '';
    for (const match of body.matchAll(/_manifestKey: "([^"]+)"/g))
      out.push(match[1]);
  }
  return out;
}

function expectBefore(order: string[], first: string, second: string) {
  expect(order, `${first} before ${second}`).toContain(first);
  expect(order.indexOf(first)).toBeLessThan(order.indexOf(second));
}

const PROVIDER = '@activation/customer:Customer';
const APP = `${HOST}:Customer`;

describe('generated activation order', () => {
  describe('parent before replacement', () => {
    const specs = (): Spec[] => [
      { key: APP, parent: PROVIDER, replace: true },
      { key: PROVIDER },
    ];

    it('registers the provider before an app replacement whose module sorts first', () => {
      const { files, manifest } = project(specs());
      const generated = generate(files, manifest);
      expectBefore(sequence(generated), PROVIDER, APP);
      expect(activationClosure(generated.manifest, [APP]).modules[0]).toBe(
        '@activation/customer',
      );
    });

    it('orders the parent first when the manifest lists the child first', () => {
      const { files, manifest } = project(specs());
      const child = reorder(manifest, [APP, PROVIDER]);
      expectBefore(sequence(generate(files, child)), PROVIDER, APP);
    });

    it('generates identical output whether the manifest lists parent or child first', () => {
      const { files, manifest } = project(specs());
      const a = generate(files, reorder(manifest, [APP, PROVIDER]));
      const b = generate(files, reorder(manifest, [PROVIDER, APP]));
      expect(a.source).toBe(b.source);
      expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest));
    });

    it('orders parent and replacement inside one module, child listed first', () => {
      const same = [
        { key: `${HOST}:Base`, file: 'one' },
        { key: `${HOST}:Leaf`, file: 'one', parent: `${HOST}:Base` },
      ];
      const { files, manifest } = project(same);
      const generated = generate(
        files,
        reorder(manifest, [`${HOST}:Leaf`, `${HOST}:Base`]),
      );
      expectBefore(sequence(generated), `${HOST}:Base`, `${HOST}:Leaf`);
    });

    it('keeps parent-first order inside one module', () => {
      const same = [
        { key: `${HOST}:Base`, file: 'one' },
        { key: `${HOST}:Leaf`, file: 'one', parent: `${HOST}:Base` },
      ];
      const { files, manifest } = project(same);
      expectBefore(
        sequence(generate(files, manifest)),
        `${HOST}:Base`,
        `${HOST}:Leaf`,
      );
    });

    it('places a differently named subclass and a replacement after their shared parent', () => {
      const SUB = '@activation/sub:VipCustomer';
      const { files, manifest } = project([
        { key: APP, parent: PROVIDER, replace: true },
        { key: SUB, parent: PROVIDER },
        { key: PROVIDER, sti: true },
      ]);
      for (const keys of [
        [APP, SUB, PROVIDER],
        [SUB, APP, PROVIDER],
      ]) {
        const order = sequence(generate(files, reorder(manifest, keys)));
        expectBefore(order, PROVIDER, APP);
        expectBefore(order, PROVIDER, SUB);
      }
    });
  });

  describe('chains and diamonds', () => {
    // Module ids sort against the inheritance order, so sorted is wrong.
    const A = '@activation/z:Base';
    const B = '@activation/m:Middle';
    const C = '@activation/a:Leaf';
    const chain = (): Spec[] => [
      { key: A },
      { key: B, parent: A },
      { key: C, parent: B },
    ];
    const permutations = <T>(items: T[]): T[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, index) =>
            permutations([
              ...items.slice(0, index),
              ...items.slice(index + 1),
            ]).map((rest) => [item, ...rest]),
          );

    it.each(
      permutations([A, B, C]).map((keys) => [keys.join(' > '), keys] as const),
    )('orders a three-level chain across three modules from listing %s', (_name, keys) => {
      const { files, manifest } = project(chain());
      const order = sequence(generate(files, reorder(manifest, keys)));
      expectBefore(order, A, B);
      expectBefore(order, B, C);
    });

    it.each(
      permutations(['Base', 'Middle', 'Leaf']).map(
        (names) => [names.join(' > '), names] as const,
      ),
    )('orders a three-level chain inside one module from listing %s', (_name, names) => {
      const keys = names.map((name) => `${HOST}:${name}`);
      const { files, manifest } = project([
        { key: `${HOST}:Base`, file: 'one' },
        { key: `${HOST}:Middle`, file: 'one', parent: `${HOST}:Base` },
        { key: `${HOST}:Leaf`, file: 'one', parent: `${HOST}:Middle` },
      ]);
      const order = sequence(generate(files, reorder(manifest, keys)));
      expectBefore(
        order,
        keys[names.indexOf('Base')],
        keys[names.indexOf('Middle')],
      );
      expectBefore(
        order,
        keys[names.indexOf('Middle')],
        keys[names.indexOf('Leaf')],
      );
    });

    it('orders a diamond: parent, both siblings, then the grandchild; ties break by key', () => {
      const P = '@activation/p:Root';
      const S1 = '@activation/s1:Left';
      const S2 = '@activation/s2:Right';
      const G = '@activation/g:Grand';
      const { files, manifest } = project([
        { key: G, parent: S2 },
        { key: S2, parent: P },
        { key: S1, parent: P },
        { key: P },
      ]);
      const order = sequence(generate(files, manifest));
      expect(order).toEqual([P, S1, S2, G]);
    });

    it('orders a replacement of a replacement after both declarations it replaces', () => {
      const BASE = '@activation/base:Thing';
      const MID = '@activation/mid:Thing';
      const TOP = `${HOST}:Thing`;
      const { files, manifest } = project([
        { key: TOP, parent: MID, replace: true },
        { key: MID, parent: BASE, replace: true },
        { key: BASE, sti: true },
      ]);
      const order = sequence(generate(files, manifest));
      expect(order).toEqual([BASE, MID, TOP]);
    });

    it('orders a subtype of a replacement after the replacement', () => {
      const { files, manifest } = project([
        { key: `${HOST}:Special`, parent: APP },
        { key: APP, parent: PROVIDER, replace: true },
        { key: PROVIDER },
      ]);
      const order = sequence(generate(files, manifest));
      expect(order).toEqual([PROVIDER, APP, `${HOST}:Special`]);
    });
  });

  describe('impossible orders fail at generation', () => {
    const ORDER = /Activation order is impossible/;

    it('fails for a parent cycle and names the cycle', () => {
      const A = '@activation/a:A';
      const B = '@activation/b:B';
      const { files, manifest } = project([
        { key: A, parent: B },
        { key: B, parent: A },
      ]);
      expect(() => generate(files, manifest)).toThrow(ORDER);
      expect(() => generate(files, manifest)).toThrow(
        new RegExp(`${A}.*${B}|${B}.*${A}`),
      );
    });

    it('fails when a class extends itself by its qualified key', () => {
      const A = '@activation/a:A';
      const { files, manifest } = project([{ key: A, parent: A }]);
      expect(() => generate(files, manifest)).toThrow(/extends itself/);
    });

    it('keeps an unqualified same-named parent that is not in the manifest as no edge', () => {
      const { files, manifest } = project([{ key: APP }]);
      manifest.objects[APP].extends = 'Customer';
      const generated = generate(files, manifest);
      expect(generated.manifest.models[APP]?.parent).toBeUndefined();
    });

    it('names only the cycle members in a three-way cycle with unrelated and downstream models', () => {
      const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map(
        (n) => `@activation/${n}:${n.toUpperCase()}`,
      );
      const { files, manifest } = project([
        { key: A, parent: C },
        { key: B, parent: A },
        { key: C, parent: B },
        { key: D, parent: A },
        { key: E },
      ]);
      let message = '';
      try {
        generate(files, manifest);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(ORDER);
      for (const id of [A, B, C]) expect(message).toContain(id);
      expect(message).not.toContain(D);
      expect(message).not.toContain(E);
    });

    it('fails for a same-named replacement whose parent is not in the manifest, without suggesting import order', () => {
      const { files, manifest } = project([
        { key: APP, parent: PROVIDER, replace: true },
      ]);
      let message = '';
      try {
        generate(files, manifest);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(APP);
      expect(message).toContain(PROVIDER);
      expect(message).toMatch(/not in the activation manifest/);
      expect(message).not.toMatch(/import .* module first/);
    });

    it('fails for a plain subclass whose parent is missing', () => {
      const { files, manifest } = project([
        { key: '@activation/c:Child', parent: '@activation/gone:Gone' },
      ]);
      expect(() => generate(files, manifest)).toThrow(
        /not in the activation manifest/,
      );
    });

    it("fails when two modules each host the parent of the other module's same-named class", () => {
      const P1 = '@activation/p1:Thing';
      const P2 = '@activation/p2:Other';
      const C1 = '@activation/p2:Thing';
      const C2 = '@activation/p1:Other';
      const { files, manifest } = project([
        { key: P1 },
        { key: P2 },
        { key: C1, parent: P1, replace: true },
        { key: C2, parent: P2, replace: true },
      ]);
      let message = '';
      try {
        generate(files, manifest);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(ORDER);
      expect(message).toContain('@activation/p1');
      expect(message).toContain('@activation/p2');
      expect(message).toContain(P1);
      expect(message).not.toMatch(/import .* module first/);
    });

    it('does not reject a module cycle made of plain subclass edges', () => {
      const B1 = '@activation/m1:Base1';
      const B2 = '@activation/m2:Base2';
      const S1 = '@activation/m2:Sub1';
      const S2 = '@activation/m1:Sub2';
      const { files, manifest } = project([
        { key: B1 },
        { key: B2 },
        { key: S1, parent: B1 },
        { key: S2, parent: B2 },
      ]);
      const generated = generate(files, manifest);
      expect(sequence(generated).sort()).toEqual([B1, B2, S1, S2].sort());
    });

    it('ignores framework bases when ordering', () => {
      const { files, manifest } = project([{ key: APP }]);
      manifest.objects[APP].extends = 'SmrtObject';
      const generated = generate(files, manifest);
      expect(generated.manifest.models[APP].parent).toBeUndefined();
    });

    it('treats a package-local class named like a framework base as a parent', () => {
      const LOCAL = `${HOST}:SmrtObject`;
      const { files, manifest } = project([
        { key: `${HOST}:Child` },
        { key: `${HOST}:Other` },
      ]);
      manifest.objects[`${HOST}:Child`].extends = 'Other';
      const generated = generate(files, manifest);
      expect(generated.manifest.models[`${HOST}:Child`].parent).toBe(
        `${HOST}:Other`,
      );
      expect(LOCAL).toBeTruthy();
    });

    it('does not guess among an ambiguous model and collection pair', () => {
      const { files, manifest } = project([
        { key: '@activation/x:Thing' },
        { key: '@activation/y:Thing', collectionOf: '@activation/x:Thing' },
        { key: `${HOST}:Child` },
      ]);
      manifest.objects[`${HOST}:Child`].extends = 'Thing';
      delete manifest.objects[`${HOST}:Child`].extendsQualified;
      expect(() => generate(files, manifest)).toThrow(/Child.*extends/);
    });
  });

  describe('packages and identity', () => {
    it('orders a cross-package parent by its qualified key', () => {
      const { files, manifest } = project([
        { key: APP, parent: PROVIDER, replace: true },
        { key: '@activation/other:Customer' },
        { key: PROVIDER },
      ]);
      expect(generate(files, manifest).manifest.models[APP].parent).toBe(
        PROVIDER,
      );
    });

    it('resolves an unqualified cross-package parent with one candidate', () => {
      const { files, manifest } = project([
        { key: `${HOST}:Child` },
        { key: PROVIDER },
      ]);
      manifest.objects[`${HOST}:Child`].extends = 'Customer';
      const generated = generate(
        files,
        reorder(manifest, [`${HOST}:Child`, PROVIDER]),
      );
      expectBefore(sequence(generated), PROVIDER, `${HOST}:Child`);
    });

    it('does not pick a parent among two same-named classes without a qualified key', () => {
      const OTHER = '@activation/other:Customer';
      const { files, manifest } = project([
        { key: `${HOST}:Child`, parent: OTHER },
        { key: OTHER },
        { key: PROVIDER },
      ]);
      expect(
        generate(files, manifest).manifest.models[`${HOST}:Child`].parent,
      ).toBe(OTHER);
      delete manifest.objects[`${HOST}:Child`].extendsQualified;
      manifest.objects[`${HOST}:Child`].extends = 'Customer';
      expect(() => generate(files, manifest)).toThrow(/Child/);
    });

    it('orders an app-scoped replacement after the package class it replaces', () => {
      const { files, manifest } = project([
        { key: APP, parent: PROVIDER, replace: true },
        { key: PROVIDER },
      ]);
      expectBefore(
        sequence(generate(files, reorder(manifest, [APP, PROVIDER]))),
        PROVIDER,
        APP,
      );
    });

    it('keeps qualified discriminator keys unchanged by reordering', () => {
      const { files, manifest } = project([
        { key: APP, parent: PROVIDER, replace: true },
        { key: PROVIDER },
      ]);
      const keys = (source: string) =>
        [...source.matchAll(/_manifestKey: "([^"]+)"/g)]
          .map((m) => m[1])
          .sort();
      const a = generate(files, reorder(manifest, [APP, PROVIDER]));
      const b = generate(files, reorder(manifest, [PROVIDER, APP]));
      expect(keys(a.source)).toEqual(keys(b.source));
      expect(keys(a.source)).toEqual([APP, PROVIDER].sort());
    });

    it('still rejects a manifest key owned by two modules', () => {
      const { files, manifest } = project([{ key: PROVIDER }]);
      const generated = generate(files, manifest);
      const duplicate = structuredClone(generated.manifest.modules);
      duplicate.extra = {
        specifier: '@activation/customer',
        models: [PROVIDER],
        dependencies: [],
      };
      expect(() => buildActivationManifest(manifest, duplicate)).toThrow(
        /Duplicate activation owner/,
      );
    });

    it('rejects a key whose package prefix disagrees with its declared package before import selection', () => {
      const { files, manifest } = project([{ key: PROVIDER }]);
      manifest.objects[PROVIDER].packageName = '@activation/elsewhere';
      expect(() => generate(files, manifest)).toThrow(
        new RegExp(`${PROVIDER}.*packageName`),
      );
    });

    it('accepts a verified parent from another package than the child', () => {
      const { files, manifest } = project([
        { key: `${HOST}:Child`, parent: PROVIDER },
        { key: PROVIDER },
      ]);
      expect(() => generate(files, manifest)).not.toThrow();
    });
  });

  describe('malformed parent declarations', () => {
    it.each([
      ['extends', ''],
      ['extends', '   '],
      ['extends', 7],
      ['extendsQualified', ''],
      ['extendsQualified', 3],
      ['extendsQualified', 'NoPackage'],
      ['extendsQualified', ':Class'],
    ])('rejects a present %s of %j naming the object and field', (field, value) => {
      const { files, manifest } = project([
        { key: `${HOST}:Child`, parent: PROVIDER },
        { key: PROVIDER },
      ]);
      (manifest.objects[`${HOST}:Child`] as unknown as Record<string, unknown>)[
        field
      ] = value;
      expect(() => generate(files, manifest)).toThrow(
        new RegExp(`${HOST}:Child.*${field}`),
      );
    });

    it.each([
      '@happyvertical/smrt-core::SmrtObject',
      '@happyvertical/smrt-core:x:SmrtObject',
      ':SmrtObject',
      '@happyvertical/smrt-core:',
      '@happyvertical/smrt-core: SmrtObject',
      '@activation/customer::Customer',
    ])('rejects a malformed qualified extends %j without extendsQualified, naming the object and extends', (value) => {
      const { files, manifest } = project([
        { key: `${HOST}:Child`, parent: PROVIDER },
        { key: PROVIDER },
      ]);
      delete manifest.objects[`${HOST}:Child`].extendsQualified;
      manifest.objects[`${HOST}:Child`].extends = value;
      expect(() => generate(files, manifest)).toThrow(
        new RegExp(`${HOST}:Child declares an invalid extends`),
      );
    });

    it('accepts a well-formed qualified framework extends without extendsQualified as no parent', () => {
      const { files, manifest } = project([{ key: `${HOST}:Child` }]);
      manifest.objects[`${HOST}:Child`].extends =
        '@happyvertical/smrt-core:SmrtObject';
      expect(
        generate(files, manifest).manifest.models[`${HOST}:Child`].parent,
      ).toBe(undefined);
    });

    it('rejects a blank extends even when extendsQualified is valid', () => {
      const { files, manifest } = project([
        { key: `${HOST}:Child`, parent: PROVIDER },
        { key: PROVIDER },
      ]);
      manifest.objects[`${HOST}:Child`].extends = '';
      expect(() => generate(files, manifest)).toThrow(/extends/);
    });

    it('rejects a qualified extends that disagrees with extendsQualified', () => {
      const { files, manifest } = project([
        { key: `${HOST}:Child`, parent: PROVIDER },
        { key: PROVIDER },
        { key: '@activation/other:Customer' },
      ]);
      manifest.objects[`${HOST}:Child`].extends = '@activation/other:Customer';
      expect(() => generate(files, manifest)).toThrow(/disagree/);
    });

    it('treats an absent extends as no parent', () => {
      const { files, manifest } = project([{ key: PROVIDER }]);
      delete (manifest.objects[PROVIDER] as { extends?: string }).extends;
      expect(generate(files, manifest).manifest.models[PROVIDER].parent).toBe(
        undefined,
      );
    });

    it('emits nothing for a rejected manifest', () => {
      const { files, manifest } = project([
        { key: `${HOST}:Child`, parent: PROVIDER },
        { key: PROVIDER },
      ]);
      manifest.objects[`${HOST}:Child`].extendsQualified = ' ';
      let result: unknown;
      try {
        result = generate(files, manifest);
      } catch {
        result = undefined;
      }
      expect(result).toBeUndefined();
      expect(existsSync(files.path('.smrt/register.js'))).toBe(false);
    });
  });

  describe('determinism', () => {
    const specs = (): Spec[] => [
      { key: APP, parent: PROVIDER, replace: true },
      { key: PROVIDER },
      { key: '@activation/zeta:Zeta', parent: `${HOST}:Alpha` },
      { key: `${HOST}:Alpha` },
      { key: '@activation/invoice:Invoice' },
      { key: '@activation/unused:Unused' },
    ];
    const shuffled = (keys: string[], seed: number) => {
      const out = [...keys];
      let state = seed;
      for (let index = out.length - 1; index > 0; index -= 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const other = state % (index + 1);
        [out[index], out[other]] = [out[other], out[index]];
      }
      return out;
    };
    const bytes = (generated: ReturnType<typeof generate>) =>
      JSON.stringify([generated.source, generated.files, generated.manifest]);

    it('generates byte-identical output for every shuffle of manifest object keys, split or inline', () => {
      const { files, manifest } = project(specs());
      const sorted = Object.keys(manifest.objects).sort();
      for (const split of [false, true]) {
        const base = bytes(
          generate(files, reorder(manifest, sorted), {
            splitDeclarations: split,
          }),
        );
        const orders = [
          [...sorted].reverse(),
          shuffled(sorted, 1),
          shuffled(sorted, 2),
          shuffled(sorted, 3),
        ];
        // Non-vacuous: every probed listing differs from the sorted one.
        for (const keys of orders) expect(keys).not.toEqual(sorted);
        for (const keys of orders)
          expect(
            bytes(
              generate(files, reorder(manifest, keys), {
                splitDeclarations: split,
              }),
            ),
          ).toBe(base);
      }
    });

    it('generates identical graphs for shuffled module maps', () => {
      const { files, manifest } = project(specs());
      const generated = generate(files, manifest);
      const ids = Object.keys(generated.manifest.modules);
      const build = (order: string[]) =>
        JSON.stringify(
          buildActivationManifest(
            manifest,
            Object.fromEntries(
              order.map((id) => [id, generated.manifest.modules[id]]),
            ),
          ),
        );
      expect(build([...ids].reverse())).toBe(build(ids));
      expect(build(shuffled(ids, 5))).toBe(build(ids));
    });

    it('generates identical output on a second run', () => {
      const { files, manifest } = project(specs());
      expect(bytes(generate(files, manifest))).toBe(
        bytes(generate(files, manifest)),
      );
    });

    it('breaks ties between independent roots by code-unit key order', () => {
      const keys = [
        `${HOST}:alpha`,
        `${HOST}:Zed`,
        `${HOST}:Alpha`,
        `${HOST}:_x`,
      ];
      const { files, manifest } = project(
        keys.map((key) => ({ key, file: 'one' })),
      );
      const order = sequence(
        generate(files, reorder(manifest, [...keys].reverse())),
      );
      expect(order).toEqual([...keys].sort());
      expect(order).not.toEqual([...keys].reverse());
    });

    it('returns to the original bytes after adding and removing a replacement', () => {
      const { files, manifest } = project(specs());
      const original = bytes(generate(files, manifest));
      const withExtra = project([...specs(), { key: `${HOST}:Extra` }]);
      generate(withExtra.files, withExtra.manifest);
      expect(bytes(generate(files, manifest))).toBe(original);
    });
  });

  describe('collections', () => {
    const ITEM = `${HOST}:Customer`;
    const PCOL = '@activation/customer:Customers';
    const ACOL = `${HOST}:CustomerList`;
    const specs = (): Spec[] => [
      { key: ITEM, parent: PROVIDER, replace: true },
      { key: PROVIDER },
      { key: PCOL, collectionOf: PROVIDER },
      { key: ACOL, collectionOf: ITEM },
    ];

    it('registers a collection after its item when the collection is listed first', () => {
      const { files, manifest } = project([
        {
          key: `${HOST}:Customers`,
          collectionOf: `${HOST}:Customer`,
          file: 'one',
        },
        { key: `${HOST}:Customer`, file: 'one' },
      ]);
      const generated = generate(
        files,
        reorder(manifest, [`${HOST}:Customers`, `${HOST}:Customer`]),
      );
      const loader = generated.source;
      expect(
        loader.indexOf('_manifestKey: "@activation/app:Customer"'),
      ).toBeLessThan(
        loader.indexOf('registerCollection("@activation/app:Customers"'),
      );
    });

    it.each([
      ['item first', [ITEM, PROVIDER, PCOL, ACOL]],
      ['app collection first', [ACOL, PCOL, PROVIDER, ITEM]],
      ['provider collection first', [PCOL, ACOL, ITEM, PROVIDER]],
    ])('lets the collection of the more derived item register last, %s', (_name, keys) => {
      const { files, manifest } = project(specs());
      const generated = generate(files, reorder(manifest, keys));
      const calls = [
        ...generated.source.matchAll(/registerCollection\("([^"]+)", Reflect/g),
      ];
      expect(calls.length).toBeGreaterThan(0);
      const order = activationClosure(
        generated.manifest,
        Object.keys(generated.manifest.models),
      ).modules;
      const moduleOf = (key: string) =>
        key === ACOL ? '../src/lib/customerlist.js' : '@activation/customer';
      expect(order.indexOf(moduleOf(PCOL))).toBeLessThan(
        order.indexOf(moduleOf(ACOL)),
      );
      expect(generated.manifest.modules[moduleOf(ACOL)].after).toContain(
        moduleOf(PCOL),
      );
    });
  });

  describe('publication', () => {
    it('leaves previously published outputs byte-identical when ordering fails', async () => {
      const A = '@activation/a:A';
      const B = '@activation/b:B';
      const { files, manifest } = project([{ key: A }, { key: B }]);
      files.write('src/lib/server/smrt.ts', 'export const options = {};');
      const options = {
        enabled: true,
        lazyActivation: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      };
      await generateSvelteKitRoutes(files.root, manifest, options);
      const snapshot = () => {
        const out: Record<string, string> = {};
        const walk = (dir: string) => {
          for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (name === 'node_modules') continue;
            if (statSync(path).isDirectory()) walk(path);
            else out[path] = readFileSync(path, 'utf8');
          }
        };
        walk(files.root);
        return out;
      };
      const before = snapshot();
      expect(
        Object.keys(before).some((p) => p.endsWith('smrt-register.ts')),
      ).toBe(true);
      manifest.objects[A].extends = 'B';
      manifest.objects[A].extendsQualified = B;
      manifest.objects[B].extends = 'A';
      manifest.objects[B].extendsQualified = A;
      await expect(
        generateSvelteKitRoutes(files.root, manifest, options),
      ).rejects.toThrow(/Activation order is impossible/);
      const after = snapshot();
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      expect(after).toEqual(before);
      delete manifest.objects[A].extendsQualified;
      delete manifest.objects[B].extendsQualified;
      manifest.objects[A].extends = 'SmrtObject';
      manifest.objects[B].extends = 'SmrtObject';
      await generateSvelteKitRoutes(files.root, manifest, options);
      expect(snapshot()).toEqual(before);
    });

    it('refuses a same-named subclass without replaceParent in both public generators and leaves published outputs byte-identical', async () => {
      const { files, manifest } = project([
        { key: APP, parent: PROVIDER, replace: true },
        { key: PROVIDER },
      ]);
      files.write('src/lib/server/smrt.ts', 'export const options = {};');
      const options = {
        enabled: true,
        lazyActivation: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      };
      await generateSvelteKitRoutes(files.root, manifest, options);
      const snapshot = () => {
        const out: Record<string, string> = {};
        const walk = (dir: string) => {
          for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (name === 'node_modules') continue;
            if (statSync(path).isDirectory()) walk(path);
            else out[path] = readFileSync(path, 'utf8');
          }
        };
        walk(files.root);
        return out;
      };
      const before = snapshot();
      delete manifest.objects[APP].decoratorConfig.replaceParent;
      const undeclared = /replaceParent/;
      expect(() => generate(files, manifest)).toThrow(undeclared);
      expect(() =>
        buildActivationManifest(manifest, {
          '@activation/customer': {
            specifier: '@activation/customer',
            models: [PROVIDER],
            dependencies: [],
          },
          app: { specifier: 'app', models: [APP], dependencies: [] },
        }),
      ).toThrow(undeclared);
      await expect(
        generateSvelteKitRoutes(files.root, manifest, options),
      ).rejects.toThrow(undeclared);
      expect(snapshot()).toEqual(before);
    });
  });
});

/** Child-process fixtures: the real coordinator, registry and decorators. */
const sqlEntry = new URL(
  '../../node_modules/@happyvertical/sql/dist/index.js',
  import.meta.url,
).href;

function runNode(
  files: ReturnType<typeof project>['files'],
  generated: ReturnType<typeof generate>,
  body: string,
) {
  files.write('.smrt/register.js', generated.source);
  files.write(
    'run.mjs',
    `import assert from 'node:assert/strict';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { createActivationCoordinator } from '@happyvertical/smrt-core/activation';
import { getDatabase } from ${JSON.stringify(sqlEntry)};
import { activationManifest, activationLoaders } from './.smrt/register.js';
const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
const coordinator = (enabled) => createActivationCoordinator({ scope: 'order', db, packageName: '@activation/app', manifest: activationManifest, loaders: activationLoaders, readEnabled: async () => enabled });
${body}
await db.close();
`,
  );
  const child = spawnSync(process.execPath, ['run.mjs'], {
    cwd: files.root,
    encoding: 'utf8',
  });
  return { status: child.status, output: child.stderr || child.stdout };
}

describe('generated activation in a fresh process', () => {
  const ITEM = `${HOST}:Customer`;
  const PCOL = '@activation/customer:Customers';

  describe.each([
    ['sorts before', '@aaa/lists'],
    ['sorts after', '@zzz/lists'],
  ])('with the app collection in a module that %s the provider', (_label, pkg) => {
    const ACOL = `${pkg}:CustomerList`;
    it('serves the receiver of the more derived item, whichever order modules and manifest list', () => {
      for (const listing of [0, 1]) {
        const specs: Spec[] = [
          { key: ITEM, parent: PROVIDER, replace: true },
          { key: PROVIDER },
          { key: PCOL, collectionOf: PROVIDER },
          { key: ACOL, collectionOf: ITEM },
        ];
        const { files, manifest } = project(specs);
        files.write(
          'node_modules/@activation/customer/index.js',
          `import { SmrtObject, SmrtCollection } from '@happyvertical/smrt-core';
export class Customer extends SmrtObject {}
export class Customers extends SmrtCollection { static _itemClass = Customer; who() { return 'provider'; } }
`,
        );
        files.write(
          `node_modules/${pkg}/index.js`,
          `import { SmrtCollection } from '@happyvertical/smrt-core';
import { Customer } from '../../../src/lib/customer.js';
export class CustomerList extends SmrtCollection { static _itemClass = Customer; who() { return 'app'; } }
`,
        );
        const keys = Object.keys(manifest.objects);
        const generated = generate(
          files,
          reorder(manifest, listing ? keys.reverse() : keys),
        );
        const run = runNode(
          files,
          generated,
          `await coordinator(['${ITEM}']).boot();
const collection = await ObjectRegistry.getCollection('${ITEM}', { db });
assert.equal(collection.who(), 'app');`,
        );
        expect(run.status, run.output).toBe(0);
      }
    });
  });

  it.each([
    ['by simple name', true],
    ['by qualified key', false],
  ])('binds a provider collection that names its item %s to the effective replacement', (_label, simple) => {
    const { files, manifest } = project([
      { key: ITEM, parent: PROVIDER, replace: true },
      { key: PROVIDER },
      { key: PCOL, collectionOf: PROVIDER },
    ]);
    if (simple) {
      // Legacy input: the generic names the item by its simple name only.
      delete manifest.objects[PCOL].collectionOf;
      manifest.objects[PCOL].extendsTypeArg = 'Customer';
    }
    files.write(
      'node_modules/@activation/customer/index.js',
      `import { SmrtObject, SmrtCollection } from '@happyvertical/smrt-core';
export class Customer extends SmrtObject {}
export class Customers extends SmrtCollection { static _itemClass = Customer; who() { return 'provider'; } }
`,
    );
    const generated = generate(files, manifest);
    expect(
      generated.manifest.modules['@activation/customer'].collections,
    ).toEqual([PCOL]);
    // Looked up by either key first, the effective item serves the receiver.
    for (const keys of [
      [PROVIDER, ITEM],
      [ITEM, PROVIDER],
    ]) {
      const run = runNode(
        files,
        generated,
        `await coordinator(['${PROVIDER}']).boot();
for (const key of ${JSON.stringify(keys)}) {
  const collection = await ObjectRegistry.getCollection(key, { db });
  assert.equal(collection.who?.(), 'provider', key);
}`,
      );
      expect(run.status, run.output).toBe(0);
    }
  });

  it('keeps the effective constructor, tenancy and exposure of a tenant-scoped provider and its replacement, next to a differently named subclass, in both listing orders', () => {
    const VIP = '@activation/sub:VipCustomer';
    for (const listing of ['replacement first', 'provider first']) {
      const { files, manifest } = project([
        { key: ITEM, parent: PROVIDER, replace: true },
        { key: VIP, parent: PROVIDER, table: 'fixture_customer' },
        { key: PROVIDER, sti: true },
      ]);
      manifest.objects[PROVIDER].decoratorConfig = {
        ...manifest.objects[PROVIDER].decoratorConfig,
        tenantScoped: { mode: 'optional' },
        api: { exclude: ['delete'] },
      };
      // The replacement declares tenancy of its own too (#5143): tenancy on
      // both sides of a replacement stays supported.
      manifest.objects[ITEM].decoratorConfig = {
        ...manifest.objects[ITEM].decoratorConfig,
        tenantScoped: { mode: 'required' },
      };
      const keys = [ITEM, VIP, PROVIDER];
      const generated = generate(
        files,
        reorder(
          manifest,
          listing === 'replacement first' ? keys : keys.reverse(),
        ),
      );
      const run = runNode(
        files,
        generated,
        `await coordinator(['${PROVIDER}', '${VIP}']).boot();
const effective = ObjectRegistry.getClass('${PROVIDER}');
const vip = ObjectRegistry.getClass('${VIP}');
const providers = await ObjectRegistry.getCollection('${PROVIDER}', { db });
const saved = await providers.create({ title: 'kept' });
await saved.save();
const listed = await (await ObjectRegistry.getCollection('${ITEM}', { db })).list({});
assert.deepEqual({
  effective: effective.qualifiedName,
  effectiveName: effective.constructor.name,
  sameEntry: ObjectRegistry.getClass('${ITEM}') === effective,
  tenant: effective.tenantScopedConfig?.mode,
  api: effective.config?.api,
  replaced: effective.replacedQualifiedNames,
  vip: vip?.qualifiedName,
  vipName: vip?.constructor.name,
  listed: listed.map((row) => [row.constructor.name, row.title]),
}, ${JSON.stringify({
          effective: ITEM,
          effectiveName: 'Customer',
          sameEntry: true,
          tenant: 'required',
          api: { exclude: ['delete'] },
          replaced: [PROVIDER],
          vip: VIP,
          vipName: 'VipCustomer',
          listed: [['Customer', 'kept']],
        })});`,
      );
      expect(run.status, `${listing}: ${run.output}`).toBe(0);
    }
  });

  it('denies a disabled tenant through the coordinator gate on the generated registration', () => {
    const { files, manifest } = project([
      { key: ITEM, parent: PROVIDER, replace: true },
      { key: PROVIDER },
    ]);
    const generated = generate(files, reorder(manifest, [ITEM, PROVIDER]));
    const run = runNode(
      files,
      generated,
      `const c = coordinator(['${PROVIDER}']);
await c.boot();
const gate = c.gate({ isEnabled: (model, context) => context.tenantId === 'a' });
assert.equal(gate.isEnabled({ qualifiedName: '${PROVIDER}' }, { tenantId: 'a' }), true);
assert.equal(gate.isEnabled({ qualifiedName: '${PROVIDER}' }, { tenantId: 'b' }), false);`,
    );
    expect(run.status, run.output).toBe(0);
  });

  it('registers a decorated child imported by an earlier-sorting module only after its parent', () => {
    const BARREL = '@aaa/barrel:Barrel';
    const CHILD = '@activation/appc:Customer';
    for (const withEdge of [true]) {
      const { files, manifest } = project([
        { key: PROVIDER },
        { key: CHILD, parent: PROVIDER, replace: true },
        { key: BARREL },
      ]);
      files.write(
        'node_modules/@activation/appc/index.js',
        `import { smrt } from '@happyvertical/smrt-core';
import { Customer as Base } from '@activation/customer';
export const Customer = smrt({ packageName: '@activation/appc', replaceParent: true, tableName: 'fixture_customer' })(class Customer extends Base {});
`,
      );
      files.write(
        'node_modules/@aaa/barrel/index.js',
        `import { SmrtObject } from '@happyvertical/smrt-core';
export { Customer } from '@activation/appc';
export class Barrel extends SmrtObject {}
`,
      );
      manifest.objects[CHILD].decoratorConfig = {
        ...manifest.objects[CHILD].decoratorConfig,
        replaceParent: true,
      };
      const generated = generate(files, manifest);
      expect(withEdge).toBe(true);
      expect(generated.manifest.modules['@aaa/barrel'].after).toContain(
        '@activation/customer',
      );
      const run = runNode(
        files,
        generated,
        `await coordinator(['${BARREL}']).boot();
assert.equal(ObjectRegistry.getClass('${PROVIDER}').qualifiedName, '${CHILD}');`,
      );
      expect(run.status, run.output).toBe(0);
    }
  });

  it('rejects a module that hosts a parent while importing the module of its same-named child', () => {
    const CHILD = '@activation/appc:Customer';
    const { files, manifest } = project([
      { key: PROVIDER },
      { key: CHILD, parent: PROVIDER, replace: true },
    ]);
    files.write(
      'node_modules/@activation/customer/index.js',
      `import { SmrtObject } from '@happyvertical/smrt-core';
import '@activation/appc';
export class Customer extends SmrtObject {}
`,
    );
    files.write(
      'node_modules/@activation/appc/index.js',
      `import { SmrtObject } from '@happyvertical/smrt-core';
export class Customer extends SmrtObject {}
`,
    );
    expect(() => generate(files, manifest)).toThrow(
      /@activation\/customer imports @activation\/appc/,
    );
  });
});
