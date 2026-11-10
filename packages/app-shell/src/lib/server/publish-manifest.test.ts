// The release guards (verify-manifest-completeness, verify-manifest-exports)
// need a published `./manifest` export and a root export that serves every
// shell object. Their real run is `node scripts/validate-publish-packages.js`
// (see the PR); this keeps the wiring they read from regressing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lib = JSON.parse(readFileSync(join(root, 'tsconfig.lib.json'), 'utf8'));

describe('the published package', () => {
  it('exports its objects from the root and a manifest of them', () => {
    expect(pkg.exports['.'].import).toBe('./dist/lib/objects/index.js');
    expect(pkg.exports['.'].types).toBe('./dist/lib/objects/index.d.ts');
    expect(pkg.exports['./manifest']).toBe('./dist/manifest.json');
    // './manifest.json' would put the app in the planner catalog.
    expect(pkg.exports['./manifest.json']).toBeUndefined();
  });

  it('builds the library and writes dist/manifest.json', () => {
    expect(pkg.scripts.build).toContain('tsc -p tsconfig.lib.json');
    expect(pkg.scripts.build).toContain('tools/publish-manifest.mjs');
    expect(lib.include).toEqual(
      expect.arrayContaining(['src/lib/objects/index.ts']),
    );
    expect(pkg.files).toEqual(expect.arrayContaining(['dist']));
  });

  it('the objects barrel exports every shell model and collection', () => {
    const barrel = readFileSync(
      join(root, 'src', 'lib', 'objects', 'index.ts'),
      'utf8',
    );
    for (const name of [
      'App',
      'AppCollection',
      'AppVersion',
      'AppVersionCollection',
      'Approval',
      'ApprovalCollection',
      'AssistantMessage',
      'AssistantMessageCollection',
      'AssistantThread',
      'AssistantThreadCollection',
    ])
      expect(barrel).toMatch(new RegExp(`\\b${name}\\b`));
  });
});
