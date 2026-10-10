import { describe, expect, it } from 'vitest';
import {
  foldForMatch,
  highlightSegments,
  matchItem,
  matchText,
  queryTerms,
} from '../match.js';

describe('command palette matching', () => {
  it('folds case and accents', () => {
    expect(foldForMatch('Café Ñandú')).toBe('cafe nandu');
    expect(matchText('cafe', 'Café Rouge')?.ranges).toEqual([[0, 4]]);
  });

  it('splits and de-duplicates terms', () => {
    expect(queryTerms('  New  new invoice ')).toEqual(['new', 'invoice']);
    expect(queryTerms('   ')).toEqual([]);
  });

  it('matches everything for an empty query', () => {
    expect(matchText('', 'Anything')).toEqual({ score: 0, ranges: [] });
  });

  it('requires every term and reports title ranges', () => {
    const match = matchText('new inv', 'New invoice');
    expect(match?.ranges).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(matchText('new zebra', 'New invoice')).toBeNull();
  });

  it('ranks exact > prefix > word start > inside a word', () => {
    const score = (text: string) => matchText('inv', text)?.score ?? -Infinity;
    expect(matchText('invoice', 'Invoice')?.score).toBeGreaterThan(
      score('Invoice'),
    );
    expect(score('Invoice')).toBeGreaterThan(score('New invoice'));
    expect(score('New invoice')).toBeGreaterThan(score('Reinvent'));
  });

  it('prefers the shorter of two equal matches', () => {
    expect(matchText('sale', 'Sales')?.score).toBeGreaterThan(
      matchText('sale', 'Sales and marketing overview')?.score ?? 0,
    );
  });

  it('falls back to in-order matches over compact spans', () => {
    const match = matchText('nwinv', 'New Invoice');
    expect(match).not.toBeNull();
    expect(match?.ranges.length).toBeGreaterThan(1);
    // Sparse spans do not count as a match.
    expect(matchText('az', 'abcdefghijklmnopqrstuvwxyz')).toBeNull();
    // One character never fuzzy-matches.
    expect(matchText('z', 'abc')).toBeNull();
  });

  it('maps ranges back through folding that changes length', () => {
    const match = matchText('i', 'İstanbul');
    expect(match).not.toBeNull();
    const [start, end] = match?.ranges[0] ?? [0, 0];
    expect('İstanbul'.slice(start, end)).toBe('İ');
  });

  it('lets an item match on subtitle and keywords at half weight', () => {
    const item = {
      id: 'a',
      title: 'Billing',
      subtitle: 'Finance',
      keywords: ['invoices'],
    };
    const viaKeyword = matchItem('invoices', item);
    expect(viaKeyword).not.toBeNull();
    expect(viaKeyword?.titleRanges).toEqual([]);
    expect(matchItem('billing finance', item)?.titleRanges).toEqual([[0, 7]]);
    expect(matchItem('zebra', item)).toBeNull();
    expect(matchItem('', item)).toEqual({ score: 0, titleRanges: [] });
    expect(matchItem('billing', item)?.score).toBeGreaterThan(
      viaKeyword?.score ?? 0,
    );
  });

  it('splits text into highlight segments', () => {
    expect(
      highlightSegments('New invoice', [
        [0, 3],
        [4, 7],
      ]),
    ).toEqual([
      { text: 'New', match: true },
      { text: ' ', match: false },
      { text: 'inv', match: true },
      { text: 'oice', match: false },
    ]);
    expect(highlightSegments('Plain', [])).toEqual([
      { text: 'Plain', match: false },
    ]);
  });
});
