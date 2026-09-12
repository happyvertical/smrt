import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectNullEqualIndexTargets } from '../../migrations/null-equal-indexes.js';
import {
  collectManifestTables,
  renderCollectedManifestTable,
} from '../../schema/manifest-schema.js';
import { ManifestManager } from '../manager.js';

const packages = [
  'ads',
  'messages',
  'places',
  'projects',
  'agents',
  'content',
  'tags',
  'properties',
  'profiles',
  'events',
  'assets',
  'analytics',
];

describe('checked-in NULL-equal source manifests (#2834)', () => {
  it.each(
    packages,
  )('loads %s without build/dev artifacts and retains framework identities', (name) => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-source-2834-'));
    try {
      const source = readFileSync(
        join(process.cwd(), '..', name, 'src/manifest/manifest.json'),
        'utf8',
      );
      mkdirSync(join(root, 'src/manifest'), { recursive: true });
      writeFileSync(join(root, 'src/manifest/manifest.json'), source);
      const manifest = new ManifestManager(root).loadForExternalPackage();
      if (!manifest) throw new Error('Source manifest was not loaded');
      expect(manifest.packageName).toBe(`@happyvertical/smrt-${name}`);
      const tables = collectManifestTables(
        Object.entries(manifest.objects).flatMap(([key, object]) =>
          object.schema ? [{ schema: object.schema, source: key }] : [],
        ),
      );
      const targets = collectNullEqualIndexTargets(
        Object.fromEntries(
          [...tables].map(([key, table]) => [key, table.definition]),
        ),
      );
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        const table = tables.get(target.table);
        if (!table) throw new Error('Target table was not collected');
        expect(
          renderCollectedManifestTable(table, 'postgres').indexes.join('\n'),
        ).toContain('NULLS NOT DISTINCT');
      }
      if (name === 'assets') {
        expect(
          targets.find((target) => target.table === 'assets')?.columns,
        ).toEqual(['tenant_id', 'slug', 'context', '_meta_type']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
