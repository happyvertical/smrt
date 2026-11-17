import { expect, it } from 'vitest';
import { previewCell, previewType } from './import.ts';

it('names preview column types in plain words', () => {
  expect(previewType({ type: 'integer' })).toBe('whole number');
  expect(previewType({ type: 'boolean' })).toBe('yes or no');
  expect(previewType({ type: 'text' })).toBe('text');
  expect(previewType({ type: 'money', money: { currency: 'CAD' } })).toBe(
    'money · CAD',
  );
  expect(previewType({ type: 'reference' })).toBe('link');
});
it('formats preview cells', () => {
  expect(previewCell(true, { type: 'boolean' })).toBe('Yes');
  expect(previewCell(null, { type: 'text' })).toBe('');
  expect(previewCell('2026-01-02T00:00:00Z', { type: 'date' })).toBe(
    '2026-01-02',
  );
  expect(
    previewCell(1750, { type: 'money', money: { currency: 'CAD', scale: 2 } }),
  ).toBe('17.50 CAD');
  expect(
    previewCell(-5, { type: 'money', money: { currency: 'CAD', scale: 2 } }),
  ).toBe('-0.05 CAD');
});
