/**
 * #2760: data portability reads application tables from the build manifest;
 * a test-run manifest at `.smrt/manifest.json` lists inline test fixtures and
 * is refused rather than exported as phantom tables.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { manifestTables } from '../portability.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function app(manifest: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'smrt-2760-portability-'));
  roots.push(root);
  mkdirSync(join(root, '.smrt'));
  writeFileSync(join(root, '.smrt/manifest.json'), JSON.stringify(manifest));
  return root;
}

const convNote = {
  className: 'ConvNote',
  schema: { tableName: 'conv_notes', columns: { id: { type: 'TEXT' } } },
};

it('refuses a test-run manifest as the application table source', () => {
  const root = app({
    artifactPurpose: 'test',
    objects: { ConvNote: convNote },
  });
  expect(() => manifestTables(root)).toThrow(/test artifact/);
});

it('reads tables from a build manifest', () => {
  const root = app({ objects: { ConvNote: convNote } });
  expect(manifestTables(root).map((table) => table.name)).toContain(
    'conv_notes',
  );
});
