/** The four bundled cookbooks must expose readable default lists. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Cookbook } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SmartObjectManifest } from '../../../../../core/src/scanner/types';
import {
  buildWebCollectionDefinition,
  selectWebCollectionEntries,
} from '../../../../../core/src/vite-plugin/web-collections';
import {
  FIXTURE_NAMES,
  REPO_ROOT,
  readFixture,
  workspaceCatalog,
} from '../../cookbook/__tests__/workspace-catalog';
import { buildCookbookShell } from '../../cookbook/build';
import { deriveScreenFields } from '../fields';
import type { createRecipeScreenReferences } from '../source.js';

let definitions: Map<
  string,
  Parameters<typeof createRecipeScreenReferences>[0][string]
>;
beforeAll(() => {
  const objects: SmartObjectManifest['objects'] = {};
  for (const pkg of readdirSync(join(REPO_ROOT, 'packages'))) {
    try {
      const manifest = JSON.parse(
        readFileSync(
          join(REPO_ROOT, 'packages', pkg, 'dist/manifest.json'),
          'utf8',
        ),
      ) as SmartObjectManifest;
      for (const [key, obj] of Object.entries(manifest.objects)) {
        const identity =
          obj.qualifiedName ??
          `${obj.packageName ?? manifest.packageName}:${obj.className ?? key}`;
        // Prefer each model's owning package over dependency relistings.
        if (!objects[identity] || obj.packageName === manifest.packageName)
          objects[identity] = obj;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const manifest = { objects } as SmartObjectManifest;
  definitions = new Map(
    selectWebCollectionEntries(manifest).map((entry) => {
      const definition = buildWebCollectionDefinition(entry, manifest);
      return [definition.objectRef, definition];
    }),
  );
});

describe.each(FIXTURE_NAMES)('%s template default columns', (name) => {
  it('shows a human label or named party and never an implementation field for every reachable list', async () => {
    const cookbook = readFixture(name) as Cookbook;
    const shell = buildCookbookShell({
      cookbook,
      catalog: await workspaceCatalog(),
    });
    let checked = 0;
    const missingNames: string[] = [];
    for (const entry of shell.entries.values()) {
      const definition = definitions.get(entry.model.id);
      if (!definition?.actions?.includes('list')) continue;
      const columns = deriveScreenFields(definition, null, { mode: 'list' });
      expect(columns.length, entry.model.id).toBeGreaterThan(0);
      if (
        !columns.some(
          (c) =>
            c.name === definition.displayLabelField ||
            c.kind === 'reference' ||
            c.roles?.some((r) => ['title', 'identifier', 'party'].includes(r)),
        )
      )
        missingNames.push(entry.model.id);
      for (const column of columns) {
        expect(column.kind, `${entry.model.id}.${column.name}`).not.toBe(
          'json',
        );
        expect(column.name, entry.model.id).not.toMatch(
          /hash|json|authority|provenance|historical|journal|backend|external/i,
        );
        expect(
          column.type === 'text' && /Id$/.test(column.name),
          `${entry.model.id}.${column.name}`,
        ).toBe(false);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(missingNames).toEqual([]);
  });
});
