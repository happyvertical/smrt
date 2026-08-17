/**
 * Numeric-precision lint for money-shaped SMRT fields (#2361).
 *
 * SMRT infers a `number` field's column type from the *initializer literal*:
 * `= 0` compiles to INTEGER and `= 0.0` compiles to DECIMAL
 * (`manifest-adapter.ts`, steps 3 and 3.5). The rule is silent, and SQLite's
 * type affinity happily stores a REAL in an INTEGER column — so a money field
 * declared `= 0` passes every SQLite suite and then fails in production on
 * PostgreSQL with `22P02 invalid input syntax for type integer: "19.99"`.
 *
 * This lint closes that gap deterministically, at source, before the manifest
 * exists: a persisted `number` field whose *head noun* is monetary (amount,
 * price, total, rate, tax, confidence, percent, discount, …) may not rely on
 * the integer heuristic. Either write a decimal literal or state the type
 * explicitly with `@field({ type: 'integer' })` — an explicit integer is a
 * legitimate answer (`sales` keeps exact ledgers in integer cents).
 *
 * Matching is head-noun based rather than substring based, which is what keeps
 * it usable as a fail-closed gate: `amountCents` and `totalTokensUsed` name a
 * unit or a count as their head and are left alone, while `totalAmount`,
 * `amountPaid` and a bare `total` are flagged. JSDoc prose is deliberately NOT
 * matched — the head-noun signal is precise, and scanning prose for the same
 * vocabulary would make a repo-wide error gate fire on documentation wording.
 */

import type { RawClassDefinition, RawFieldDefinition } from './types.js';

/**
 * Head nouns that denote a monetary, proportional, or fractional quantity.
 *
 * Deliberately narrow: every entry names a value that is fractional in normal
 * business use, so an integer column is a bug unless the author says otherwise.
 */
const MONETARY_HEAD_WORDS = new Set([
  'amount',
  'balance',
  'confidence',
  'cost',
  'discount',
  'fee',
  'percent',
  'percentage',
  'price',
  'rate',
  'subtotal',
  'tax',
  'total',
]);

/**
 * Words that may trail the monetary head noun without displacing it.
 *
 * `amountPaid` is still an amount; `amountCents` is not (its head noun names an
 * exact integer unit), which is why the exemption is an allowlist rather than a
 * blocklist of unit words.
 */
const TRAILING_QUALIFIERS = new Set([
  'applied',
  'billed',
  'charged',
  'collected',
  'due',
  'earned',
  'gross',
  'net',
  'outstanding',
  'owed',
  'paid',
  'refunded',
  'remaining',
]);

/** Base classes whose fields become table columns even without `@smrt()`. */
const PERSISTED_BASE_CLASSES = new Set([
  'SmrtObject',
  'SmrtJunction',
  'SmrtHierarchical',
  'SmrtPolymorphicAssociation',
]);

/** One field that relies on the integer heuristic for a monetary quantity. */
export interface NumericPrecisionFinding {
  /** Declaring class, e.g. `Invoice`. */
  className: string;
  /** Field name, e.g. `totalAmount`. */
  fieldName: string;
  /** File the class was scanned from. */
  filePath: string;
  /**
   * 1-based line of the field declaration, or `0` when it could not be
   * resolved. The OXC AST nodes this scanner consumes do not carry `loc`, so
   * the line is recovered from the source text when a caller passes it to
   * {@link lintNumericPrecision}.
   */
  line: number;
  /** The integer literal that triggered the finding. */
  initializer: string;
  /** Human-readable explanation naming the 0 / 0.0 rule. */
  message: string;
  /** The two accepted fixes. */
  remedy: string;
}

/**
 * Split an identifier into lowercase words on camelCase, PascalCase, digits,
 * and underscores. `totalAmountCents` → `['total', 'amount', 'cents']`.
 */
export function splitIdentifierWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * True when the identifier's head noun is monetary.
 *
 * The head is the last word, or the last word before a trailing qualifier such
 * as `Paid`. This is what separates `amountPaid` (an amount) from `amountCents`
 * (a count of cents, correctly an integer).
 */
export function hasMonetaryHeadNoun(name: string): boolean {
  const words = splitIdentifierWords(name);
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    if (MONETARY_HEAD_WORDS.has(word)) return true;
    if (!TRAILING_QUALIFIERS.has(word)) return false;
  }
  return false;
}

/**
 * Cheap pre-filter so callers can skip parsing files that cannot produce a
 * finding. Conservative by construction: it may return `true` for a file the
 * AST pass then clears, but never `false` for one that would be flagged.
 */
export function sourceMayContainMonetaryIntegerField(source: string): boolean {
  if (!/=\s*-?\d+\s*(?:;|$)/m.test(source)) return false;
  for (const word of MONETARY_HEAD_WORDS) {
    if (source.toLowerCase().includes(word)) return true;
  }
  return false;
}

/** Does any decorator on this field state the column type explicitly? */
function hasExplicitTypeDecorator(field: RawFieldDefinition): boolean {
  for (const decorator of field.decorators) {
    // Relationship decorators own the column type outright.
    if (
      decorator.name === 'foreignKey' ||
      decorator.name === 'crossPackageRef' ||
      decorator.name === 'oneToMany' ||
      decorator.name === 'manyToMany' ||
      decorator.name === 'tenantId'
    ) {
      return true;
    }
    if (decorator.name !== 'field') continue;
    const args = decorator.arguments.join(' ');
    // `@field({ type: 'decimal' })` — an explicit declaration of intent, which
    // is exactly what this lint asks for, whichever type was chosen.
    if (/\btype\s*:/.test(args)) return true;
    // A transient field is never persisted, so no column type is inferred.
    if (/\btransient\s*:\s*true\b/.test(args)) return true;
  }
  return false;
}

/** Fields stored in the STI `_meta_data` JSON blob get no typed column. */
function isMetaField(field: RawFieldDefinition): boolean {
  if (field.decorators.some((decorator) => decorator.name === 'meta')) {
    return true;
  }
  return /^Meta\s*</.test(field.typeAnnotation ?? '');
}

/** Would the manifest adapter's heuristic type this field as INTEGER? */
function relaxesToIntegerHeuristic(field: RawFieldDefinition): boolean {
  if (field.numericValue === null || field.hasDecimalPoint) return false;
  const annotation = (field.typeAnnotation ?? '').replace(/\s/g, '');
  if (annotation === '') return true; // `price = 0` — inference step 3.5
  return annotation === 'number' || annotation === 'number|null';
}

/** Are this class's fields materialized as table columns? */
function isPersistedClass(cls: RawClassDefinition): boolean {
  if (cls.hasSmartDecorator) return true;
  return PERSISTED_BASE_CLASSES.has(cls.extendsClause ?? '');
}

/**
 * Recover a field's 1-based declaration line from source text.
 *
 * The scanner's raw field records carry `line: 0` because the OXC AST nodes
 * have no `loc`, and a finding that cannot point at a line is much harder to
 * act on — so callers that already hold the file contents get a real line.
 */
function resolveDeclarationLine(
  sourceText: string | undefined,
  fieldName: string,
  fallback: number,
): number {
  if (fallback > 0 || !sourceText) return fallback;
  const declaration = new RegExp(
    `^\\s*(?:(?:public|private|protected|readonly|declare|override)\\s+)*${fieldName}\\s*[?!]?\\s*(?::[^=;]+)?=\\s*-?\\d`,
  );
  const lines = sourceText.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (declaration.test(lines[index])) return index + 1;
  }
  return 0;
}

/**
 * Report every persisted `number` field that leans on the integer heuristic for
 * a monetary quantity.
 *
 * @param classes - Raw class definitions from `parseFile` / `OxcScanner`.
 * @param sourceText - Optional contents of the scanned file, used only to
 *   recover declaration line numbers the AST does not carry.
 * @returns One finding per offending field, in declaration order.
 */
export function lintNumericPrecision(
  classes: RawClassDefinition[],
  sourceText?: string,
): NumericPrecisionFinding[] {
  const findings: NumericPrecisionFinding[] = [];
  for (const cls of classes) {
    if (!isPersistedClass(cls)) continue;
    for (const field of cls.fields) {
      if (field.isStatic) continue;
      if (!relaxesToIntegerHeuristic(field)) continue;
      if (!hasMonetaryHeadNoun(field.name)) continue;
      if (isMetaField(field)) continue;
      if (hasExplicitTypeDecorator(field)) continue;
      findings.push({
        className: cls.className,
        fieldName: field.name,
        filePath: cls.filePath,
        line: resolveDeclarationLine(sourceText, field.name, field.line),
        initializer: field.initializer ?? String(field.numericValue),
        message:
          `${cls.className}.${field.name} is a monetary field with an integer ` +
          `initializer (= ${field.numericValue}), so SMRT compiles it to an ` +
          'INTEGER column. PostgreSQL then rejects fractional saves with ' +
          '22P02; SQLite silently accepts them.',
        remedy:
          `Write a decimal initializer (\`${field.name} = ${field.numericValue}.0\`) ` +
          'to get a DECIMAL column, or state the intent explicitly with ' +
          `\`@field({ type: 'integer' })\` when the value really is exact ` +
          '(integer cents, basis points).',
      });
    }
  }
  return findings;
}
