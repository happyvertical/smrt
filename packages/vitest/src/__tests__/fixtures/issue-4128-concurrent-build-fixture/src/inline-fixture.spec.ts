/**
 * Issue #4128 probe. `Gadget` is an inline test-file fixture: only the test
 * manifest snapshot describes it. A production rewrite of
 * `.smrt/manifest.json` has already happened (see
 * `concurrent-build.global-setup.ts`); every manifest read in this worker
 * must still resolve the run's own snapshot.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  field,
  ManifestManager,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import {
  createIsolatedTestDbFromManifest,
  getTestManifestPath,
} from '../../../../test-db.js';

@smrt({ api: false, mcp: false, cli: false })
class Gadget extends SmrtObject {
  @field({ required: true })
  label = '';
}

const objectNames = (manifest: { objects?: Record<string, unknown> } | null) =>
  Object.keys(manifest?.objects ?? {}).map((key) => key.split(':').pop());

describe('issue #4128 test manifest isolation probe', () => {
  it('the production working copy was rewritten without the inline fixture', () => {
    const production = JSON.parse(
      readFileSync(join(process.cwd(), '.smrt/manifest.json'), 'utf8'),
    );
    expect(production.producedBy).toBe('issue-4128-concurrent-build');
    expect(objectNames(production)).not.toContain('Gadget');
  });

  it('the run snapshot still carries the inline fixture and the production model', () => {
    const snapshotPath = getTestManifestPath();
    expect(snapshotPath).not.toBe(join(process.cwd(), '.smrt/manifest.json'));
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    expect(snapshot.artifactPurpose).toBe('test');
    expect(objectNames(snapshot)).toEqual(
      expect.arrayContaining(['Gadget', 'Widget']),
    );
  });

  it('local manifest loading resolves the snapshot, not the rewritten working copy', () => {
    const local = new ManifestManager(process.cwd()).loadLocal();
    expect(objectNames(local)).toContain('Gadget');
  });

  it('a manifest test database still builds the inline fixture table', async () => {
    expect(Gadget.name).toBe('Gadget');
    const { db, cleanup } = await createIsolatedTestDbFromManifest({
      includeObjects: ['Gadget'],
    });
    try {
      const result = await db.query(
        `SELECT name FROM sqlite_master WHERE type='table'`,
      );
      // The database adapter's row envelope is generic at this SQL boundary.
      const rows = Array.isArray(result)
        ? result
        : (result as unknown as { rows: Array<{ name: string }> }).rows;
      expect(rows.map((row) => row.name)).toContain('gadgets');
    } finally {
      await cleanup();
    }
  });
});
