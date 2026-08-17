/**
 * Regression tests for the money/rate integer-heuristic lint (#2361).
 *
 * The bug this guards: `subtotal: number = 0` silently compiles to an INTEGER
 * column, PostgreSQL rejects `19.99` with 22P02, and SQLite's affinity hides it
 * from every SQLite-only suite. The lint has to be precise enough to run as a
 * fail-closed gate over the whole monorepo, so the negative cases below matter
 * as much as the positive ones.
 */

import { describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import {
  hasMonetaryHeadNoun,
  lintNumericPrecision,
  sourceMayContainMonetaryIntegerField,
  splitIdentifierWords,
} from '../numeric-precision-lint.js';
import { parseSource } from '../oxc-parser.js';

function lintSource(source: string) {
  const result = parseSource(source, 'model.ts');
  expect(result.errors).toHaveLength(0);
  return lintNumericPrecision(result.classes, source);
}

describe('splitIdentifierWords', () => {
  it('splits camelCase, acronyms and underscores into lowercase words', () => {
    expect(splitIdentifierWords('totalAmountCents')).toEqual([
      'total',
      'amount',
      'cents',
    ]);
    expect(splitIdentifierWords('USDPriceLocked')).toEqual([
      'usd',
      'price',
      'locked',
    ]);
    expect(splitIdentifierWords('paused_total_seconds')).toEqual([
      'paused',
      'total',
      'seconds',
    ]);
  });
});

describe('hasMonetaryHeadNoun', () => {
  it('matches when the monetary word is the head noun', () => {
    for (const name of [
      'amount',
      'subtotal',
      'taxAmount',
      'totalAmount',
      'unitPrice',
      'taxRate',
      'discount',
      'confidence',
      'price',
      'total',
      'hourlyRate',
    ]) {
      expect(hasMonetaryHeadNoun(name), name).toBe(true);
    }
  });

  it('looks past trailing qualifiers that do not displace the head', () => {
    expect(hasMonetaryHeadNoun('amountPaid')).toBe(true);
    expect(hasMonetaryHeadNoun('amountRemaining')).toBe(true);
    expect(hasMonetaryHeadNoun('totalDue')).toBe(true);
  });

  it('does not match when the head noun names a unit or a count', () => {
    // These are the shapes `sales`, `chat` and `support` use deliberately.
    for (const name of [
      'amountCents',
      'baseAmountCents',
      'commissionTotalCents',
      'totalAmountCents',
      'grossAmountCents',
      'totalTokensUsed',
      'pausedTotalSeconds',
      'totalCalls',
      'totalSignals',
      'priceLockWindowMs',
      'rateLimitAttempts',
    ]) {
      expect(hasMonetaryHeadNoun(name), name).toBe(false);
    }
  });

  it('does not match unrelated identifiers that merely contain the letters', () => {
    for (const name of [
      'corporateId',
      'aggregateVersion',
      'separator',
      'sortOrder',
      'expMonth',
      'leadTimeDays',
      'remindersSent',
      'syntaxMode',
    ]) {
      expect(hasMonetaryHeadNoun(name), name).toBe(false);
    }
  });
});

describe('lintNumericPrecision', () => {
  it('flags the exact shape that broke commerce: a money field with `= 0`', () => {
    const findings = lintSource(`
      @smrt()
      class Invoice extends SmrtObject {
        subtotal: number = 0;
        taxAmount: number = 0;
        totalAmount: number = 0;
        amountPaid: number = 0;
      }
    `);

    expect(findings.map((f) => f.fieldName)).toEqual([
      'subtotal',
      'taxAmount',
      'totalAmount',
      'amountPaid',
    ]);
    expect(findings[0].className).toBe('Invoice');
  });

  it('recovers declaration lines from source text the AST cannot supply', () => {
    // OXC nodes reach the scanner without `loc`, so `field.line` is 0; a
    // finding that cannot point at a line is far harder to act on.
    const source = [
      '@smrt()',
      'class Invoice extends SmrtObject {',
      '  reference: string = "";',
      '  totalAmount: number = 0;',
      '}',
    ].join('\n');

    const parsed = parseSource(source, 'model.ts');
    expect(lintNumericPrecision(parsed.classes, source)[0].line).toBe(4);
    expect(lintNumericPrecision(parsed.classes)[0].line).toBe(0);
  });

  it('points at the 0 / 0.0 rule and both accepted fixes', () => {
    const [finding] = lintSource(`
      @smrt()
      class Ledger extends SmrtObject {
        total: number = 0;
      }
    `);

    expect(finding.message).toContain('INTEGER');
    expect(finding.message).toContain('22P02');
    expect(finding.remedy).toContain('total = 0.0');
    expect(finding.remedy).toContain("@field({ type: 'integer' })");
  });

  it('flags a bare numeric initializer with no type annotation', () => {
    // `products/Product.ts` declared `price = 0` — inference step 3.5.
    const findings = lintSource(`
      @smrt()
      class Product extends SmrtObject {
        price = 0;
      }
    `);

    expect(findings).toHaveLength(1);
    expect(findings[0].fieldName).toBe('price');
  });

  it('accepts a decimal initializer', () => {
    expect(
      lintSource(`
        @smrt()
        class Invoice extends SmrtObject {
          subtotal: number = 0.0;
          taxRate: number = 0.0;
          quantity: number = 1.0;
        }
      `),
    ).toEqual([]);
  });

  it('accepts an explicitly declared type, integer included', () => {
    // Integer cents is a legitimate answer; the lint asks for a decision, not
    // for a particular one.
    expect(
      lintSource(`
        @smrt()
        class Commission extends SmrtObject {
          @field({ type: 'integer' })
          amount: number = 0;

          @field({ type: 'decimal' })
          rate: number = 0;
        }
      `),
    ).toEqual([]);
  });

  it('is not fooled by "type:" inside a description string', () => {
    // `description` is a shipped `@field` option (#2046). Substring-matching
    // the raw decorator text would read this as an explicit type and suppress
    // the finding — silently, which is the worst outcome for this gate.
    const findings = lintSource(`
      @smrt()
      class Quote extends SmrtObject {
        @field({ description: 'Discount type: percentage or flat' })
        discount: number = 0;
      }
    `);

    expect(findings.map((f) => f.fieldName)).toEqual(['discount']);
  });

  it('ignores transient, meta and relationship fields', () => {
    expect(
      lintSource(`
        @smrt()
        class Quote extends SmrtObject {
          @field({ transient: true })
          totalAmount: number = 0;

          @meta()
          discount: number = 0;

          costPerUnit: Meta<number> = 0;
        }
      `),
    ).toEqual([]);
  });

  it('ignores static members and classes that are not persisted', () => {
    expect(
      lintSource(`
        @smrt()
        class Invoice extends SmrtObject {
          static defaultTaxRate: number = 0;
        }

        class InvoiceCalculator {
          totalAmount: number = 0;
        }
      `),
    ).toEqual([]);
  });

  it('covers a persisted base class that carries no @smrt() decorator', () => {
    const findings = lintSource(`
      abstract class BillableLine extends SmrtObject {
        unitPrice: number = 0;
      }
    `);

    expect(findings.map((f) => f.fieldName)).toEqual(['unitPrice']);
  });

  it("agrees with the manifest adapter's inferred column type", () => {
    // The lint is only worth trusting if it fires exactly when the adapter
    // would produce `integer`, so assert both halves against one source.
    const source = `
      @smrt()
      class Invoice extends SmrtObject {
        subtotal: number = 0;
        taxAmount: number = 0.0;
      }
    `;
    const parsed = parseSource(source, 'model.ts');
    const adapter = new ManifestAdapter();
    const fields = parsed.classes[0].fields;
    const inferred = Object.fromEntries(
      fields.map((field) => [field.name, adapter.inferFieldType(field).type]),
    );

    expect(inferred).toEqual({ subtotal: 'integer', taxAmount: 'decimal' });
    expect(
      lintNumericPrecision(parsed.classes).map((f) => f.fieldName),
    ).toEqual(['subtotal']);
  });
});

describe('sourceMayContainMonetaryIntegerField', () => {
  const model = (field: string) =>
    ['@smrt()', 'class M extends SmrtObject {', `  ${field}`, '}', ''].join(
      '\n',
    );

  /**
   * The property that makes this filter safe: it must never skip a file the
   * AST pass would flag. A `false` here is invisible — the finding simply never
   * appears — so every shape the lint reports is asserted through both paths.
   */
  it('never skips a source the lint would flag', () => {
    const flaggable = [
      'totalAmount: number = 0;',
      'unitPrice: number = 0;', // capitalized word mid-identifier
      'USDPrice: number = 0;', // capitalized word after an acronym
      'tax_rate: number = 0;', // underscore boundary
      'price = 0 // catalog price', // no terminator, trailing comment
      'subtotal:number=0;', // no whitespace anywhere
      'discount: number = -1;', // negative initializer
      'amountPaid: number =\n    0;', // wrapped initializer
    ];

    for (const field of flaggable) {
      const source = model(field);
      const findings = lintNumericPrecision(
        parseSource(source, 'model.ts').classes,
        source,
      );
      expect(findings.length, `AST should flag: ${field}`).toBeGreaterThan(0);
      expect(
        sourceMayContainMonetaryIntegerField(source),
        `pre-filter must not skip: ${field}`,
      ).toBe(true);
    }
  });

  it('recognizes the parenthesis-free decorator form the parser accepts', () => {
    // `@smrt` without a call is a valid decorator to the scanner, so a marker
    // that demanded `@smrt(` would skip this file silently.
    const source = [
      '@smrt',
      'class Ledger {',
      '  total: number = 0;',
      '}',
      '',
    ].join('\n');

    expect(
      lintNumericPrecision(parseSource(source, 'model.ts').classes, source),
    ).toHaveLength(1);
    expect(sourceMayContainMonetaryIntegerField(source)).toBe(true);
  });

  it('skips sources that cannot produce a finding', () => {
    // No persisted-class marker, no numeric initializer, no monetary word —
    // each condition alone is enough to skip.
    expect(sourceMayContainMonetaryIntegerField('const total = 0;')).toBe(
      false,
    );
    expect(sourceMayContainMonetaryIntegerField(model("total = '';"))).toBe(
      false,
    );
    expect(sourceMayContainMonetaryIntegerField(model('retries = 0;'))).toBe(
      false,
    );
  });

  it('stays permissive where cheap text cannot decide', () => {
    // `= 0.0` is already correct, but the filter cannot tell `0` from `0.0`
    // without parsing — and erring toward parsing is the safe direction.
    expect(sourceMayContainMonetaryIntegerField(model('total = 0.0;'))).toBe(
      true,
    );
  });

  it('is not fooled by monetary letters inside unrelated words', () => {
    // `generate`/`separator`/`corporate` all contain "rate"; matching them
    // would make the filter useless rather than unsafe, so this guards cost.
    expect(
      sourceMayContainMonetaryIntegerField(
        model('separator = 0;\n  // generate a corporate aggregate'),
      ),
    ).toBe(false);
  });
});
