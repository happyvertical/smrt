// biome-ignore-all lint/suspicious/noThenProperty: SQL SDK conditionals require a non-callable then data property.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';

/**
 * Each addField / setCalculation is an engine worker swap (a new worker thread
 * boots per command, about 200 ms uncontended, several times that on a shared
 * CI runner). Forty-one swaps in one `it` approached the 60 s budget under
 * load (#5682), so every portable node is its own test over one shared host:
 * the budget applies per node, and the cases still run in order because the
 * tail tests read fields the cases add.
 */
describe('accepts every portable node through addField and setCalculation, with date-only literals #4916', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portable-calcs-'));
  const store = new MemoryVersionStore();
  let host: AppHost;
  let row: Record<string, unknown>;
  const run = (cmd: Command) =>
    host.execute(hostOwner(host), cmd, { author: 'test', approved: true });

  beforeAll(async () => {
    host = await AppHost.open(dir, { store });
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
    row = await host.create(hostOwner(host), 'Portable', {
      unitPrice: 12.345,
      paid: false,
      label: ' AbC ',
      when: '2024-02-28',
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
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
    [
      'emptyDuration',
      'number',
      {
        op: 'secondsBetween',
        later: { value: null },
        earlier: { value: null },
      },
      null,
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
  ];

  it.each(cases)('%s', async (field, type, calculated, expected) => {
    await run({
      type: 'addField',
      model: 'Portable',
      field,
      definition: { type, calculated },
    });
    const added = (await host.get(hostOwner(host), 'Portable', String(row.id)))[
      field
    ];
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
      (await host.get(hostOwner(host), 'Portable', String(row.id)))[field],
      field,
    ).toEqual(added);
  });

  it('rejects datetime literals, protects calculated fields, and survives a restart', async () => {
    await expect(
      host.plan({
        type: 'addField',
        model: 'Portable',
        field: 'datetimeLiteral',
        definition: {
          type: 'integer',
          calculated: {
            op: 'day',
            value: { value: { kind: 'datetime', iso: '2024-02-29T00:00:00Z' } },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('sdk#1516'),
    });
    await run({
      type: 'renameField',
      model: 'Portable',
      from: 'unitPrice',
      to: 'price',
    });
    await expect(
      host.plan({ type: 'hideField', model: 'Portable', field: 'price' }),
    ).rejects.toThrow(/calculated field/);
    expect(
      (await host.get(hostOwner(host), 'Portable', String(row.id))).rounded,
    ).toBe(12.35);
    await host.update(hostOwner(host), 'Portable', String(row.id), {
      paid: true,
      price: 3.456,
    });
    const updated = await host.get(hostOwner(host), 'Portable', String(row.id));
    expect(updated.conditional).toBe(0);
    expect(updated.branches).toBe(0);
    expect(updated.rounded).toBe(3.46);
    await expect(
      host.update(hostOwner(host), 'Portable', String(row.id), { rounded: 0 }),
    ).rejects.toThrow(/read-only/);
    await host.close();
    host = await AppHost.open(dir, { store });
    expect(
      (await host.get(hostOwner(host), 'Portable', String(row.id))).rounded,
    ).toBe(3.46);
  });
});
