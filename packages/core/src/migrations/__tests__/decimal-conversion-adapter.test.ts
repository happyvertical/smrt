/**
 * `convertJsonDecimalColumns()` converts the 4-byte decimal columns of
 * existing JSON-adapter tables to DOUBLE only when the result is durable and
 * checked (P5a, E9): the data file loaded, its rows and keys match the table,
 * and a fresh handle opened without schemas reads the table back widened.
 * Anything else is refused before a file is written.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { clearConnectionCache, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertJsonDecimalColumns } from '../json-decimal-conversion.js';

describe('convertJsonDecimalColumns', () => {
  let dir: string;
  let json: DatabaseInterface | undefined;

  const open = async () => {
    await json?.close?.();
    await clearConnectionCache();
    json = await getDatabase({
      type: 'json',
      url: dir,
      writeStrategy: 'immediate',
    } as never);
    return json;
  };
  const files = () =>
    ['conv_prices.json', 'conv_prices.schema.sql'].map((name) =>
      readFileSync(path.join(dir, name), 'utf8'),
    );
  const amountType = async (db: DatabaseInterface) =>
    String(
      (await db.getTableSchema?.('conv_prices'))?.columns?.amount?.type ?? '',
    ).toUpperCase();

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'smrt-decimal-convert-'));
    const db = await open();
    await db.query(
      'CREATE TABLE conv_prices (id TEXT PRIMARY KEY, amount REAL NOT NULL)',
    );
    await db.insert('conv_prices', { id: 'a', amount: 1.5 });
    await db.insert('conv_prices', { id: 'b', amount: 2.25 });
  });

  afterEach(async () => {
    await json?.close?.();
    json = undefined;
    await clearConnectionCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('converts JSON decimal columns only when rows, load errors and keys verify (happy path)', async () => {
    const db = await open();
    expect(await amountType(db)).toBe('FLOAT');
    const before = files();

    const dry = await convertJsonDecimalColumns(db, { dryRun: true });
    expect(dry).toEqual([
      { table: 'conv_prices', columns: ['amount'], outcome: 'would-convert' },
    ]);
    expect(files()).toEqual(before);

    const result = await convertJsonDecimalColumns(db);
    expect(result).toEqual([
      { table: 'conv_prices', columns: ['amount'], outcome: 'converted' },
    ]);

    // A later open without schemas replays the new definition.
    const reopened = await open();
    expect(await amountType(reopened)).toBe('DOUBLE');
    const rows = await reopened.query(
      'SELECT id, amount FROM conv_prices ORDER BY id',
    );
    expect(rows.rows.map((row) => [row.id, Number(row.amount)])).toEqual([
      ['a', 1.5],
      ['b', 2.25],
    ]);
    const schemaText = readFileSync(
      path.join(dir, 'conv_prices.schema.sql'),
      'utf8',
    );
    expect(schemaText).toMatch(/DOUBLE/i);
  });

  it('converts JSON decimal columns only when rows, load errors and keys verify (data file did not load)', async () => {
    await json?.close?.();
    // A row the table cannot hold: the load fails and the table opens empty.
    writeFileSync(
      path.join(dir, 'conv_prices.json'),
      JSON.stringify([
        { id: 'a', amount: 1.5 },
        { id: 'b', amount: null },
      ]),
    );
    const before = files();
    const db = await open();

    const result = await convertJsonDecimalColumns(db);

    expect(result).toHaveLength(1);
    expect(result[0]?.outcome).toBe('refused');
    expect(result[0]?.reason).toMatch(/did not load|rows/);
    expect(files()).toEqual(before);
  });

  it('converts JSON decimal columns only when rows, load errors and keys verify (operator-added key)', async () => {
    await json?.close?.();
    writeFileSync(
      path.join(dir, 'conv_prices.json'),
      JSON.stringify([
        { id: 'a', amount: 1.5, note: 'kept by hand' },
        { id: 'b', amount: 2.25, note: 'also' },
      ]),
    );
    const before = files();
    const db = await open();

    const result = await convertJsonDecimalColumns(db);

    expect(result).toHaveLength(1);
    expect(result[0]?.outcome).toBe('refused');
    expect(result[0]?.reason).toMatch(/note|rows|did not load/);
    expect(files()).toEqual(before);
  });

  it('refuses a transaction handle', async () => {
    const db = await open();
    await db.transaction?.(async (tx) => {
      await expect(convertJsonDecimalColumns(tx)).rejects.toThrow(
        'root handle',
      );
    });
  });
});
