/**
 * Library builds stamp each `@smrt()` class a package declares with its
 * package name (#3490), so a consumer bundle cannot confuse the dependency's
 * class with an application class sharing its name and table.
 */
import { describe, expect, it } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import { stampedLibraryManifest, stampPackageModule } from './index.js';
import { injectPackageStamps } from './package-stamp.js';

const SOURCE = `import { smrt, SmrtCollection, SmrtObject } from '@happyvertical/smrt-core';

/**
 * Example: class AgentConfig { }  (a comment, not the class)
 */
@smrt({ description: 'class AgentConfig { decoy }', mcp: { include: ['list'] } })
export class AgentConfig extends SmrtObject {
  agentId: string = '';
}

@smrt({ tableStrategy: 'sti' })
export class AgentBrief extends mixin(AgentConfig, { tag: '{' }) {
  note = \`class AgentBrief {\`;
}

export class AgentConfigCollection extends SmrtCollection<{ id: string }> {
  static readonly _itemClass = AgentConfig;
}
`;

const manifest = {
  version: '1',
  timestamp: 0,
  packageName: '@fixture/agents3490',
  objects: {},
} as SmartObjectManifest;

describe('library package stamps (#3490)', () => {
  it('stamps the body of each decorated class, not comments, strings or undecorated classes', async () => {
    const result = await stampPackageModule(
      SOURCE,
      '/repo/packages/agents/src/config.ts',
      manifest,
    );
    const stamp = ' static __smrtPackage__ = "@fixture/agents3490";';
    expect(result?.code).toContain(
      `export class AgentConfig extends SmrtObject {${stamp}`,
    );
    expect(result?.code).toContain(
      `export class AgentBrief extends mixin(AgentConfig, { tag: '{' }) {${stamp}`,
    );
    expect(result?.code.split('__smrtPackage__')).toHaveLength(3);
    expect(result?.code).toContain(
      "@smrt({ description: 'class AgentConfig { decoy }'",
    );
    expect(result?.code).toContain(' * Example: class AgentConfig { }  (a');
    // One line per stamp: the source keeps its line numbers.
    expect(result?.code.split('\n')).toHaveLength(SOURCE.split('\n').length);
  });

  it('skips modules without decorated classes, dependencies and unscoped packages', async () => {
    expect(
      await stampPackageModule(
        'export const x = 1;',
        '/repo/src/x.ts',
        manifest,
      ),
    ).toBeNull();
    expect(
      await stampPackageModule(
        SOURCE,
        '/repo/node_modules/@other/pkg/src/config.ts',
        manifest,
      ),
    ).toBeNull();
    expect(
      await stampPackageModule(SOURCE, '/repo/src/config.ts', {
        ...manifest,
        packageName: 'unscoped',
      }),
    ).toBeNull();
  });

  it('fails the build rather than ship an unstamped class it could not locate', () => {
    expect(() =>
      injectPackageStamps(
        'const x = 1;',
        [{ className: 'Missing' }],
        '@fixture/agents3490',
      ),
    ).toThrow('Could not locate the body of class Missing');
    expect(() =>
      injectPackageStamps(
        'const x = 1;',
        [{ className: 'Missing', bodyStart: 2 }],
        '@fixture/agents3490',
      ),
    ).toThrow('Could not locate the body of class Missing');
  });

  const stamp = ' static __smrtPackage__ = "@fixture/agents3490";';
  const stampOf = (source: string) =>
    stampPackageModule(source, '/repo/packages/agents/src/thing.ts', manifest);

  it.each([
    [
      'a regex literal that looks like the class',
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
@smrt({ description: /class Thing {/.source }) export class Thing extends SmrtObject {}
`,
      ['export class Thing extends SmrtObject {'],
    ],
    [
      'a template literal whose substitution contains the class text',
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
const label = \`\${'class Thing {'} and \${\`class Thing {\`}\`;
@smrt({ description: \`\${label} class Thing {\` })
export class Thing extends SmrtObject {
  name = '';
}
`,
      ['export class Thing extends SmrtObject {'],
    ],
    [
      'a class expression of the same name assigned to a const',
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
const Decoy = class Thing extends SmrtObject {};
@smrt()
export class Thing extends SmrtObject {}
`,
      ['export class Thing extends SmrtObject {'],
    ],
    [
      'two classes on one line, after non-ASCII text',
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';
// Ünïcödé — 🦀 before the classes moves UTF-8 byte offsets, not UTF-16 ones.
@smrt() export class First extends SmrtObject {} @smrt() export class Second extends SmrtObject {}
`,
      [
        'export class First extends SmrtObject {',
        'export class Second extends SmrtObject {',
      ],
    ],
  ])('stamps only the real class body beside %s', async (_label, source, bodies) => {
    const result = await stampOf(source);
    expect(result).not.toBeNull();
    const code = result?.code ?? '';
    for (const body of bodies) {
      expect(code).toContain(`${body}${stamp}`);
    }
    expect(code.split(stamp)).toHaveLength(bodies.length + 1);
    // Everything else is untouched: removing the stamps restores the source.
    expect(code.split(stamp).join('')).toBe(source);
  });

  it('records stamping in the published manifest of a scoped package', () => {
    expect(stampedLibraryManifest(manifest).stampsConstructors).toBe(true);
    expect(
      stampedLibraryManifest({ ...manifest, packageName: 'unscoped' })
        .stampsConstructors,
    ).toBeUndefined();
  });
});
