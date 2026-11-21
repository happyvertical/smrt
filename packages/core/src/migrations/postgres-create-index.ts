/**
 * Reading PostgreSQL index statements the way the server reads them. Internal
 * to core: the statement planner routes and rewrites index DDL by it, the
 * unique-index swap pairs drops and creates by it, and the tracker's
 * interrupted-index repair and post-create check act on the database by it.
 * So nothing here guesses: whatever cannot be read with certainty is
 * `unreadable`, and callers leave the database alone.
 *
 * The lexer follows PostgreSQL's scanner for what index DDL can contain:
 *
 * - whitespace is PostgreSQL's set only (space, tab, LF, CR, VT, FF); any
 *   other character, U+00A0 included, is part of a bare identifier, as it is
 *   for the server;
 * - `--` comments end at LF or CR, and `/* *\/` comments nest;
 * - bare identifiers are folded to lower case (ASCII only, as in a UTF-8
 *   database) and double-quoted identifiers keep their case (`""` is a
 *   quote); both are truncated to 63 bytes (NAMEDATALEN - 1);
 * - single-quoted strings (`''` is a quote), `E''` strings (backslash
 *   escapes), `B''`/`X''`/`N''` strings and dollar-quoted strings are read
 *   whole, so their contents never look like comments or names.
 *
 * `U&"…"` and `U&'…'` (Unicode escapes) are not decoded: they are unreadable.
 */

/** PostgreSQL's NAMEDATALEN - 1: the longest name it keeps, in bytes. */
const MAX_IDENTIFIER_BYTES = 63;

/** PostgreSQL's whitespace: space, tab, LF, CR, VT, FF. Nothing else. */
const PG_WHITESPACE = new Set([' ', '\t', '\n', '\r', '\v', '\f']);

export type Token =
  | { kind: 'word'; value: string; start: number; end: number }
  | { kind: 'quoted'; value: string; start: number; end: number }
  | { kind: 'string'; start: number; end: number }
  | { kind: 'number'; start: number; end: number }
  | { kind: 'punct'; value: string; start: number; end: number };

class Unreadable extends Error {}

/** Quote a stored identifier for SQL. */
export function quotePostgresIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Fold and truncate an identifier as PostgreSQL does. */
export function normalizePostgresIdentifier(
  text: string,
  quoted: boolean,
): string {
  const folded = quoted ? text : text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return truncateToBytes(folded, MAX_IDENTIFIER_BYTES);
}

function truncateToBytes(text: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= limit) return text;
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) break;
    bytes += size;
    out += char;
  }
  return out;
}

/** A character that starts a bare identifier: a letter, `_`, or any non-ASCII. */
const isIdentStart = (c: string) =>
  /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
/** A character that continues one: also digits and `$`. */
const isIdentPart = (c: string) =>
  /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

/** The tokens of `sql`, read lazily. */
function* tokens(sql: string): Generator<Token> {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (PG_WHITESPACE.has(c)) {
      i += 1;
      continue;
    }
    if (c === '-' && next === '-') {
      let j = i + 2;
      while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j += 1;
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      if (depth > 0) throw new Unreadable('an unterminated block comment');
      i = j;
      continue;
    }
    if (c === '"') {
      const { value, end } = readQuoted(sql, i, '"');
      if (value === '') throw new Unreadable('an empty quoted identifier');
      yield {
        kind: 'quoted',
        value: normalizePostgresIdentifier(value, true),
        start: i,
        end,
      };
      i = end;
      continue;
    }
    if (c === "'") {
      const { end } = readQuoted(sql, i, "'");
      yield { kind: 'string', start: i, end };
      i = end;
      continue;
    }
    if (
      c === '$' &&
      next !== undefined &&
      (next === '$' || isIdentStart(next))
    ) {
      // `$tag$ … $tag$`; `$1` (a parameter) is not a dollar quote.
      let j = i + 1;
      while (j < n && sql[j] !== '$' && isIdentPart(sql[j])) j += 1;
      if (sql[j] === '$') {
        const tag = sql.slice(i, j + 1);
        const close = sql.indexOf(tag, j + 1);
        if (close === -1) throw new Unreadable('an unterminated dollar quote');
        yield { kind: 'string', start: i, end: close + tag.length };
        i = close + tag.length;
        continue;
      }
    }
    if (
      /[0-9]/.test(c) ||
      (c === '.' && next !== undefined && /[0-9]/.test(next))
    ) {
      let j = i + 1;
      while (j < n && /[0-9.eE_]/.test(sql[j])) j += 1;
      yield { kind: 'number', start: i, end: j };
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(sql[j])) j += 1;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      if (
        upper === 'U' &&
        sql[j] === '&' &&
        (sql[j + 1] === '"' || sql[j + 1] === "'")
      )
        throw new Unreadable('a Unicode-escaped name or string');
      if (sql[j] === "'" && ['E', 'B', 'X', 'N'].includes(upper)) {
        const { end } = readQuoted(sql, j, "'", upper === 'E');
        yield { kind: 'string', start: i, end };
        i = end;
        continue;
      }
      yield {
        kind: 'word',
        value: normalizePostgresIdentifier(word, false),
        start: i,
        end: j,
      };
      i = j;
      continue;
    }
    yield { kind: 'punct', value: c, start: i, end: i + 1 };
    i += 1;
  }
}

/** Read a quoted run starting at `start`; a doubled quote is a quote. */
function readQuoted(
  sql: string,
  start: number,
  quote: string,
  backslashEscapes = false,
): { value: string; end: number } {
  let j = start + 1;
  let value = '';
  for (;;) {
    if (j >= sql.length) throw new Unreadable('an unterminated quote');
    const c = sql[j];
    if (backslashEscapes && c === '\\') {
      value += sql.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (c === quote) {
      if (sql[j + 1] === quote) {
        value += quote;
        j += 2;
        continue;
      }
      return { value, end: j + 1 };
    }
    value += c;
    j += 1;
  }
}

/** A cursor over the tokens of one statement. */
class Cursor {
  private readonly stream: Generator<Token>;
  private current: IteratorResult<Token> = { done: true, value: undefined };
  /**
   * A token that cannot be read is reported when it is looked at, not when
   * the token before it is taken: what came before it is still known (a
   * statement whose index name is unreadable is still a CREATE INDEX).
   */
  private failure: Unreadable | null = null;
  constructor(readonly sql: string) {
    this.stream = tokens(sql);
    this.advance();
  }
  private advance(): void {
    try {
      this.current = this.stream.next();
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      this.failure = error;
      this.current = { done: true, value: undefined };
    }
  }
  peek(): Token | undefined {
    if (this.failure) throw this.failure;
    return this.current.done ? undefined : this.current.value;
  }
  take(): Token | undefined {
    const token = this.peek();
    this.advance();
    return token;
  }
  keyword(value: string): Token | undefined {
    const token = this.peek();
    if (token?.kind === 'word' && token.value === value) return this.take();
    return undefined;
  }
  punct(value: string): Token | undefined {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) return this.take();
    return undefined;
  }
  /** A bare or quoted name. */
  name(): Token | undefined {
    const token = this.peek();
    if (token?.kind === 'word' || token?.kind === 'quoted') return this.take();
    return undefined;
  }
  /** `name` or `schema.name` (more parts are unreadable). */
  qualifiedName(): { parts: string[]; start: number; end: number } | undefined {
    const first = this.name();
    if (
      !first ||
      first.kind === 'string' ||
      first.kind === 'number' ||
      first.kind === 'punct'
    )
      return undefined;
    const parts = [first.value];
    let end = first.end;
    while (this.punct('.')) {
      const part = this.name();
      if (
        !part ||
        part.kind === 'string' ||
        part.kind === 'number' ||
        part.kind === 'punct'
      )
        throw new Unreadable('a dot without a name after it');
      parts.push(part.value);
      end = part.end;
    }
    if (parts.length > 2) throw new Unreadable('a name with a database part');
    return { parts, start: first.start, end };
  }
}

/** How an index statement routes, read from its leading tokens only. */
export type IndexStatementKind =
  | {
      kind: 'create-index';
      unique: boolean;
      concurrently: boolean;
      /** Where ` CONCURRENTLY` goes, right after `INDEX`. */
      insertConcurrentlyAt: number;
    }
  | {
      kind: 'drop-index';
      concurrently: boolean;
      insertConcurrentlyAt: number;
      ifExists: boolean;
      /** Each dropped index's name, as stored: `[schema,] name`. */
      names: string[][];
    }
  | { kind: 'reindex'; concurrently: boolean }
  | {
      kind: 'alter-index-rename';
      ifExists: boolean;
      from: string[];
      to: string;
    }
  | { kind: 'other' }
  | {
      kind: 'unreadable';
      reason: string;
      /**
       * The index DDL its leading keywords already name (`CREATE [UNIQUE]
       * INDEX`, `DROP INDEX`), or `null`: such a statement is still index DDL
       * and must never be routed as anything else.
       */
      index: 'create' | 'drop' | null;
      /** Whether `CONCURRENTLY` was read before the unreadable token. */
      concurrently: boolean;
    };

/** Classify `sql` for routing: an index statement, which one, or neither. */
export function classifyIndexStatement(sql: string): IndexStatementKind {
  let index: 'create' | 'drop' | null = null;
  let concurrently = false;
  try {
    const cursor = new Cursor(sql);
    if (cursor.keyword('create')) {
      const unique = Boolean(cursor.keyword('unique'));
      const indexToken = cursor.keyword('index');
      if (!indexToken) return { kind: 'other' };
      index = 'create';
      concurrently = Boolean(cursor.keyword('concurrently'));
      // The rest is read here only to learn whether it can be read at all.
      cursor.peek();
      return {
        kind: 'create-index',
        unique,
        concurrently,
        insertConcurrentlyAt: indexToken.end,
      };
    }
    if (cursor.keyword('drop')) {
      const indexToken = cursor.keyword('index');
      if (!indexToken) return { kind: 'other' };
      index = 'drop';
      concurrently = Boolean(cursor.keyword('concurrently'));
      let ifExists = false;
      if (cursor.keyword('if')) {
        if (!cursor.keyword('exists'))
          throw new Unreadable('IF without EXISTS');
        ifExists = true;
      }
      const names: string[][] = [];
      for (;;) {
        const name = cursor.qualifiedName();
        if (!name) throw new Unreadable('no index name to drop');
        names.push(name.parts);
        if (!cursor.punct(',')) break;
      }
      cursor.keyword('cascade') ?? cursor.keyword('restrict');
      cursor.punct(';');
      if (cursor.peek()) throw new Unreadable('more after the dropped names');
      return {
        kind: 'drop-index',
        concurrently,
        insertConcurrentlyAt: indexToken.end,
        ifExists,
        names,
      };
    }
    if (cursor.keyword('reindex')) {
      if (cursor.punct('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = cursor.take();
          if (!token) throw new Unreadable('unterminated REINDEX options');
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
      const target = cursor.take();
      if (target?.kind !== 'word') throw new Unreadable('no REINDEX target');
      return {
        kind: 'reindex',
        concurrently: Boolean(cursor.keyword('concurrently')),
      };
    }
    if (cursor.keyword('alter')) {
      if (!cursor.keyword('index')) return { kind: 'other' };
      let ifExists = false;
      if (cursor.keyword('if')) {
        if (!cursor.keyword('exists'))
          throw new Unreadable('IF without EXISTS');
        ifExists = true;
      }
      const from = cursor.qualifiedName();
      if (!from) throw new Unreadable('no index name');
      if (!cursor.keyword('rename')) return { kind: 'other' };
      if (!cursor.keyword('to')) throw new Unreadable('RENAME without TO');
      const to = cursor.name();
      if (!to || (to.kind !== 'word' && to.kind !== 'quoted'))
        throw new Unreadable('no new name');
      cursor.punct(';');
      if (cursor.peek()) throw new Unreadable('more after the new name');
      return {
        kind: 'alter-index-rename',
        ifExists,
        from: from.parts,
        to: to.value,
      };
    }
    return { kind: 'other' };
  } catch (error) {
    if (error instanceof Unreadable)
      return { kind: 'unreadable', reason: error.message, index, concurrently };
    throw error;
  }
}

/** One key or included column of an index, as the statement writes it. */
export interface IndexElement {
  /** A plain column (stored name), or `null` for an expression. */
  column: string | null;
  /** The expression's text, for an expression element. */
  expression: string | null;
  /** `COLLATE` name parts, when given. */
  collation: string[] | null;
  /** Operator class name parts, when given. */
  opclass: string[] | null;
  descending: boolean;
  nullsFirst: boolean;
}

export interface CreateIndexStatement {
  unique: boolean;
  concurrently: boolean;
  ifNotExists: boolean;
  /** The index name as PostgreSQL stores it, or `null` for an unnamed index. */
  name: string | null;
  /** Where the name is written (to build the same index under another name). */
  nameSpan: { start: number; end: number } | null;
  /** The table reference, each part as PostgreSQL stores it. */
  relation: string[];
  /** The reference with every part quoted, for `to_regclass()`. */
  relationSql: string;
  /** The access method, as stored (`btree` when not written). */
  method: string;
  keys: IndexElement[];
  include: string[];
  nullsNotDistinct: boolean;
  /** The predicate's text, or `null`. */
  predicate: string | null;
}

export type CreateIndexReading =
  | { kind: 'create-index'; statement: CreateIndexStatement }
  | { kind: 'not-create-index' }
  | { kind: 'unreadable'; reason: string };

/** Read the element list `( … )` after the cursor's `(`. */
function readElements(cursor: Cursor, sql: string): IndexElement[] {
  const elements: IndexElement[] = [];
  for (;;) {
    const first = cursor.peek();
    if (!first) throw new Unreadable('an unterminated column list');
    let column: string | null = null;
    let expression: string | null = null;
    // An expression is `( … )` or a function call `name( … )`; anything
    // else must be a plain column name.
    const startsParen = first.kind === 'punct' && first.value === '(';
    if (startsParen) {
      const start = first.start;
      cursor.take();
      let depth = 1;
      let end = first.end;
      while (depth > 0) {
        const token = cursor.take();
        if (!token) throw new Unreadable('an unterminated expression');
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        if (token.kind === 'punct' && token.value === ')') depth -= 1;
        end = token.end;
      }
      expression = sql.slice(start, end);
    } else {
      const name = cursor.qualifiedName();
      if (!name) throw new Unreadable('a column list entry that is not a name');
      if (
        cursor.peek()?.kind === 'punct' &&
        (cursor.peek() as { value: string }).value === '('
      ) {
        let depth = 0;
        let end = name.end;
        do {
          const token = cursor.take();
          if (!token) throw new Unreadable('an unterminated function call');
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
          end = token.end;
        } while (depth > 0);
        expression = sql.slice(name.start, end);
      } else {
        if (name.parts.length !== 1)
          throw new Unreadable('a qualified column name');
        column = name.parts[0];
      }
    }
    let collation: string[] | null = null;
    if (cursor.keyword('collate')) {
      const name = cursor.qualifiedName();
      if (!name) throw new Unreadable('COLLATE without a name');
      collation = name.parts;
    }
    let opclass: string[] | null = null;
    const next = cursor.peek();
    if (
      (next?.kind === 'word' &&
        !['asc', 'desc', 'nulls'].includes(next.value)) ||
      next?.kind === 'quoted'
    ) {
      const name = cursor.qualifiedName();
      if (!name) throw new Unreadable('an operator class without a name');
      opclass = name.parts;
      if (cursor.punct('(')) throw new Unreadable('operator class parameters');
    }
    let descending = false;
    if (cursor.keyword('desc')) descending = true;
    else cursor.keyword('asc');
    let nullsFirst = descending;
    if (cursor.keyword('nulls')) {
      if (cursor.keyword('first')) nullsFirst = true;
      else if (cursor.keyword('last')) nullsFirst = false;
      else throw new Unreadable('NULLS without FIRST or LAST');
    }
    elements.push({
      column,
      expression,
      collation,
      opclass,
      descending,
      nullsFirst,
    });
    if (cursor.punct(',')) continue;
    if (cursor.punct(')')) return elements;
    throw new Unreadable('an unexpected token in the column list');
  }
}

/**
 * Read `sql` as a whole `CREATE INDEX` statement, or say why it cannot be
 * read with certainty.
 */
export function readCreateIndexStatement(sql: string): CreateIndexReading {
  try {
    const cursor = new Cursor(sql);
    if (!cursor.keyword('create')) return { kind: 'not-create-index' };
    const unique = Boolean(cursor.keyword('unique'));
    if (!cursor.keyword('index')) return { kind: 'not-create-index' };
    const concurrently = Boolean(cursor.keyword('concurrently'));
    let ifNotExists = false;
    if (cursor.keyword('if')) {
      if (!cursor.keyword('not') || !cursor.keyword('exists'))
        throw new Unreadable('IF without NOT EXISTS');
      ifNotExists = true;
    }
    let name: string | null = null;
    let nameSpan: { start: number; end: number } | null = null;
    const first = cursor.peek();
    if (first?.kind === 'word' && first.value === 'on') {
      if (ifNotExists) throw new Unreadable('IF NOT EXISTS without a name');
    } else if (first?.kind === 'word' || first?.kind === 'quoted') {
      name = first.value;
      nameSpan = { start: first.start, end: first.end };
      cursor.take();
    } else {
      throw new Unreadable('no index name or ON');
    }
    if (!cursor.keyword('on'))
      throw new Unreadable('no ON after the index name');
    cursor.keyword('only');
    const relation = cursor.qualifiedName();
    if (!relation) throw new Unreadable('no table name');
    let method = 'btree';
    if (cursor.keyword('using')) {
      const am = cursor.name();
      if (!am || (am.kind !== 'word' && am.kind !== 'quoted'))
        throw new Unreadable('USING without a method');
      method = am.value;
    }
    if (!cursor.punct('('))
      throw new Unreadable('no column list after the table');
    const keys = readElements(cursor, sql);
    let include: string[] = [];
    if (cursor.keyword('include')) {
      if (!cursor.punct('(')) throw new Unreadable('INCLUDE without a list');
      include = readElements(cursor, sql).map((element) => {
        if (!element.column) throw new Unreadable('an INCLUDE expression');
        return element.column;
      });
    }
    let nullsNotDistinct = false;
    if (cursor.keyword('nulls')) {
      if (cursor.keyword('not')) {
        if (!cursor.keyword('distinct'))
          throw new Unreadable('NULLS NOT without DISTINCT');
        nullsNotDistinct = true;
      } else if (!cursor.keyword('distinct'))
        throw new Unreadable('NULLS without DISTINCT');
    }
    if (cursor.keyword('with')) {
      // Storage parameters (fillfactor, …) do not change what the index
      // enforces; read past them.
      if (!cursor.punct('(')) throw new Unreadable('WITH without a list');
      let depth = 1;
      while (depth > 0) {
        const token = cursor.take();
        if (!token) throw new Unreadable('an unterminated WITH list');
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        if (token.kind === 'punct' && token.value === ')') depth -= 1;
      }
    }
    if (cursor.keyword('tablespace') && !cursor.name())
      throw new Unreadable('TABLESPACE without a name');
    let predicate: string | null = null;
    if (cursor.keyword('where')) {
      // From the predicate's first token to the end of its last: no string
      // trimming, which would also strip characters (U+00A0, …) that
      // PostgreSQL reads as part of a bare identifier.
      let start: number | null = null;
      let end = 0;
      for (;;) {
        const last = cursor.peek();
        if (!last || (last.kind === 'punct' && last.value === ';')) break;
        cursor.take();
        start ??= last.start;
        end = last.end;
      }
      if (start === null) throw new Unreadable('WHERE without a predicate');
      predicate = sql.slice(start, end);
    }
    cursor.punct(';');
    if (cursor.peek()) throw new Unreadable('more after the statement');
    return {
      kind: 'create-index',
      statement: {
        unique,
        concurrently,
        ifNotExists,
        name,
        nameSpan,
        relation: relation.parts,
        relationSql: relation.parts.map(quotePostgresIdentifier).join('.'),
        method,
        keys,
        include,
        nullsNotDistinct,
        predicate,
      },
    };
  } catch (error) {
    if (error instanceof Unreadable)
      return { kind: 'unreadable', reason: error.message };
    throw error;
  }
}

/**
 * Every token of `sql` as `kind` and stored value (strings and numbers have
 * none), or the reason it cannot be read. With `literals`, a plain `'…'`
 * string also carries its text as `literal` (other string forms carry none).
 */
export function readPostgresTokens(
  sql: string,
  options: { literals?: boolean } = {},
):
  | Array<{ kind: Token['kind']; value?: string; literal?: string }>
  | { unreadable: string } {
  try {
    return [...tokens(sql)].map((token) =>
      token.kind === 'string' || token.kind === 'number'
        ? options.literals && sql[token.start] === "'"
          ? {
              kind: token.kind,
              literal: sql
                .slice(token.start + 1, token.end - 1)
                .replaceAll("''", "'"),
            }
          : { kind: token.kind }
        : { kind: token.kind, value: token.value },
    );
  } catch (error) {
    if (error instanceof Unreadable) return { unreadable: error.message };
    throw error;
  }
}
