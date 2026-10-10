import { describe, expect, it } from 'vitest';
import {
  CsvParseError,
  detectDelimiter,
  formatDelimited,
  neutralizeFormula,
  parseDelimited,
  parseTable,
  restoreNeutralized,
} from '../csv.js';

describe('parseDelimited', () => {
  it('parses plain rows with LF, CRLF and CR endings', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const { records } = parseDelimited(`a,b${eol}1,2${eol}`);
      expect(records).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    }
  });

  it('handles quoted delimiters, doubled quotes and embedded newlines', () => {
    const { records, lines } = parseDelimited(
      'name,note\n"Smith, J","said ""hi"""\n"two\nlines",x\nlast,y',
    );
    expect(records).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"'],
      ['two\nlines', 'x'],
      ['last', 'y'],
    ]);
    // Record starts, counting the newline inside the quoted cell.
    expect(lines).toEqual([1, 2, 3, 5]);
  });

  it('strips a BOM and skips blank lines but keeps quoted empties', () => {
    const { records } = parseDelimited('﻿a,b\n\n1,2\n\n"",\n');
    expect(records).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['', ''],
    ]);
  });

  it('keeps a lone quoted empty cell as a record', () => {
    expect(parseDelimited('h\n""\n').records).toEqual([['h'], ['']]);
  });

  it('keeps trailing empty cells', () => {
    expect(parseDelimited('a,b,c\n1,,\n').records[1]).toEqual(['1', '', '']);
  });

  it('treats a quote inside an unquoted cell literally', () => {
    expect(parseDelimited('a"b,c\n').records[0]).toEqual(['a"b', 'c']);
  });

  it('fails loudly on an unterminated quote with its start line', () => {
    expect(() => parseDelimited('a,b\n1,"oops\n2,3\n')).toThrowError(
      expect.objectContaining({ code: 'unterminated-quote', line: 2 }),
    );
  });

  it('enforces maxRecords', () => {
    expect(() =>
      parseDelimited('a\n1\n2\n3\n', { maxRecords: 3 }),
    ).toThrowError(expect.objectContaining({ code: 'too-many-rows' }));
    expect(parseDelimited('a\n1\n2\n', { maxRecords: 3 }).records).toHaveLength(
      3,
    );
  });
});

describe('detectDelimiter', () => {
  it('prefers the most frequent candidate outside quotes', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('"a,b,c";d\n')).toBe(';');
    expect(detectDelimiter('single')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });
});

describe('parseTable', () => {
  it('splits header and data and trims headers', () => {
    const t = parseTable('﻿ Name ;Age\nAda;36\n');
    expect(t.delimiter).toBe(';');
    expect(t.headers).toEqual(['Name', 'Age']);
    expect(t.rows).toEqual([['Ada', '36']]);
    expect(t.lines).toEqual([2]);
  });

  it('rejects an empty file', () => {
    expect(() => parseTable('')).toThrow(CsvParseError);
    expect(() => parseTable('\n\n')).toThrow(CsvParseError);
  });
});

describe('formatDelimited', () => {
  it('quotes only when needed and round-trips', () => {
    const rows = [
      ['a', 'b,c', 'say "x"', ' pad', 'line\nbreak', ''],
      ['', '', '', '', '', ''],
    ];
    const text = formatDelimited(rows);
    expect(text.split('\r\n')[0]).toBe(
      'a,"b,c","say ""x""", pad,"line\nbreak",'.replace(' pad', '" pad"'),
    );
    expect(parseDelimited(text, { delimiter: ',' }).records).toEqual(rows);
  });

  it('writes a lone empty cell quoted so it survives the blank-line skip', () => {
    const text = formatDelimited([['h'], ['']]);
    expect(parseDelimited(text).records).toEqual([['h'], ['']]);
  });

  it('honors a tab delimiter', () => {
    expect(formatDelimited([['a', 'b\tc']], { delimiter: '\t' })).toBe(
      'a\t"b\tc"',
    );
  });
});

describe('formula neutralization', () => {
  it('prefixes cells a spreadsheet would evaluate and restores them', () => {
    for (const cell of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) {
      const safe = neutralizeFormula(cell);
      expect(safe).toBe(`'${cell}`);
      expect(restoreNeutralized(safe)).toBe(cell);
    }
    expect(neutralizeFormula('plain')).toBe('plain');
    expect(restoreNeutralized("'quoted but safe")).toBe("'quoted but safe");
  });
});
