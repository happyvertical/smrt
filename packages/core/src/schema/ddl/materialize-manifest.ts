import type { DatabaseEngine } from './types.js';

function skipSQLTrivia(value: string, start = 0): number {
  let index = start;
  while (index < value.length) {
    if (/\s/.test(value[index])) {
      index += 1;
      continue;
    }
    if (value.startsWith('--', index)) {
      const newline = value.indexOf('\n', index + 2);
      return newline === -1 ? value.length : skipSQLTrivia(value, newline + 1);
    }
    if (value.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < value.length && depth > 0) {
        if (value.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (value.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth > 0) return value.length;
      continue;
    }
    break;
  }
  return index;
}

function getSQLIdentifierEnd(value: string, start: number): number | null {
  if (value[start] === '"') {
    for (let index = start + 1; index < value.length; index += 1) {
      if (value[index] !== '"') continue;
      if (value[index + 1] === '"') {
        index += 1;
        continue;
      }
      return index + 1;
    }
    return null;
  }

  const identifier = value.slice(start).match(/^[a-z_][a-z0-9_]*/i)?.[0];
  return identifier ? start + identifier.length : null;
}

/** @internal */
export function getSQLDefinitionIdentifier(
  definition: string,
): { name: string; start: number; end: number; quoted: boolean } | null {
  const start = skipSQLTrivia(definition);
  const end = getSQLIdentifierEnd(definition, start);
  if (end === null) return null;
  const raw = definition.slice(start, end);
  const quoted = raw.startsWith('"');
  return {
    name: quoted ? raw.slice(1, -1).replaceAll('""', '"') : raw,
    start,
    end,
    quoted,
  };
}

/** @internal */
export function isSQLTableConstraintDefinition(definition: string): boolean {
  const identifier = getSQLDefinitionIdentifier(definition);
  return (
    identifier !== null &&
    !identifier.quoted &&
    /^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE|NOT)$/i.test(
      identifier.name,
    )
  );
}

function consumeSQLKeyword(
  value: string,
  start: number,
  keyword: string,
): number | null {
  const keywordStart = skipSQLTrivia(value, start);
  const candidate = value.slice(keywordStart, keywordStart + keyword.length);
  if (candidate.toUpperCase() !== keyword) return null;
  const next = value[keywordStart + keyword.length] ?? '';
  return /[a-z0-9_$]/i.test(next) ? null : keywordStart + keyword.length;
}

function hasPostgresCreateTableHeader(value: string, start: number): boolean {
  let cursor = consumeSQLKeyword(value, start, 'CREATE');
  if (cursor === null) return false;

  const localityEnd =
    consumeSQLKeyword(value, cursor, 'GLOBAL') ??
    consumeSQLKeyword(value, cursor, 'LOCAL');
  if (localityEnd !== null) {
    const temporaryEnd =
      consumeSQLKeyword(value, localityEnd, 'TEMPORARY') ??
      consumeSQLKeyword(value, localityEnd, 'TEMP');
    if (temporaryEnd === null) return false;
    cursor = temporaryEnd;
  } else {
    cursor =
      consumeSQLKeyword(value, cursor, 'TEMPORARY') ??
      consumeSQLKeyword(value, cursor, 'TEMP') ??
      consumeSQLKeyword(value, cursor, 'UNLOGGED') ??
      cursor;
  }

  return consumeSQLKeyword(value, cursor, 'TABLE') !== null;
}

function hasExplicitTimestampQualifier(
  value: string,
  timestampEnd: number,
): boolean {
  let cursor = skipSQLTrivia(value, timestampEnd);
  if (value[cursor] === '(') {
    const precisionEnd = findBalancedParenthesisEnd(value, cursor);
    if (precisionEnd === null) return true;
    cursor = precisionEnd;
  }

  const qualifierEnd =
    consumeSQLKeyword(value, cursor, 'WITH') ??
    consumeSQLKeyword(value, cursor, 'WITHOUT');
  if (qualifierEnd === null) return false;
  const timeEnd = consumeSQLKeyword(value, qualifierEnd, 'TIME');
  if (timeEnd === null) return false;
  return consumeSQLKeyword(value, timeEnd, 'ZONE') !== null;
}

function visitSQLStructure(
  value: string,
  visitor: (char: string, index: number) => boolean | undefined,
): void {
  let inSingleQuote = false;
  let singleQuoteBackslashEscapes = false;
  let inDoubleQuote = false;
  let dollarQuoteTag: string | null = null;
  let inLineComment = false;
  let blockCommentDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = index + 1 < value.length ? value[index + 1] : '';

    if (inLineComment) {
      if (char === '\n' || char === '\r') inLineComment = false;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (char === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (char === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }

    if (dollarQuoteTag) {
      if (value.startsWith(dollarQuoteTag, index)) {
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }

    if (inSingleQuote) {
      if (char === "'" && next === "'") {
        index += 1;
      } else if (char === "'") {
        let precedingBackslashes = 0;
        for (
          let offset = index - 1;
          offset >= 0 && value[offset] === '\\';
          offset -= 1
        ) {
          precedingBackslashes += 1;
        }
        if (!singleQuoteBackslashEscapes || precedingBackslashes % 2 === 0) {
          inSingleQuote = false;
          singleQuoteBackslashEscapes = false;
        }
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"' && next === '"') {
        index += 1;
      } else if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      const prefix = index > 0 ? value[index - 1] : '';
      const beforePrefix = index > 1 ? value[index - 2] : '';
      singleQuoteBackslashEscapes =
        /^e$/i.test(prefix) && !/[a-z0-9_$]/i.test(beforePrefix);
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === '$') {
      const dollarTag = value
        .slice(index)
        .match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0];
      if (dollarTag) {
        dollarQuoteTag = dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
    }

    if (visitor(char, index) === false) return;
  }
}

/**
 * Build a conservative comparison key for one DDL definition.
 *
 * SQL trivia and unquoted token case are insignificant. Quoted literals,
 * dollar-quoted bodies, and quoted identifiers remain byte-for-byte distinct,
 * so comparison never conflates predicates such as `'a  b'` and `'a b'`.
 *
 * @internal
 */
export function getSQLDefinitionComparisonKey(value: string): string {
  const tokens: string[] = [];

  for (let index = 0; index < value.length; ) {
    const char = value[index];
    const next = value[index + 1] ?? '';

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      const newline = value.indexOf('\n', index + 2);
      index = newline === -1 ? value.length : newline + 1;
      continue;
    }

    if (char === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < value.length && depth > 0) {
        if (value.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (value.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (char === '"') {
      const start = index;
      index += 1;
      while (index < value.length) {
        if (value[index] === '"' && value[index + 1] === '"') {
          index += 2;
        } else if (value[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      tokens.push(value.slice(start, index));
      continue;
    }

    if (char === "'") {
      const start = index;
      const prefix = index > 0 ? value[index - 1] : '';
      const beforePrefix = index > 1 ? value[index - 2] : '';
      const backslashEscapes =
        /^e$/i.test(prefix) && !/[a-z0-9_$]/i.test(beforePrefix);
      index += 1;
      while (index < value.length) {
        if (value[index] === "'" && value[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (value[index] === "'") {
          let precedingBackslashes = 0;
          for (
            let offset = index - 1;
            offset > start && value[offset] === '\\';
            offset -= 1
          ) {
            precedingBackslashes += 1;
          }
          if (!backslashEscapes || precedingBackslashes % 2 === 0) {
            index += 1;
            break;
          }
        }
        index += 1;
      }
      tokens.push(value.slice(start, index));
      continue;
    }

    if (char === '$') {
      const tag = value.slice(index).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0];
      if (tag) {
        const start = index;
        const closing = value.indexOf(tag, index + tag.length);
        index = closing === -1 ? value.length : closing + tag.length;
        tokens.push(value.slice(start, index));
        continue;
      }
    }

    const word = value.slice(index).match(/^[a-z_][a-z0-9_$]*/i)?.[0];
    if (word) {
      tokens.push(word.toLowerCase());
      index += word.length;
      continue;
    }

    tokens.push(char);
    index += 1;
  }

  return tokens.join('\0');
}

function getTopLevelDefinitionRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let segmentStart = 0;
  let parenDepth = 0;

  visitSQLStructure(body, (char, index) => {
    if (char === '(') parenDepth += 1;
    if (char === ')' && parenDepth > 0) parenDepth -= 1;
    if (char === ',' && parenDepth === 0) {
      ranges.push([segmentStart, index]);
      segmentStart = index + 1;
    }
    return undefined;
  });

  ranges.push([segmentStart, body.length]);
  return ranges;
}

function findBalancedParenthesisEnd(
  value: string,
  openingParen: number,
): number | null {
  let depth = 0;
  let closingParen: number | null = null;
  visitSQLStructure(value.slice(openingParen), (char, relativeIndex) => {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        closingParen = openingParen + relativeIndex + 1;
        return false;
      }
    }
    return undefined;
  });
  return closingParen;
}

/** @internal */
export function findCreateTableBodyRange(
  ddl: string,
  statementStart = 0,
): [number, number] | null {
  let openingParen: number | null = null;
  let closingParen: number | null = null;
  let depth = 0;

  visitSQLStructure(ddl.slice(statementStart), (char, relativeIndex) => {
    const index = statementStart + relativeIndex;
    if (char === '(') {
      if (openingParen === null) openingParen = index;
      depth += 1;
    } else if (char === ')' && openingParen !== null) {
      depth -= 1;
      if (depth === 0) {
        closingParen = index;
        return false;
      }
    }
    return undefined;
  });

  return openingParen !== null && closingParen !== null
    ? [openingParen, closingParen]
    : null;
}

/** @internal */
export function tokenizeSQLDDLBody(body: string): string[] {
  return getTopLevelDefinitionRanges(body)
    .map(([start, end]) => body.slice(start, end).trim())
    .filter(Boolean);
}

/**
 * Make cached engine-neutral manifest DDL safe for direct execution.
 *
 * Cached DDL may contain custom table constraints and dialect-specific clauses,
 * so this does not regenerate the whole statement from structured columns. For
 * PostgreSQL it performs a span-preserving rewrite of only a column
 * definition's leading bare TIMESTAMP token. Explicit WITH/WITHOUT TIME ZONE
 * declarations, comments, dollar-quoted/string literals, identifiers,
 * separators, and table constraints remain untouched.
 */
export function materializeManifestDDLForEngine(
  ddl: string,
  engine: DatabaseEngine,
): string {
  const statementStart = skipSQLTrivia(ddl);
  if (
    engine !== 'postgres' ||
    !hasPostgresCreateTableHeader(ddl, statementStart)
  ) {
    return ddl;
  }

  const bodyRange = findCreateTableBodyRange(ddl, statementStart);
  if (!bodyRange) return ddl;
  const [openingParen, closingParen] = bodyRange;

  const body = ddl.slice(openingParen + 1, closingParen);
  let changed = false;
  let cursor = 0;
  let materializedBody = '';
  for (const [start, end] of getTopLevelDefinitionRanges(body)) {
    materializedBody += body.slice(cursor, start);
    const definition = body.slice(start, end);
    const identifier = getSQLDefinitionIdentifier(definition);
    const isTableConstraint = isSQLTableConstraintDefinition(definition);
    const columnStart = identifier?.start ?? skipSQLTrivia(definition);
    const typeStart = identifier
      ? skipSQLTrivia(definition, identifier.end)
      : columnStart;
    const timestampEnd = consumeSQLKeyword(definition, typeStart, 'TIMESTAMP');
    const converted =
      identifier &&
      !isTableConstraint &&
      typeStart > identifier.end &&
      timestampEnd !== null &&
      !hasExplicitTimestampQualifier(definition, timestampEnd)
        ? `${definition.slice(0, typeStart)}TIMESTAMPTZ${definition.slice(typeStart + 'TIMESTAMP'.length)}`
        : definition;
    changed ||= converted !== definition;
    materializedBody += converted;
    cursor = end;
  }
  materializedBody += body.slice(cursor);

  if (!changed) return ddl;

  const prefix = ddl.slice(0, openingParen + 1);
  const suffix = ddl.slice(closingParen);
  return `${prefix}${materializedBody}${suffix}`;
}
