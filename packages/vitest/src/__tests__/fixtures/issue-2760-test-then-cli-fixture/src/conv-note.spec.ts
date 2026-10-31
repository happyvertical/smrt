/**
 * #2760 probe: inline test fixtures keep working inside the run — the test
 * manifest describes `ConvNote` and a manifest test database builds its table
 * — and the run copies its snapshot out so the outer test can reproduce a
 * test manifest left at a production path by an older test runner.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import {
  createIsolatedTestDbFromManifest,
  getTestManifestPath,
} from '../../../../test-db.js';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
})
class ConvNote extends SmrtObject {
  @field({ required: true })
  text = '';
}

describe('issue #2760 inline fixture inside the run', () => {
  it('the run snapshot describes the inline fixture', () => {
    const snapshot = JSON.parse(readFileSync(getTestManifestPath(), 'utf8'));
    expect(snapshot.artifactPurpose).toBe('test');
    expect(
      Object.keys(snapshot.objects).some((key) => key.endsWith(':ConvNote')),
    ).toBe(true);
    copyFileSync(
      getTestManifestPath(),
      join(process.cwd(), '.smrt/captured-test-manifest.json'),
    );
  });

  it('a manifest test database builds the inline fixture table', async () => {
    expect(ConvNote.name).toBe('ConvNote');
    const { db, cleanup } = await createIsolatedTestDbFromManifest({
      includeObjects: ['ConvNote'],
    });
    try {
      const result = await db.query(
        `SELECT name FROM sqlite_master WHERE type='table'`,
      );
      // The database adapter's row envelope is generic at this SQL boundary.
      const rows = Array.isArray(result)
        ? result
        : (result as unknown as { rows: Array<{ name: string }> }).rows;
      expect(rows.map((row) => row.name)).toContain('conv_notes');
    } finally {
      await cleanup();
    }
  });
});
