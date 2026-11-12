import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { expect, it } from 'vitest';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';

it('defines, writes, updates, lists, bulk-loads, reports and calculates keyword fields #4917', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keywords-4917-'));
  const host = await AppHost.open(dir, { store: new MemoryVersionStore() });
  const run = (cmd: Command) =>
    host.execute(cmd, { author: 'test', approved: true });
  const names = [
    'order',
    'group',
    'from',
    'to',
    'select',
    'index',
    'check',
    'values',
  ];
  const values = (offset: number) =>
    Object.fromEntries(names.map((name, i) => [name, i + offset]));
  try {
    await run({
      type: 'defineModel',
      name: 'Keyword',
      fields: Object.fromEntries(
        names.map((name) => [name, { type: 'integer' }]),
      ),
    });
    const first = await host.create('Keyword', values(1));
    expect(first).toMatchObject(values(1));
    await host.update('Keyword', String(first.id), values(10));
    expect(await host.get('Keyword', String(first.id))).toMatchObject(
      values(10),
    );
    expect(await host.list('Keyword')).toEqual([
      expect.objectContaining(values(10)),
    ]);
    await run({
      type: 'loadRecords',
      model: 'Keyword',
      mode: 'insert',
      rows: [values(20), values(30)],
    });
    await run({
      type: 'loadRecords',
      model: 'Keyword',
      mode: 'upsert',
      key: ['order'],
      rows: [{ ...values(20), group: 99 }],
    });
    expect(await host.list('Keyword')).toHaveLength(3);
    for (const name of names) {
      const report = await host.runReport(
        parseRuntimeReportSpec({
          version: 1,
          title: name,
          source: 'Keyword',
          dimensions: [{ field: name, as: 'category' }],
          measures: [{ fn: 'sum', field: name, as: 'total' }],
        }),
      );
      expect(report.rowCount, name).toBe(3);
      expect(
        report.rows.map((row) => Number(row.total)).sort((a, b) => a - b),
      ).toEqual(
        [
          values(10)[name],
          name === 'group' ? 99 : values(20)[name],
          values(30)[name],
        ].sort((a, b) => a - b),
      );
    }
    const calculated = names
      .map((col): GeneratedExpression => ({ col }))
      .reduce<GeneratedExpression>(
        (left, right) => ({ op: 'add', left, right }),
        { value: 0 },
      );
    await run({
      type: 'addField',
      model: 'Keyword',
      field: 'total',
      definition: { type: 'integer', calculated },
    });
    expect((await host.get('Keyword', String(first.id))).total).toBe(108);
    await host.update('Keyword', String(first.id), { order: 100 });
    expect((await host.get('Keyword', String(first.id))).total).toBe(198);
    await expect(host.create('Keyword', { total: 0 })).rejects.toThrow(
      /read-only/,
    );
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
