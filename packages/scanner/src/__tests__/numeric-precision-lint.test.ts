/**
 * Regression tests for the money/rate precision lint (#2361).
 *
 * Two rules pointing opposite ways, which is what makes the classification
 * worth testing hard:
 *
 * - money is exact and stored as integer minor units, so `subtotal = 0.0` is
 *   wrong;
 * - a rate is inherently fractional, so `taxRate = 0` is wrong — it truncates
 *   every value and PostgreSQL rejects the save with 22P02 while SQLite's
 *   affinity hides it.
 *
 * The lint runs over the whole monorepo, so the negative cases below matter as
 * much as the positive ones.
 */

import { describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import {
  classifyNumericFieldName,
  lintNumericPrecision,
  sourceMayContainNumericPrecisionIssue,
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

describe('classifyNumericFieldName', () => {
  it('classifies money by head noun', () => {
    for (const name of [
      'amount',
      'subtotal',
      'taxAmount',
      'totalAmount',
      'unitPrice',
      'discount',
      'price',
      'total',
      'creditLimitBalance',
    ]) {
      expect(classifyNumericFieldName(name), name).toBe('money');
    }
  });

  it('looks past trailing qualifiers that do not displace the head', () => {
    expect(classifyNumericFieldName('amountPaid')).toBe('money');
    expect(classifyNumericFieldName('amountRemaining')).toBe('money');
    expect(classifyNumericFieldName('totalOutstanding')).toBe('money');
  });

  it('classifies rates, and lets a rate word beat a money word', () => {
    // `taxRate` carries both vocabularies; the rate is what the value *is*.
    expect(classifyNumericFieldName('taxRate')).toBe('rate');
    expect(classifyNumericFieldName('confidence')).toBe('rate');
    expect(classifyNumericFieldName('credibility')).toBe('rate');
    expect(classifyNumericFieldName('conversionRatio')).toBe('rate');
    expect(classifyNumericFieldName('hourlyRate')).toBe('rate');
  });

  it('leaves a unit or count head noun unclassified', () => {
    // The shapes `sales`, `chat` and `support` use deliberately.
    for (const name of [
      'amountCents',
      'baseAmountCents',
      'commissionTotalCents',
      'totalAmountCents',
      'grossAmountCents',
      'totalTokensUsed',
      'pausedTotalSeconds',
      'totalCalls',
      'priceLockWindowMs',
    ]) {
      expect(classifyNumericFieldName(name), name).toBeUndefined();
    }
  });

  it('does not guess at words that are commonly whole numbers', () => {
    // `AdVariation.weight = 1` is a correct integer; calling these rates would
    // fail closed on working code.
    for (const name of [
      'weight',
      'score',
      'healthScore',
      'factor',
      'percentComplete',
      'sortOrder',
      'remindersSent',
    ]) {
      expect(classifyNumericFieldName(name), name).toBeUndefined();
    }
  });

  it('does not match unrelated identifiers that merely contain the letters', () => {
    for (const name of [
      'corporateId',
      'aggregateVersion',
      'separator',
      'expMonth',
      'leadTimeDays',
      'syntaxMode',
    ]) {
      expect(classifyNumericFieldName(name), name).toBeUndefined();
    }
  });
});

describe('lintNumericPrecision — money must be integer minor units', () => {
  it('flags a money field declared decimal', () => {
    const findings = lintSource(`
      @smrt()
      class Invoice extends SmrtObject {
        subtotal: number = 0.0;
        taxAmount: number = 0.0;
        totalAmount: number = 0.0;
        amountPaid: number = 0.0;
      }
    `);

    expect(findings.map((f) => f.fieldName)).toEqual([
      'subtotal',
      'taxAmount',
      'totalAmount',
      'amountPaid',
    ]);
    expect(findings.every((f) => f.kind === 'money')).toBe(true);
  });

  it('names the minor-units rule and both accepted fixes', () => {
    const [finding] = lintSource(`
      @smrt()
      class Ledger extends SmrtObject {
        total: number = 0.0;
      }
    `);

    expect(finding.message).toContain('minor units');
    expect(finding.message).toContain('1999');
    expect(finding.remedy).toContain('total = 0');
    expect(finding.remedy).toContain("@field({ type: 'decimal' })");
  });

  it('accepts an integer initializer', () => {
    expect(
      lintSource(`
        @smrt()
        class Invoice extends SmrtObject {
          subtotal: number = 0;
          totalAmount: number = 0;
          price = 0;
        }
      `),
    ).toEqual([]);
  });
});

describe('lintNumericPrecision — rates must be decimal', () => {
  it('flags a rate declared integer', () => {
    const findings = lintSource(`
      @smrt()
      class Line extends SmrtObject {
        taxRate: number = 0;
        confidence: number = 0;
      }
    `);

    expect(findings.map((f) => f.fieldName)).toEqual(['taxRate', 'confidence']);
    expect(findings.every((f) => f.kind === 'rate')).toBe(true);
    expect(findings[0].message).toContain('22P02');
    expect(findings[0].remedy).toContain('taxRate = 0.0');
  });

  it('accepts a decimal initializer', () => {
    expect(
      lintSource(`
        @smrt()
        class Line extends SmrtObject {
          taxRate: number = 0.0;
          confidence: number = 0.0;
        }
      `),
    ).toEqual([]);
  });
});

describe('lintNumericPrecision — exemptions', () => {
  it('accepts an explicitly declared type, either direction', () => {
    expect(
      lintSource(`
        @smrt()
        class Commission extends SmrtObject {
          @field({ type: 'decimal' })
          amount: number = 0.0;

          @field({ type: 'integer' })
          taxRate: number = 0;
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
        discount: number = 0.0;
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
          totalAmount: number = 0.0;

          @meta()
          discount: number = 0.0;

          costPerUnit: Meta<number> = 0.0;
        }
      `),
    ).toEqual([]);
  });

  it('ignores static members and classes that are not persisted', () => {
    expect(
      lintSource(`
        @smrt()
        class Invoice extends SmrtObject {
          static defaultTotal: number = 0.0;
        }

        class InvoiceCalculator {
          totalAmount: number = 0.0;
        }
      `),
    ).toEqual([]);
  });

  it('covers a persisted base class that carries no @smrt() decorator', () => {
    const findings = lintSource(`
      abstract class BillableLine extends SmrtObject {
        unitPrice: number = 0.0;
      }
    `);

    expect(findings.map((f) => f.fieldName)).toEqual(['unitPrice']);
  });

  it("agrees with the manifest adapter's inferred column type", () => {
    // The lint is only worth trusting if it fires exactly when the adapter
    // would produce the wrong column type, so assert both halves at once.
    const source = `
      @smrt()
      class Invoice extends SmrtObject {
        subtotal: number = 0.0;
        totalAmount: number = 0;
        taxRate: number = 0;
      }
    `;
    const parsed = parseSource(source, 'model.ts');
    const adapter = new ManifestAdapter();
    const inferred = Object.fromEntries(
      parsed.classes[0].fields.map((field) => [
        field.name,
        adapter.inferFieldType(field).type,
      ]),
    );

    expect(inferred).toEqual({
      subtotal: 'decimal',
      totalAmount: 'integer',
      taxRate: 'integer',
    });
    expect(
      lintNumericPrecision(parsed.classes, source).map((f) => [
        f.fieldName,
        f.kind,
      ]),
    ).toEqual([
      ['subtotal', 'money'],
      ['taxRate', 'rate'],
    ]);
  });
});

describe('sourceMayContainNumericPrecisionIssue', () => {
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
      'totalAmount: number = 0.0;',
      'unitPrice: number = 0.0;', // capitalized word mid-identifier
      'USDPrice: number = 0.0;', // capitalized word after an acronym
      'Price: number = 0.0;', // PascalCase — capitalized word starting the name
      'tax_rate: number = 0;', // underscore boundary, rate direction
      'price = 0.0 // catalog price', // no terminator, trailing comment
      'subtotal:number=0.0;', // no whitespace anywhere
      'amountPaid: number =\n    0.0;', // wrapped initializer
    ];

    for (const field of flaggable) {
      const source = model(field);
      const findings = lintNumericPrecision(
        parseSource(source, 'model.ts').classes,
        source,
      );
      expect(findings.length, `AST should flag: ${field}`).toBeGreaterThan(0);
      expect(
        sourceMayContainNumericPrecisionIssue(source),
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
      '  total: number = 0.0;',
      '}',
      '',
    ].join('\n');

    expect(
      lintNumericPrecision(parseSource(source, 'model.ts').classes, source),
    ).toHaveLength(1);
    expect(sourceMayContainNumericPrecisionIssue(source)).toBe(true);
  });

  it('skips sources that cannot produce a finding', () => {
    // No persisted-class marker, no numeric initializer, no relevant word —
    // each condition alone is enough to skip.
    expect(sourceMayContainNumericPrecisionIssue('const total = 0.0;')).toBe(
      false,
    );
    expect(sourceMayContainNumericPrecisionIssue(model("total = '';"))).toBe(
      false,
    );
    expect(sourceMayContainNumericPrecisionIssue(model('retries = 0;'))).toBe(
      false,
    );
  });

  it('is not fooled by monetary letters inside unrelated words', () => {
    // `generate`/`separator`/`corporate` all contain "rate"; matching them
    // would make the filter useless rather than unsafe, so this guards cost.
    expect(
      sourceMayContainNumericPrecisionIssue(
        model('separator = 0;\n  // generate a corporate aggregate'),
      ),
    ).toBe(false);
  });
});
