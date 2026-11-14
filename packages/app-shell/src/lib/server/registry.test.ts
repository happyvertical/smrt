// Registration-order guard: every permission/preference registration the shell
// needs happens through `registry.ts`, which `smrt.ts` imports before the
// runtime is created. A registration made anywhere else may run after the
// runtime seeded the owner role (the upgrade bug behind "The assistant could
// not start").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PermissionCatalogService } from '@happyvertical/smrt-users';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_USE_PERMISSION } from './agent-cli/settings.ts';
import './registry.ts';

const root = join(import.meta.dirname, '..', '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') walk(p, out);
    } else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name))
      out.push(p);
  }
  return out;
}
const files = walk(root).map(
  (p) => [relative(root, p), readFileSync(p, 'utf8')] as const,
);
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('startup registration order', () => {
  it('registers permissions and preference kinds only in modules registry.ts imports', () => {
    const registry = readFileSync(join(root, 'lib/server/registry.ts'), 'utf8');
    const allowed = [...strip(registry).matchAll(/import '\.\/([^']+)'/g)].map(
      (m) => `lib/server/${m[1]}`,
    );
    expect(allowed.length).toBeGreaterThan(0);
    const offenders = files
      .filter(([, text]) =>
        /\bregister(PermissionDefinitions|PreferenceKind)\s*\(/.test(
          strip(text),
        ),
      )
      .map(([f]) => f)
      .filter((f) => !allowed.includes(f));
    expect(offenders).toEqual([]);
  });

  it('smrt.ts imports registry.ts before it creates the runtime', () => {
    const text = strip(readFileSync(join(root, 'lib/server/smrt.ts'), 'utf8'));
    const registryAt = text.indexOf("import './registry.ts'");
    const createdAt = text.indexOf('createSmrtSvelteKitRuntime({');
    expect(registryAt).toBeGreaterThanOrEqual(0);
    expect(registryAt).toBeLessThan(createdAt);
    expect(text).not.toMatch(
      /import '\.\/(inference-registry|agent-cli\/settings)/,
    );
  });

  it('puts the shell permissions in the catalog the runtime seeds from', () => {
    const slugs = PermissionCatalogService.create({})
      .getCatalog()
      .permissions.map((p) => p.slug);
    expect(slugs).toEqual(
      expect.arrayContaining([
        ASSISTANT_USE_PERMISSION,
        'assistant.customize',
        'assistant.personalize',
        'inference.customize',
        'inference.personalize',
      ]),
    );
  });
});
