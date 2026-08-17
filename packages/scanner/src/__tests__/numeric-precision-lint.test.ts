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
  it('lets through sources that could contain a finding', () => {
    expect(
      sourceMayContainMonetaryIntegerField('  totalAmount: number = 0;'),
    ).toBe(true);
  });

  it('skips sources with no integer literal initializer', () => {
    expect(
      sourceMayContainMonetaryIntegerField('  totalAmount: number = 0.0;'),
    ).toBe(false);
  });

  it('skips sources with no monetary vocabulary at all', () => {
    expect(sourceMayContainMonetaryIntegerField('  retries: number = 0;')).toBe(
      false,
    );
  });
});
