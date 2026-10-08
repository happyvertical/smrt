import { describe, expect, it } from 'vitest';
import {
  currencyOptions,
  NON_CIRCULATING_CURRENCY_CODES,
} from '../code-select-options.js';

describe('currencyOptions', () => {
  const options = currencyOptions('en');
  const codes = options.map((option) => option.value);

  it('offers circulating currencies', () => {
    for (const code of ['USD', 'CAD', 'EUR', 'GBP', 'JPY', 'MXN', 'CLP']) {
      expect(codes).toContain(code);
    }
  });

  it('omits funds, metals, supranational and test codes', () => {
    for (const code of [
      'BOV',
      'CHE',
      'CHW',
      'CLF',
      'COU',
      'MXV',
      'USN',
      'UYI',
      'UYW',
      'XAU',
      'XAG',
      'XPD',
      'XPT',
      'XBA',
      'XBB',
      'XBC',
      'XBD',
      'XDR',
      'XSU',
      'XTS',
      'XUA',
      'XXX',
    ]) {
      expect(NON_CIRCULATING_CURRENCY_CODES.has(code)).toBe(true);
      expect(codes).not.toContain(code);
    }
  });

  it('never labels a code with only itself', () => {
    for (const option of options) {
      expect(option.label).not.toBe(`${option.value} — ${option.value}`);
    }
  });
});
