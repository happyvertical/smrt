import { describe, expect, it } from 'vitest';
import { encodeCatalogSearch } from '../catalog-search';

describe('catalog search storage', () => {
  it('preserves JavaScript UTF-16 substring matches without SQL collation', () => {
    const corpus = [
      'K É İ ΣΟΣ',
      'raw  refined',
      'a\u0000b',
      '😀',
      '\ud800',
      'a%b_c\\d',
      '\u1234\u5678',
    ];
    const queries = [
      'k',
      'é',
      'i\u0307',
      'σος',
      '  ',
      'raw ',
      '\u0000',
      '\ud83d',
      '\ude00',
      '\ud800',
      '%',
      '_',
      '\\',
      '\u2345',
      '',
    ];
    for (const value of corpus) {
      for (const query of queries) {
        expect(
          encodeCatalogSearch(value).includes(encodeCatalogSearch(query)),
        ).toBe(value.toLowerCase().includes(query.toLowerCase()));
      }
    }
  });
});
