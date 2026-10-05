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
        [{ className: 'Missing', startLine: 1 }],
        '@fixture/agents3490',
      ),
    ).toThrow('Could not locate the body of class Missing');
  });

  it('records stamping in the published manifest of a scoped package', () => {
    expect(stampedLibraryManifest(manifest).stampsConstructors).toBe(true);
    expect(
      stampedLibraryManifest({ ...manifest, packageName: 'unscoped' })
        .stampsConstructors,
    ).toBeUndefined();
  });
});
