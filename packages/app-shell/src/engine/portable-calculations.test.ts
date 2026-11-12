// biome-ignore-all lint/suspicious/noThenProperty: SQL SDK conditionals require a non-callable then data property.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { expect, it } from 'vitest';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';

it('accepts every portable node through addField and setCalculation, including date inputs #4916', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portable-calcs-'));
  const store = new MemoryVersionStore();
  let host = await AppHost.open(dir, { store });
  const run = (cmd: Command) =>
    host.execute(cmd, { author: 'test', approved: true });
  try {
    await run({
      type: 'defineModel',
      name: 'Portable',
      fields: {
        unitPrice: { type: 'number' },
        paid: { type: 'boolean' },
        label: { type: 'text' },
        when: { type: 'date' },
      },
    });
    const row = await host.create('Portable', {
      unitPrice: 12.345,
      paid: false,
      label: ' AbC ',
      when: '2024-02-28',
    });
    const n = { col: 'unitPrice' },
      text = { col: 'label' };
    const date = { value: { kind: 'date', iso: '2024-02-28' } } as const;
    const next = { op: 'addDays', value: date, days: { value: 2 } } as const;
    const cases: [
      string,
      'integer' | 'number' | 'text',
      GeneratedExpression,
      unknown,
    ][] = [
      [
        'conditional',
        'number',
        { op: 'if', condition: { col: 'paid' }, then: { value: 0 }, else: n },
        12.345,
      ],
      [
        'branches',
        'number',
        {
          op: 'case',
          branches: [{ when: { col: 'paid' }, then: { value: 0 } }],
          else: n,
        },
        12.345,
      ],
      [
        'rounded',
        'number',
        { op: 'round', value: n, digits: { value: 2 } },
        12.35,
      ],
      ['absolute', 'number', { op: 'abs', value: n }, 12.345],
      ['floored', 'integer', { op: 'floor', value: n }, 12],
      ['ceiling', 'integer', { op: 'ceil', value: n }, 13],
      ['minimum', 'number', { op: 'least', operands: [n, { value: 10 }] }, 10],
      [
        'maximum',
        'number',
        { op: 'greatest', operands: [n, { value: 10 }] },
        12.345,
      ],
      [
        'remainder',
        'number',
        { op: 'mod', left: n, right: { value: 10 } },
        2.345,
      ],
      [
        'joined',
        'text',
        { op: 'concat', operands: [text, { value: "'$1" }] },
        " AbC '$1",
      ],
      ['lowered', 'text', { op: 'lower', value: text }, ' abc '],
      ['uppered', 'text', { op: 'upper', value: text }, ' ABC '],
      ['trimmed', 'text', { op: 'trim', value: text }, 'AbC'],
      ['size', 'integer', { op: 'length', value: text }, 5],
      [
        'part',
        'text',
        {
          op: 'substring',
          value: text,
          start: { value: 2 },
          length: { value: 2 },
        },
        'Ab',
      ],
      ['calendarYear', 'integer', { op: 'year', value: next }, 2024],
      ['calendarMonth', 'integer', { op: 'month', value: next }, 3],
      ['calendarDay', 'integer', { op: 'day', value: next }, 1],
      [
        'elapsedDays',
        'integer',
        { op: 'daysBetween', later: next, earlier: date },
        2,
      ],
      [
        'typedDatetime',
        'integer',
        {
          op: 'day',
          value: {
            value: { kind: 'datetime', iso: '2024-02-29T23:30:00-02:00' },
          },
        },
        1,
      ],
    ];

    cases.push([
      'inputDay',
      'integer',
      { op: 'day', value: { col: 'when' } },
      28,
    ]);
    for (const [field, type, calculated, expected] of cases) {
      await run({
        type: 'addField',
        model: 'Portable',
        field,
        definition: { type, calculated },
      });
      const added = (await host.get('Portable', String(row.id)))[field];
      if (typeof expected === 'number')
        expect(Number(added), field).toBeCloseTo(expected, 8);
      else expect(added, field).toBe(expected);
      await run({
        type: 'setCalculation',
        model: 'Portable',
        field,
        calculated,
      });
      expect(
        (await host.get('Portable', String(row.id)))[field],
        field,
      ).toEqual(added);
    }
    await run({
      type: 'addField',
      model: 'Portable',
      field: 'nextDate',
      definition: {
        type: 'date',
        calculated: {
          op: 'addDays',
          value: { col: 'when' },
          days: { value: 2 },
        },
      },
    });
    expect(
      String((await host.get('Portable', String(row.id))).nextDate),
    ).toContain('2024-03-01');
    await run({
      type: 'renameField',
      model: 'Portable',
      from: 'unitPrice',
      to: 'price',
    });
    await expect(
      host.plan({ type: 'hideField', model: 'Portable', field: 'price' }),
    ).rejects.toThrow(/calculated field/);
    expect((await host.get('Portable', String(row.id))).rounded).toBe(12.35);
    await host.update('Portable', String(row.id), { paid: true, price: 3.456 });
    const updated = await host.get('Portable', String(row.id));
    expect(updated.conditional).toBe(0);
    expect(updated.branches).toBe(0);
    expect(updated.rounded).toBe(3.46);
    await expect(
      host.update('Portable', String(row.id), { rounded: 0 }),
    ).rejects.toThrow(/read-only/);
    await host.close();
    host = await AppHost.open(dir, { store });
    expect((await host.get('Portable', String(row.id))).rounded).toBe(3.46);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
