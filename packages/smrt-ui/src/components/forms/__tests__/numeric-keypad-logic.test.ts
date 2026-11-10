import { describe, expect, it } from 'vitest';
import {
  applyKey,
  type EntryRules,
  exceedsMax,
  type KeypadKey,
  keyFromKeyboard,
  minorUnitExponent,
  minorUnitsToText,
  normalizeText,
  parseEntry,
  textToMinorUnits,
  validateEntry,
} from '../numeric-keypad-logic.js';

const money: EntryRules = { maxDecimals: 2, maxLength: 12 };
const whole: EntryRules = { maxDecimals: 0, maxLength: 12 };
const digit = (d: string): KeypadKey => ({ kind: 'digit', digit: d });
const type = (keys: string, rules: EntryRules, from = ''): string =>
  [...keys].reduce(
    (text, k) =>
      applyKey(
        text,
        k === '.'
          ? { kind: 'decimal' }
          : k === '<'
            ? { kind: 'backspace' }
            : digit(k),
        rules,
      ),
    from,
  );

describe('applyKey', () => {
  it('appends digits', () => {
    expect(type('1205', whole)).toBe('1205');
  });
  it('replaces a lone leading zero and keeps a single zero', () => {
    expect(type('05', whole)).toBe('5');
    expect(type('000', whole)).toBe('0');
  });
  it('starts a decimal with 0.', () => {
    expect(type('.5', money)).toBe('0.5');
  });
  it('accepts one decimal point only', () => {
    expect(type('1.2.3', money)).toBe('1.23');
  });
  it('refuses the point in integer mode', () => {
    expect(type('1.5', whole)).toBe('15');
  });
  it('stops at maxDecimals', () => {
    expect(type('1.234', money)).toBe('1.23');
  });
  it('stops at maxLength, counting the point', () => {
    const rules = { maxDecimals: 2, maxLength: 4 };
    expect(type('12345', rules)).toBe('1234');
    expect(type('123.', rules)).toBe('123.');
    expect(applyKey('1234', { kind: 'decimal' }, rules)).toBe('1234');
    expect(applyKey('123.', digit('4'), rules)).toBe('123.');
  });
  it('backspace trims, including the point, and tolerates empty', () => {
    expect(type('1.5<<', money)).toBe('1');
    expect(type('<', money)).toBe('');
  });
  it('clear empties', () => {
    expect(applyKey('12.5', { kind: 'clear' }, money)).toBe('');
  });
  it('ignores a non-digit', () => {
    expect(applyKey('1', digit('a'), money)).toBe('1');
    expect(applyKey('1', digit('12'), money)).toBe('1');
  });
});

describe('keyFromKeyboard', () => {
  it('maps digits, both decimal separators, backspace and delete', () => {
    expect(keyFromKeyboard('7')).toEqual(digit('7'));
    expect(keyFromKeyboard('.')).toEqual({ kind: 'decimal' });
    expect(keyFromKeyboard(',')).toEqual({ kind: 'decimal' });
    expect(keyFromKeyboard('Backspace')).toEqual({ kind: 'backspace' });
    expect(keyFromKeyboard('Delete')).toEqual({ kind: 'clear' });
  });
  it('leaves everything else alone', () => {
    expect(keyFromKeyboard('Enter')).toBeNull();
    expect(keyFromKeyboard('a')).toBeNull();
    expect(keyFromKeyboard('10')).toBeNull();
  });
});

describe('normalizeText', () => {
  it('accepts numbers and strings', () => {
    expect(normalizeText(12.5, money)).toBe('12.5');
    expect(normalizeText('7', whole)).toBe('7');
    expect(normalizeText('3,5', money)).toBe('3.5');
  });
  it('drops junk, negatives, exponent forms and empties', () => {
    expect(normalizeText('abc', money)).toBe('');
    expect(normalizeText(-1, money)).toBe('');
    expect(normalizeText(1e21, money)).toBe('');
    expect(normalizeText(Number.NaN, money)).toBe('');
    expect(normalizeText(null, money)).toBe('');
    expect(normalizeText(undefined, money)).toBe('');
  });
  it('strips leading zeros and trims decimals to the rules', () => {
    expect(normalizeText('007', whole)).toBe('7');
    expect(normalizeText('.5', money)).toBe('0.5');
    expect(normalizeText('1.239', money)).toBe('1.23');
    expect(normalizeText('1.5', whole)).toBe('1');
  });
  it('rejects text longer than maxLength', () => {
    expect(normalizeText('1234567890123', money)).toBe('');
  });
});

describe('parseEntry and validateEntry', () => {
  it('parses', () => {
    expect(parseEntry('')).toBeNull();
    expect(parseEntry('.')).toBeNull();
    expect(parseEntry('12.')).toBe(12);
    expect(parseEntry('0.5')).toBe(0.5);
  });
  it('classifies against min and max', () => {
    expect(validateEntry('', {})).toBe('empty');
    expect(validateEntry('5', { min: 1, max: 10 })).toBe('ok');
    expect(validateEntry('0', { min: 1 })).toBe('below');
    expect(validateEntry('11', { max: 10 })).toBe('above');
    expect(validateEntry('10', { max: 10 })).toBe('ok');
    expect(validateEntry('1-2', {})).toBe('invalid');
  });
  it('exceedsMax', () => {
    expect(exceedsMax('11', 10)).toBe(true);
    expect(exceedsMax('10', 10)).toBe(false);
    expect(exceedsMax('11', undefined)).toBe(false);
    expect(exceedsMax('', 10)).toBe(false);
  });
});

describe('minor units', () => {
  it('looks up the exponent', () => {
    expect(minorUnitExponent('USD')).toBe(2);
    expect(minorUnitExponent('jpy')).toBe(0);
    expect(minorUnitExponent('KWD')).toBe(3);
    expect(minorUnitExponent('XAU')).toBe(0);
    expect(minorUnitExponent(undefined)).toBe(2);
    expect(minorUnitExponent('???')).toBe(2);
    expect(minorUnitExponent('???', 0)).toBe(0);
  });
  it('converts text to integers without floats', () => {
    expect(textToMinorUnits('12.5', 2)).toBe(1250);
    expect(textToMinorUnits('0.1', 2)).toBe(10);
    expect(textToMinorUnits('0.07', 2)).toBe(7);
    expect(textToMinorUnits('19.99', 2)).toBe(1999);
    expect(textToMinorUnits('1.005', 3)).toBe(1005);
    expect(textToMinorUnits('12.', 2)).toBe(1200);
    expect(textToMinorUnits('12', 0)).toBe(12);
    expect(textToMinorUnits('0', 2)).toBe(0);
  });
  it('refuses what is not an exact amount', () => {
    expect(textToMinorUnits('', 2)).toBeNull();
    expect(textToMinorUnits('.', 2)).toBeNull();
    expect(textToMinorUnits('1.234', 2)).toBeNull();
    expect(textToMinorUnits('1.5', 0)).toBeNull();
    expect(textToMinorUnits('x', 2)).toBeNull();
    expect(textToMinorUnits('9007199254740993', 0)).toBeNull();
    expect(textToMinorUnits('1', -1)).toBeNull();
  });
  it('converts integers to text', () => {
    expect(minorUnitsToText(1250, 2)).toBe('12.5');
    expect(minorUnitsToText(1250, 2, { trim: false })).toBe('12.50');
    expect(minorUnitsToText(5, 2)).toBe('0.05');
    expect(minorUnitsToText(0, 2)).toBe('0');
    expect(minorUnitsToText(1200, 2)).toBe('12');
    expect(minorUnitsToText(1200, 0)).toBe('1200');
    expect(minorUnitsToText(1005, 3)).toBe('1.005');
  });
  it('refuses non-integers, negatives and unsafe amounts', () => {
    expect(minorUnitsToText(1.5, 2)).toBeNull();
    expect(minorUnitsToText(-1, 2)).toBeNull();
    expect(minorUnitsToText(2 ** 53, 2)).toBeNull();
  });
  it('round-trips every amount in a range', () => {
    for (let minor = 0; minor < 2000; minor += 7) {
      const text = minorUnitsToText(minor, 2) as string;
      expect(textToMinorUnits(text, 2)).toBe(minor);
    }
  });
});
