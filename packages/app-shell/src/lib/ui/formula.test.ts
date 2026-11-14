// biome-ignore-all lint/suspicious/noThenProperty: SQL SDK conditionals require a non-callable then data property.
import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { expect, it } from 'vitest';
import { formulaWords } from './formula.ts';

const fields = {
  q: { type: 'integer' as const, label: 'Quantity' },
  p: { type: 'money' as const, label: 'Price' },
  paid: { type: 'boolean' as const, label: 'Paid' },
};
const q = { col: 'q' },
  p = { col: 'p' };
it.each([
  ['add', '+'],
  ['sub', '−'],
  ['mul', '×'],
  ['div', '÷'],
  ['mod', 'remainder after dividing by'],
  ['eq', 'equals'],
  ['ne', 'does not equal'],
  ['lt', 'is less than'],
  ['lte', 'is at most'],
  ['gt', 'is greater than'],
  ['gte', 'is at least'],
])('words for %s', (op, symbol) => {
  expect(
    formulaWords({ op, left: q, right: p } as GeneratedExpression, fields),
  ).toBe(`Quantity ${symbol} Price`);
});
it.each([
  [{ col: 'q' }, 'Quantity'],
  [{ col: 'gone' }, 'Removed field'],
  [{ value: null }, 'nothing'],
  [{ value: true }, 'Yes'],
  [{ value: false }, 'No'],
  [{ value: 'text' }, 'text'],
  [{ value: 3 }, '3'],
  [{ op: 'and', operands: [q, p] }, 'Quantity and Price'],
  [{ op: 'or', operands: [q, p] }, 'Quantity or Price'],
  [{ op: 'coalesce', operands: [q, p] }, 'First available of Quantity, Price'],
  [{ op: 'not', operand: q }, 'Not Quantity'],
  [{ op: 'isNull', operand: q }, 'Quantity is empty'],
  [{ op: 'isNotNull', operand: q }, 'Quantity is not empty'],
  [{ op: 'asText', operand: q }, 'Quantity as text'],
  [
    { op: 'secondsBetween', earlier: q, later: p },
    'Seconds from Quantity to Price',
  ],
  [
    { op: 'mul', left: { op: 'add', left: q, right: { value: 1 } }, right: p },
    '(Quantity + 1) × Price',
  ],
] as [
  GeneratedExpression,
  string,
][])('renders every expression shape: %s', (expression, expected) =>
  expect(formulaWords(expression, fields)).toBe(expected));

it.each([
  [
    {
      op: 'if',
      condition: { col: 'paid' },
      then: { value: 0 },
      else: { op: 'mul', left: q, right: p },
    },
    'if Paid then 0, otherwise Quantity × Price',
  ],
  [
    {
      op: 'case',
      branches: [
        { when: { col: 'paid' }, then: { value: 0 } },
        { when: { value: false }, then: q },
      ],
      else: p,
    },
    'if Paid then 0, otherwise if No then Quantity, otherwise Price',
  ],
  [
    { op: 'round', value: p, digits: { value: 2 } },
    'Price rounded to 2 places',
  ],
  [{ op: 'abs', value: p }, 'Absolute value of Price'],
  [{ op: 'floor', value: p }, 'Price rounded down'],
  [{ op: 'ceil', value: p }, 'Price rounded up'],
  [{ op: 'least', operands: [q, p] }, 'Least of Quantity, Price'],
  [{ op: 'greatest', operands: [q, p] }, 'Greatest of Quantity, Price'],
  [{ op: 'concat', operands: [q, p] }, 'Join Quantity, Price'],
  [{ op: 'lower', value: p }, 'Price in lowercase'],
  [{ op: 'upper', value: p }, 'Price in uppercase'],
  [{ op: 'trim', value: p }, 'Price without surrounding spaces'],
  [{ op: 'length', value: p }, 'Length of Price'],
  [
    { op: 'substring', value: p, start: { value: 2 }, length: { value: 3 } },
    'Price from character 2 for 3 characters',
  ],
  [{ op: 'year', value: p }, 'Year of Price'],
  [{ op: 'month', value: p }, 'Month of Price'],
  [{ op: 'day', value: p }, 'Day of Price'],
  [{ op: 'daysBetween', later: p, earlier: q }, 'Days from Quantity to Price'],
  [{ op: 'addDays', value: q, days: { value: 2 } }, 'Quantity plus 2 days'],
  [{ value: { kind: 'date', iso: '2024-02-29' } }, '2024-02-29'],
  [
    { value: { kind: 'datetime', iso: '2024-02-29T00:00:00Z' } },
    '2024-02-29T00:00:00Z',
  ],
] as [
  GeneratedExpression,
  string,
][])('describes new SDK expression %j', (node, expected) => {
  expect(formulaWords(node, fields)).toBe(expected);
});
