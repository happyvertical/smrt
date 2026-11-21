/**
 * #5505: an unbuilt workspace dependency is described by its checked-in
 * `src/manifest/manifest.json`. A field the scanner now infers as datetime
 * must be datetime there too, or its rows hydrate as strings and migration
 * sees no reason to convert the column.
 */
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
import { formatDataJs } from '../../utils.js';
import { ManifestManager } from '../manager.js';

describe('checked-in source manifest datetime fields (#5505)', () => {
  it('describes UserNotification.occurredAt as datetime with only the source manifest present', () => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-source-5505-'));
    try {
      const source = readFileSync(
        join(process.cwd(), '..', 'messages', 'src/manifest/manifest.json'),
        'utf8',
      );
      mkdirSync(join(root, 'src/manifest'), { recursive: true });
      writeFileSync(join(root, 'src/manifest/manifest.json'), source);
      const manifest = new ManifestManager(root).loadForExternalPackage();
      if (!manifest) throw new Error('Source manifest was not loaded');
      const notification =
        manifest.objects['@happyvertical/smrt-messages:UserNotification'];
      expect(notification?.fields.occurredAt?.type).toBe('datetime');
      expect(notification?.schema?.columns.occurred_at?.type).toBe('TIMESTAMP');
      expect(notification?.schema?.ddl).toContain('"occurred_at" TIMESTAMP');

      const row = formatDataJs<Record<string, unknown>>(
        { occurred_at: '2026-05-06T07:08:09.000Z' },
        notification?.fields as Record<string, { type?: string }>,
      );
      expect(row.occurredAt).toBeInstanceOf(Date);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
