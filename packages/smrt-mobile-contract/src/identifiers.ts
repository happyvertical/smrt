/**
 * Identifier + literal escaping for generated Kotlin/Swift source. Manifest
 * field names are valid JS identifiers, but may collide with Kotlin/Swift
 * keywords; string defaults may contain characters that Kotlin string
 * templates or escapes treat specially.
 */

const KOTLIN_HARD_KEYWORDS = new Set([
  'as',
  'break',
  'class',
  'continue',
  'do',
  'else',
  'false',
  'for',
  'fun',
  'if',
  'in',
  'interface',
  'is',
  'null',
  'object',
  'package',
  'return',
  'super',
  'this',
  'throw',
  'true',
  'try',
  'typealias',
  'typeof',
  'val',
  'var',
  'when',
  'while',
]);

const SWIFT_KEYWORDS = new Set([
  'associatedtype',
  'as',
  'break',
  'case',
  'catch',
  'class',
  'continue',
  'default',
  'defer',
  'deinit',
  'do',
  'else',
  'enum',
  'extension',
  'fallthrough',
  'false',
  'fileprivate',
  'for',
  'func',
  'guard',
  'if',
  'import',
  'in',
  'init',
  'inout',
  'internal',
  'is',
  'let',
  'nil',
  'open',
  'operator',
  'private',
  'protocol',
  'public',
  'repeat',
  'rethrows',
  'return',
  'self',
  'static',
  'struct',
  'subscript',
  'super',
  'switch',
  'throw',
  'throws',
  'true',
  'try',
  'typealias',
  'var',
  'where',
  'while',
]);

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Backtick-escapes Kotlin hard keywords (and non-plain identifiers). */
export function kotlinIdentifier(name: string): string {
  return KOTLIN_HARD_KEYWORDS.has(name) || !PLAIN_IDENTIFIER.test(name)
    ? `\`${name}\``
    : name;
}

/** Backtick-escapes Swift keywords (and non-plain identifiers). */
export function swiftIdentifier(name: string): string {
  return SWIFT_KEYWORDS.has(name) || !PLAIN_IDENTIFIER.test(name)
    ? `\`${name}\``
    : name;
}

/**
 * Emits a Kotlin double-quoted string literal. Escapes `$` (string-template
 * interpolation), quotes, backslashes, and control characters — JSON escaping
 * is NOT Kotlin-safe (`$` stays raw and `\f` is not a Kotlin escape).
 */
export function kotlinStringLiteral(value: string): string {
  let out = '"';
  for (const char of value) {
    switch (char) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '$':
        out += '\\$';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = char.codePointAt(0) ?? 0;
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
      }
    }
  }
  return `${out}"`;
}
