import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { expect, it } from 'vitest';
import { formulaWords } from './formula.ts';

const fields = {
  q: { type: 'integer' as const, label: 'Quantity' },
  p: { type: 'money' as const, label: 'Price' },
};
const q = { col: 'q' },
  p = { col: 'p' };
it.each([
  ['add', '+'],
  ['sub', '−'],
  ['mul', '×'],
  ['div', '÷'],
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
