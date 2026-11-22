/**
 * Dispatch signal-type pattern compiler.
 *
 * One compiler serves every place a subscription pattern is evaluated: the
 * in-memory {@link DispatchSubscription.matches} check and the SQL candidate
 * query of `DispatchBus.process()`. Keeping a single source means a row the
 * database selects is exactly a row `matches()` accepts, on every engine.
 *
 * Grammar: every `*` character (leading, embedded or repeated) stands for one
 * or more characters other than `.`. Every other character is literal and
 * case-sensitive. A pattern without `*` is an exact match.
 *
 * SQL forms (all case-sensitive):
 * - exact: `col = $p` (index friendly);
 * - SQLite: `col GLOB $g` with each `*` as `?*` and literal `*`, `?`, `[`
 *   bracket-escaped, plus a dot-count equality so a wildcard span holds no `.`;
 * - PostgreSQL / PGlite / DuckDB: `col LIKE $l ESCAPE '\'` with each `*` as
 *   `_%` and literal `\`, `%`, `_` escaped, plus the same dot-count equality.
 *
 * `LIKE` is case-insensitive on SQLite, so SQLite always uses `GLOB`.
 *
 * Internal module: not exported from the package entry point.
 */

/** A compiled dispatch pattern. */
export interface CompiledDispatchPattern {
  /** The pattern as given. */
  readonly source: string;
  /** Set when the pattern has no `*`: the only type it matches. */
  readonly exact?: string;
  /** Anchored regular expression equivalent to the pattern. */
  readonly regex: RegExp;
  /** SQLite `GLOB` form and the number of literal dots. */
  readonly sqlite: { readonly glob: string; readonly dots: number };
  /** `LIKE ... ESCAPE '\'` form and the number of literal dots. */
  readonly like: { readonly pattern: string; readonly dots: number };
}

/** SQL dialect for compiled patterns: SQLite `GLOB` or ANSI `LIKE`. */
export type DispatchPatternDialect = 'glob' | 'like';

/** Binds a value and returns its placeholder (e.g. `$3`). */
export type DispatchSqlBinder = (value: unknown) => string;

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
const GLOB_META = /[*?[]/g;
const LIKE_META = /[\\%_]/g;

const CACHE_LIMIT = 512;
const cache = new Map<string, CompiledDispatchPattern>();

function countDots(text: string): number {
  let dots = 0;
  for (const char of text) {
    if (char === '.') dots++;
  }
  return dots;
}

/**
 * Compile a dispatch subscription pattern.
 *
 * Results are memoized (bounded); the returned object is immutable.
 */
export function compileDispatchPattern(
  pattern: string,
): CompiledDispatchPattern {
  const cached = cache.get(pattern);
  if (cached) return cached;

  const pieces = pattern.split('*');
  const dots = countDots(pattern);
  const regex = new RegExp(
    `^${pieces.map((piece) => piece.replace(REGEX_META, '\\$&')).join('[^.]+')}$`,
  );
  const glob = pieces
    .map((piece) => piece.replace(GLOB_META, '[$&]'))
    .join('?*');
  const like = pieces
    .map((piece) => piece.replace(LIKE_META, '\\$&'))
    .join('_%');

  const compiled: CompiledDispatchPattern = Object.freeze({
    source: pattern,
    ...(pieces.length === 1 ? { exact: pattern } : {}),
    regex,
    sqlite: Object.freeze({ glob, dots }),
    like: Object.freeze({ pattern: like, dots }),
  });

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(pattern, compiled);
  return compiled;
}

/** Whether `signalType` matches `pattern` under the dispatch grammar. */
export function matchesDispatchPattern(
  pattern: string,
  signalType: string,
): boolean {
  const compiled = compileDispatchPattern(pattern);
  if (compiled.exact !== undefined) return compiled.exact === signalType;
  return compiled.regex.test(signalType);
}

/**
 * SQL predicate selecting the values of `column` that `pattern` matches.
 *
 * `column` must be a trusted identifier or expression; every pattern-derived
 * value is bound through `bind`. The dot count is a computed integer and is
 * written inline.
 */
export function dispatchPatternSql(
  pattern: string | CompiledDispatchPattern,
  dialect: DispatchPatternDialect,
  column: string,
  bind: DispatchSqlBinder,
): string {
  const compiled =
    typeof pattern === 'string' ? compileDispatchPattern(pattern) : pattern;
  if (compiled.exact !== undefined) {
    return `${column} = ${bind(compiled.exact)}`;
  }
  const dotCount = `length(${column}) - length(replace(${column}, '.', ''))`;
  if (dialect === 'glob') {
    return `(${column} GLOB ${bind(compiled.sqlite.glob)} AND ${dotCount} = ${compiled.sqlite.dots})`;
  }
  return `(${column} LIKE ${bind(compiled.like.pattern)} ESCAPE '\\' AND ${dotCount} = ${compiled.like.dots})`;
}

/** The pattern dialect for a resolved database engine. */
export function dispatchPatternDialect(engine: string): DispatchPatternDialect {
  return engine === 'sqlite' ? 'glob' : 'like';
}
