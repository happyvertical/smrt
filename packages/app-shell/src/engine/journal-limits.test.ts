import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { assertJournalBounds, JOURNAL_LIMITS } from './data-migrations.ts';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';

it('bounds undo journals by rows and bytes with typed load-style errors', () => {
  expect(() =>
    assertJournalBounds(
      Array.from({ length: JOURNAL_LIMITS.rows }, () => ({})),
    ),
  ).not.toThrow();
  expect(() =>
    assertJournalBounds(
      Array.from({ length: JOURNAL_LIMITS.rows + 1 }, () => ({})),
    ),
  ).toThrowError(
    expect.objectContaining({
      code: 'invalid',
      message: expect.stringContaining('10000 rows'),
    }),
  );
  expect(() =>
    assertJournalBounds([{ text: 'é'.repeat(JOURNAL_LIMITS.bytes / 2) }]),
  ).toThrowError(
    expect.objectContaining({
      code: 'invalid',
      message: expect.stringContaining('bytes'),
    }),
  );
});

it.each([
  'extract',
  'merge',
] as const)('refuses oversized %s journals before changing rows or versions', async (kind) => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-limit-'));
  const host = await AppHost.open(dir, { store: new MemoryVersionStore() });
  const run = (cmd: Command) =>
    host.execute(cmd, { author: 't', approved: true });
  try {
    await run({
      type: 'defineModel',
      name: 'Vendor',
      fields: { name: { type: 'text' } },
    });
    const keep = await host.create('Vendor', { name: 'keep' });
    const other = await host.create('Vendor', { name: 'other' });
    await run({
      type: 'defineModel',
      name: 'Order',
      fields: {
        note: { type: 'text' },
        vendor:
          kind === 'extract'
            ? { type: 'text' }
            : { type: 'reference', ref: 'Vendor' },
      },
    });
    const db = new DatabaseSync(join(dir, 'app.db'));
    try {
      db.prepare(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?) INSERT INTO u_orders (id, slug, context, vendor) SELECT 'order-' || x, 'order-' || x, '', ? FROM n",
      ).run(
        JOURNAL_LIMITS.rows,
        kind === 'extract' ? 'Acme' : String(other.id),
      );
    } finally {
      db.close();
    }
    const version = host.version;
    const cmd: Command =
      kind === 'extract'
        ? {
            type: 'extractModel',
            model: 'Order',
            field: 'vendor',
            into: 'ExtractedVendor',
          }
        : {
            type: 'mergeRecords',
            model: 'Vendor',
            keep: String(keep.id),
            merge: [String(other.id)],
          };
    await expect(host.plan(cmd)).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('undo journal'),
    });
    await expect(run(cmd)).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('undo journal'),
    });
    expect(host.version).toBe(version);
    const check = new DatabaseSync(join(dir, 'app.db'));
    try {
      expect(
        check
          .prepare('SELECT COUNT(*) AS n FROM u_orders WHERE vendor = ?')
          .get(kind === 'extract' ? 'Acme' : String(other.id))?.n,
      ).toBe(JOURNAL_LIMITS.rows);
      expect(
        check
          .prepare(
            "SELECT COUNT(*) AS n FROM _archive WHERE col IN ('$row', '$after')",
          )
          .get()?.n,
      ).toBe(0);
      check.exec("DELETE FROM u_orders WHERE id <> 'order-1'");
      check
        .prepare('UPDATE u_orders SET note = ? WHERE id = ?')
        .run('x'.repeat(JOURNAL_LIMITS.bytes), 'order-1');
      if (kind === 'merge')
        check.prepare('UPDATE u_orders SET vendor = ?').run(String(other.id));
    } finally {
      check.close();
    }
    await expect(host.plan(cmd)).rejects.toThrow(/undo journal.*bytes/);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
