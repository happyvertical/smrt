/** Public metadata-only subpath must bundle as real declarations, without the Users server root. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { matchForbiddenModule } from '../browser-gate/boundary.js';

const workspace = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
describe('portable Users permission metadata entry', () => {
  it.each([
    '@happyvertical/smrt-users/permission-registry',
    '@happyvertical/smrt-tenancy/decorators',
  ])('builds public metadata entry %s without server context or forbidden modules', async (specifier) => {
    const fixture = await mkdtemp(
      path.join(workspace, 'packages/bundle-gate/.portable-registry-'),
    );
    try {
      const entry = path.join(fixture, 'entry.js');
      await writeFile(entry, `export * from ${JSON.stringify(specifier)};`);
      const modules: string[] = [];
      const output = await build({
        root: path.join(workspace, 'packages/bundle-gate'),
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'portable-registry-real-browser-boundary',
            resolveId(id) {
              if (matchForbiddenModule(id))
                throw new Error(`Forbidden portable registry import: ${id}`);
            },
            moduleParsed(info) {
              modules.push(info.id);
            },
          },
        ],
        build: {
          write: false,
          minify: false,
          target: 'esnext',
          modulePreload: false,
          rollupOptions: {
            input: entry,
            preserveEntrySignatures: 'strict',
            output: { format: 'es' },
          },
        },
      });
      expect(
        modules.some((id) =>
          id.endsWith(
            specifier.endsWith('/decorators')
              ? '/tenancy/dist/decorators.js'
              : '/users/dist/permission-registry.js',
          ),
        ),
      ).toBe(true);
      expect(
        modules.filter((id) =>
          /\/users\/dist\/(?:index|operator)\.js$|PermissionCatalogService|PostgresPermissionPolicies|PasswordCredentialService|\/tenancy\/dist\/index\.js$|\/tenancy\/dist\/chunks\/context-|\/core\/dist\/migrations(?:\.js|\/(?:tracker|checksum)\.js)$/.test(
            id,
          ),
        ),
      ).toEqual([]);
      const result = Array.isArray(output) ? output[0] : output;
      expect('output' in result).toBe(true);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
