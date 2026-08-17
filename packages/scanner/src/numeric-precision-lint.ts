/**
 * Numeric-precision lint for money and rate fields (#2361).
 *
 * SMRT infers a `number` field's column type from the *initializer literal*:
 * `= 0` compiles to INTEGER and `= 0.0` compiles to DECIMAL
 * (`manifest-adapter.ts`, inference steps 3 and 3.5). The rule is silent, and
 * SQLite's type affinity happily stores a REAL in an INTEGER column — so a
 * mistyped field passes every SQLite suite and then behaves differently in
 * production on PostgreSQL.
 *
 * Two vocabularies, opposite answers:
 *
 * - **Money is exact**, so it is stored as *integer minor units* — cents,
 *   satoshis. `$19.99` is `1999`. A money field declared `= 0.0` becomes a
 *   float column, which reintroduces binary-fraction error into amounts that
 *   must balance, and invites callers to write major units.
 * - **Rates are inherently fractional** — `taxRate`, `confidence`, a percentage
 *   — so they must be DECIMAL. INTEGER would truncate every meaningful value
 *   (a confidence in `[0, 1]` collapses to 0 or 1) and PostgreSQL rejects the
 *   write outright with `22P02`.
 *
 * Matching is head-noun based rather than substring based, which is what keeps
 * it usable as a repo-wide gate: `amountCents` and `totalTokensUsed` name a
 * unit or a count as their head and are left alone, while `totalAmount`,
 * `amountPaid` and a bare `total` are money. JSDoc prose is deliberately NOT
 * matched — the head-noun signal is precise, and scanning prose for the same
 * vocabulary would make the gate fire on documentation wording.
 */

import type { RawClassDefinition, RawFieldDefinition } from './types.js';

/**
 * Head nouns that denote an exact monetary quantity, stored as integer minor
 * units.
 *
 * `tax` is money (a tax *amount*); `taxRate` is not, and the rate vocabulary
 * below wins whenever both appear, so the two never collide.
 */
const MONEY_HEAD_WORDS = new Set([
  'amount',
  'balance',
  'cost',
  'discount',
  'due',
  'fee',
  'paid',
  'price',
  'subtotal',
  'tax',
  'total',
]);

/**
 * Head nouns that denote an inherently fractional quantity, stored as DECIMAL.
 *
 * A name carrying any of these is a rate even when it also carries a money word
 * (`taxRate`, `feePercentage`), because the rate is what the value *is*.
 */
const RATE_WORDS = new Set([
  'confidence',
  'credibility',
  'probability',
  'rate',
  'ratio',
]);

/**
 * Deliberately NOT rate words: `weight`, `score`, `factor`, `percent`.
 *
 * Each is commonly a whole number — an ad-rotation `weight` of 1, a score out
 * of 100, a percent as 0–100 — so treating them as necessarily fractional
 * produces false positives on correct code. `AdVariation.weight = 1` is the
 * worked example. They are left unclassified rather than guessed at.
 */

/**
 * Words that may trail a head noun without displacing it.
 *
 * `amountPaid` is still an amount; `amountCents` is not — its head noun already
 * names the exact unit — which is why this is an allowlist rather than a
 * blocklist of unit words.
 */
const TRAILING_QUALIFIERS = new Set([
  'applied',
  'billed',
  'charged',
  'collected',
  'earned',
  'gross',
  'net',
  'outstanding',
  'owed',
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

/** Which rule a field falls under, if any. */
export type NumericPrecisionKind = 'money' | 'rate';

/** One field whose declared precision contradicts its name. */
export interface NumericPrecisionFinding {
  /** `money` wants INTEGER minor units; `rate` wants DECIMAL. */
  kind: NumericPrecisionKind;
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
  /** The initializer that triggered the finding. */
  initializer: string;
  /** Human-readable explanation naming the rule. */
  message: string;
  /** The accepted fixes. */
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
 * Classify an identifier as money, a rate, or neither.
 *
 * The head noun is the last word, or the last word before a trailing qualifier
 * such as `Paid`. A rate word anywhere in the name wins outright: `taxRate` is
 * a rate even though `tax` is money, and that precedence is what stops the two
 * vocabularies from fighting over the same field.
 */
export function classifyNumericFieldName(
  name: string,
): NumericPrecisionKind | undefined {
  const words = splitIdentifierWords(name);
  if (words.some((word) => RATE_WORDS.has(word))) return 'rate';
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index];
    if (MONEY_HEAD_WORDS.has(word)) return 'money';
    if (!TRAILING_QUALIFIERS.has(word)) return undefined;
  }
  return undefined;
}

/**
 * Text a file must contain before it can declare a field this lint reports.
 *
 * `@smrt` is matched without requiring parentheses because the parser accepts
 * the bare identifier form too, and the decorator name is never resolved
 * through an import alias — so the literal text is always present.
 */
const PERSISTED_CLASS_MARKER = /@smrt\b|extends\s+Smrt/;

/** Any numeric initializer. Deliberately does not require a terminator. */
const NUMERIC_INITIALIZER = /=\s*-?\d/;

const ALL_WORDS = [...MONEY_HEAD_WORDS, ...RATE_WORDS];

/**
 * A relevant word starting an identifier — any case, since `Price` and `price`
 * are both legal there. Case-insensitivity also matches prose in comments,
 * which costs a parse and nothing else.
 */
const WORD_AT_START = new RegExp(
  `(?<![A-Za-z])(?:${ALL_WORDS.join('|')})`,
  'i',
);

/**
 * A relevant word after a camel hump (`unitPrice`, `USDPrice`), where it is
 * necessarily capitalized and necessarily preceded by an identifier character.
 * This arm cannot be case-insensitive: `generate` would then match on `rate`.
 *
 * Together the two arms cover exactly the boundaries {@link splitIdentifierWords}
 * cuts on, which is what makes the filter conservative rather than plausible.
 */
const WORD_AFTER_HUMP = new RegExp(
  `(?<=[A-Za-z0-9])(?:${ALL_WORDS.map(
    (word) => word[0].toUpperCase() + word.slice(1),
  ).join('|')})`,
);

/**
 * Cheap pre-filter so callers can skip parsing files that cannot produce a
 * finding.
 *
 * Conservative by construction: every condition here is textually implied by a
 * finding. A reported field lives in a class carrying `@smrt` or
 * `extends Smrt…`, is initialized to a number, and has a money or rate word at
 * one of the boundaries the head-noun splitter cuts on. It may still return
 * `true` for a file the AST pass then clears — that is the intended direction.
 *
 * @param source - Full file contents.
 * @returns `false` only when the file provably cannot produce a finding.
 */
export function sourceMayContainNumericPrecisionIssue(source: string): boolean {
  return (
    PERSISTED_CLASS_MARKER.test(source) &&
    NUMERIC_INITIALIZER.test(source) &&
    (WORD_AT_START.test(source) || WORD_AFTER_HUMP.test(source))
  );
}

/**
 * Blank out string-literal contents so option *keys* can be matched without
 * prose inside a value masquerading as one.
 *
 * `@field({ description: 'Discount type: percent or flat' })` otherwise reads
 * as an explicit `type:` and silently suppresses a real finding — and
 * `description` is a shipped option (#2046), so this is reachable, not
 * hypothetical. Quote characters are preserved to keep offsets stable.
 */
function blankStringLiterals(text: string): string {
  return text.replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, (match) =>
    match[0].repeat(match.length),
  );
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
    const args = blankStringLiterals(decorator.arguments.join(' '));
    // An explicit declaration of intent is exactly what this lint asks for,
    // whichever type was chosen.
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

/** Is this a plain `number` column whose type came from the literal? */
function usesLiteralInference(field: RawFieldDefinition): boolean {
  if (field.numericValue === null) return false;
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
  // `$` is a legal identifier character and a regex anchor, so the name has to
  // be escaped rather than interpolated raw.
  const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(
    `^\\s*(?:(?:public|private|protected|readonly|declare|override)\\s+)*${escapedName}\\s*[?!]?\\s*(?::[^=;]+)?=\\s*-?\\d`,
  );
  const lines = sourceText.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (declaration.test(lines[index])) return index + 1;
  }
  return 0;
}

function describeMoneyFinding(
  cls: RawClassDefinition,
  field: RawFieldDefinition,
): Pick<NumericPrecisionFinding, 'message' | 'remedy'> {
  const whole = Math.trunc(field.numericValue ?? 0);
  return {
    message:
      `${cls.className}.${field.name} is a money field with a decimal ` +
      `initializer (= ${field.initializer ?? field.numericValue}), so SMRT ` +
      'compiles it to a floating-point column. Money is exact and is stored ' +
      'as integer minor units (cents, satoshis) — $19.99 is 1999 — so a float ' +
      'column reintroduces binary-fraction error into amounts that must ' +
      'balance.',
    remedy:
      `Write an integer initializer (\`${field.name} = ${whole}\`) and treat ` +
      'the value as minor units, or state the intent explicitly with ' +
      "`@field({ type: 'decimal' })` when the value really is fractional.",
  };
}

function describeRateFinding(
  cls: RawClassDefinition,
  field: RawFieldDefinition,
): Pick<NumericPrecisionFinding, 'message' | 'remedy'> {
  return {
    message:
      `${cls.className}.${field.name} is a rate with an integer initializer ` +
      `(= ${field.numericValue}), so SMRT compiles it to an INTEGER column. A ` +
      'rate is inherently fractional, so every meaningful value truncates; ' +
      'PostgreSQL rejects the save with 22P02 while SQLite silently accepts it.',
    remedy:
      `Write a decimal initializer (\`${field.name} = ${field.numericValue}.0\`) ` +
      'to get a DECIMAL column, or state the intent explicitly with ' +
      "`@field({ type: 'integer' })` when the value really is a whole count.",
  };
}

/**
 * Report every persisted `number` field whose declared precision contradicts
 * its name — money declared decimal, or a rate declared integer.
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
      if (!usesLiteralInference(field)) continue;
      const kind = classifyNumericFieldName(field.name);
      if (!kind) continue;
      // Money wants an integer literal; a rate wants a decimal one. A field
      // already on the right side of its rule is fine.
      if (kind === 'money' && !field.hasDecimalPoint) continue;
      if (kind === 'rate' && field.hasDecimalPoint) continue;
      if (isMetaField(field)) continue;
      if (hasExplicitTypeDecorator(field)) continue;
      findings.push({
        kind,
        className: cls.className,
        fieldName: field.name,
        filePath: cls.filePath,
        line: resolveDeclarationLine(sourceText, field.name, field.line),
        initializer: field.initializer ?? String(field.numericValue),
        ...(kind === 'money'
          ? describeMoneyFinding(cls, field)
          : describeRateFinding(cls, field)),
      });
    }
  }
  return findings;
}
