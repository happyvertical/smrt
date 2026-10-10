/**
 * RFC 4180 delimited-text parsing and formatting. Pure; no DOM.
 */

export class CsvParseError extends Error {
  readonly code: 'unterminated-quote' | 'too-many-rows' | 'empty';
  readonly line: number;
  constructor(
    code: 'unterminated-quote' | 'too-many-rows' | 'empty',
    line: number,
    message: string,
  ) {
    super(message);
    this.name = 'CsvParseError';
    this.code = code;
    this.line = line;
  }
}

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;

/** Strip a UTF-8 byte-order mark left by spreadsheet exports. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Pick the delimiter that occurs most often, outside quotes, on the first
 * non-empty line. Ties and empty input resolve to a comma.
 */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(
    CANDIDATE_DELIMITERS.map((d) => [d, 0]),
  );
  let inQuotes = false;
  let sawContent = false;
  for (const ch of stripBom(text)) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      sawContent = true;
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (sawContent) break;
    } else if (!inQuotes) {
      sawContent = true;
      const count = counts.get(ch);
      if (count !== undefined) counts.set(ch, count + 1);
    } else {
      sawContent = true;
    }
  }
  let best = ',';
  let bestCount = 0;
  for (const [delimiter, count] of counts) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

export interface ParseDelimitedOptions {
  /** Defaults to {@link detectDelimiter}. */
  delimiter?: string;
  /** Throw `too-many-rows` when the file holds more records than this (header included). */
  maxRecords?: number;
}

export interface ParsedRecords {
  delimiter: string;
  /** All non-blank records, header first. */
  records: string[][];
  /** 1-based file line each record starts on. */
  lines: number[];
}

/**
 * Parse delimited text into records. Handles quoted cells, doubled-quote
 * escapes, embedded delimiters and newlines, CR/LF/CRLF endings, and a BOM.
 * Blank lines are skipped. An unterminated quote is an error, never a
 * silently swallowed remainder of the file.
 */
export function parseDelimited(
  input: string,
  options: ParseDelimitedOptions = {},
): ParsedRecords {
  const text = stripBom(input);
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const records: string[][] = [];
  const lines: number[] = [];

  let record: string[] = [];
  let cell = '';
  let inQuotes = false;
  let cellQuoted = false;
  let recordQuoted = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;

  const finishCell = () => {
    record.push(cell);
    cell = '';
    cellQuoted = false;
  };
  const finishRecord = () => {
    finishCell();
    // A line with no cells and no quoted cell is blank; skip it.
    const blank = record.length === 1 && record[0] === '' && !recordQuoted;
    if (!blank) {
      if (
        options.maxRecords !== undefined &&
        records.length >= options.maxRecords
      ) {
        throw new CsvParseError(
          'too-many-rows',
          recordLine,
          `File has more than ${options.maxRecords} records`,
        );
      }
      records.push(record);
      lines.push(recordLine);
    }
    record = [];
    recordQuoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '' && !cellQuoted) {
      inQuotes = true;
      cellQuoted = true;
      recordQuoted = true;
      quoteLine = line;
    } else if (ch === delimiter) {
      finishCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      finishRecord();
      line++;
      recordLine = line;
    } else {
      cell += ch;
    }
  }

  if (inQuotes) {
    throw new CsvParseError(
      'unterminated-quote',
      quoteLine,
      `Unterminated quoted cell starting on line ${quoteLine}`,
    );
  }
  if (cell !== '' || record.length > 0 || cellQuoted) finishRecord();

  return { delimiter, records, lines };
}

/**
 * Parse a file into a header row and data rows. Throws `empty` when the file
 * has no header.
 */
export function parseTable(
  input: string,
  options: ParseDelimitedOptions = {},
): { delimiter: string; headers: string[]; rows: string[][]; lines: number[] } {
  const { delimiter, records, lines } = parseDelimited(input, options);
  if (records.length === 0) {
    throw new CsvParseError('empty', 1, 'File is empty');
  }
  return {
    delimiter,
    headers: records[0].map((h) => h.trim()),
    rows: records.slice(1),
    lines: lines.slice(1),
  };
}

export interface FormatDelimitedOptions {
  delimiter?: string;
  eol?: string;
}

function quoteCell(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.startsWith(' ') ||
    value.endsWith(' ');
  return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serialize string cells to delimited text (no trailing newline). */
export function formatDelimited(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  options: FormatDelimitedOptions = {},
): string {
  const delimiter = options.delimiter ?? ',';
  const eol = options.eol ?? '\r\n';
  return rows
    .map((row) =>
      // A lone empty cell is quoted so the line is not read back as blank.
      row.length === 1 && row[0] === ''
        ? '""'
        : row.map((cell) => quoteCell(cell, delimiter)).join(delimiter),
    )
    .join(eol);
}

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Defuse spreadsheet formula injection: a text cell starting with `= + - @`,
 * a tab, or a CR is prefixed with an apostrophe so Excel/Sheets show it as
 * text. Never apply to numeric cells.
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** Inverse of {@link neutralizeFormula}, applied to text cells on import. */
export function restoreNeutralized(value: string): string {
  return value.startsWith("'") && FORMULA_TRIGGER.test(value.slice(1))
    ? value.slice(1)
    : value;
}
