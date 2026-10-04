import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import * as publicUI from '@happyvertical/smrt-commerce/svelte';
import type { Estimate } from '../src/models/Contract.js';
import { JSDOM } from 'jsdom';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import QuoteEditor from '../src/svelte/components/QuoteEditor.svelte';
import QuoteRevisionComparison from '../src/svelte/components/QuoteRevisionComparison.svelte';
import QuoteRevisionHistory from '../src/svelte/components/QuoteRevisionHistory.svelte';
import {
  type QuoteDraftValues,
  type QuoteRevision,
  quoteMinorText,
  quoteRevisionDelta,
} from '../src/svelte/quote-types.js';

const values: QuoteDraftValues = {
  counterpartyId: 'vendor-1',
  reference: 'Q-42',
  date: 'not-a-date',
  validUntil: '',
  currency: 'CAD',
  total: '12..50',
  tax: '0',
  scope: 'Retained scope',
  inclusions: '',
  exclusions: '',
  reason: 'Retry',
  lines: [
    {
      id: 'line-a',
      description: 'Design',
      quantity: '1.5',
      unitRate: 'bad rate',
    },
  ],
};
const revision: QuoteRevision = {
  id: 'rev-1',
  kind: 'vendor-quotation',
  label: 'Version 1',
  counterparty: 'Acme',
  status: 'new-future-status',
  total: { currency: 'CAD', minorUnitDigits: 2, amountMinor: 1250 },
};
function documentOf(body: string) {
  return new JSDOM(body).window.document;
}

describe('quote presentation contract', () => {
  it('exports and discovers public quote components with real Estimate money fields', () => {
    expect(render(publicUI.QuoteEditor, {props:{kind:'vendor-quotation',values,action:'/quote',counterparties:[]}}).body).toContain('Vendor quotation');
    expect(ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'quote-revision-comparison')).toBe(publicUI.QuoteRevisionComparison);
    const estimate: Pick<Estimate, 'currency' | 'totalAmount'> = { currency: 'KWD', totalAmount: 1250 };
    expect(publicUI.quoteMinorText({ currency: estimate.currency, amountMinor: estimate.totalAmount, minorUnitDigits: 3 })).toBe('1.250');
  });

  it('renders mapped native fields and preserves failed input, repeatable tokens and row actions', () => {
    const { body } = render(QuoteEditor, {
      props: {
        kind: 'vendor-quotation',
        values,
        action: '/quotes?/save',
        counterparties: [{ id: 'vendor-1', label: 'Acme' }],
        names: { counterpartyId: 'vendorId' },
        hiddenFields: [
          { name: 'requestId', value: 'same-retry-id' },
          { name: 'sourceIds', value: 'one' },
          { name: 'sourceIds', value: 'two' },
        ],
        errors: { total: 'Invalid money' },
        message: 'Write outcome uncertain',
      },
    });
    const doc = documentOf(body);
    expect(doc.querySelector('form')?.getAttribute('action')).toBe(
      '/quotes?/save',
    );
    expect(doc.querySelector('form')?.getAttribute('method')).toBe('post');
    expect(doc.querySelector<HTMLInputElement>('[name=total]')?.value).toBe(
      '12..50',
    );
    expect(doc.querySelector<HTMLInputElement>('[name=date]')?.value).toBe(
      'not-a-date',
    );
    expect(
      doc.querySelector<HTMLSelectElement>('select[name=currency]')?.value,
    ).toBe('CAD');
    expect(
      doc.querySelector<HTMLInputElement>('[name=lineUnitRate]')?.value,
    ).toBe('bad rate');
    expect(
      doc.querySelector('select[name=vendorId] option[selected]')?.textContent,
    ).toBe('Acme');
    expect(doc.querySelector<HTMLInputElement>('[name=requestId]')?.value).toBe(
      'same-retry-id',
    );
    expect(doc.querySelectorAll('[name=sourceIds]')).toHaveLength(2);
    expect(
      doc
        .querySelector('button[value=addLine]')
        ?.hasAttribute('formnovalidate'),
    ).toBe(true);
    expect(
      doc
        .querySelector('button[value="removeLine:line-a"]')
        ?.hasAttribute('formnovalidate'),
    ).toBe(true);
    expect(
      doc.querySelector('[name=total]')?.getAttribute('aria-invalid'),
    ).toBe('true');
    expect(doc.body.textContent).toContain('Write outcome uncertain');
    expect(doc.body.textContent).toContain(
      'does not select pricing or award work',
    );
  });
  it('preserves an unknown retained currency as a native selected option', () => {
    const doc = documentOf(
      render(QuoteEditor, {
        props: {
          kind: 'vendor-quotation',
          values: { ...values, currency: 'ZZZ' },
          action: '/quotes',
          counterparties: [],
          currencyOptions: [{ value: 'CAD', label: 'Canadian dollar only' }],
        },
      }).body,
    );
    expect(
      doc.querySelector<HTMLSelectElement>('select[name=currency]')?.value,
    ).toBe('ZZZ');
    expect(doc.body.textContent).toContain('Canadian dollar only');
  });
  it('renders estimates with caller terminology, no financial acceptance and disabled read-only fields', () => {
    const { body } = render(QuoteEditor, {
      props: {
        kind: 'customer-estimate',
        values: { ...values, lines: [] },
        action: '/estimates',
        counterparties: [],
        readonly: true,
        labels: { counterparty: 'Client' },
      },
    });
    const doc = documentOf(body);
    expect(doc.body.textContent).toContain('Customer estimate');
    expect(doc.body.textContent).toContain('Client');
    expect(doc.body.textContent).toContain('No source lines supplied.');
    expect(doc.querySelector('fieldset')?.disabled).toBe(true);
    expect(doc.querySelector('button[type=submit]')).toBeNull();
    expect(doc.querySelector('select option[selected]')?.textContent).toBe(
      'vendor-1',
    );
  });
  it('preserves unknown states and explicit unknown amounts in revision history', () => {
    const { body } = render(QuoteRevisionHistory, {
      props: {
        revisions: [
          { ...revision, total: { ...revision.total, amountMinor: null } },
        ],
      },
    });
    expect(body).toContain('new-future-status');
    expect(body).toContain('Unknown');
    expect(body).not.toContain('0.00');
    expect(
      render(QuoteRevisionHistory, { props: { revisions: [] } }).body,
    ).toContain('No revisions yet.');
  });
  it('compares both retained scopes and exact totals without write actions', () => {
    const { body } = render(QuoteRevisionComparison, {
      props: {
        previous: { ...revision, scope: 'Old scope' },
        current: {
          ...revision,
          id: 'rev-2',
          scope: 'New scope',
          total: { ...revision.total, amountMinor: 1500 },
        },
      },
    });
    expect(body).toContain('Old scope');
    expect(body).toContain('New scope');
    expect(body).toContain('2.50');
    expect(documentOf(body).querySelector('form')).toBeNull();
  });
  it('refuses a misleading cross-currency comparison', () => {
    const current = {
      ...revision,
      total: { ...revision.total, currency: 'USD' },
    };
    expect(quoteRevisionDelta(revision, current)).toBeNull();
    expect(
      render(QuoteRevisionComparison, {
        props: { previous: revision, current },
      }).body,
    ).toContain('Totals cannot be compared');
  });
  it('formats zero/two/three decimal scales exactly, including maximum safe values', () => {
    expect(
      quoteMinorText({
        currency: 'JPY',
        minorUnitDigits: 0,
        amountMinor: 1250,
      }),
    ).toBe('1250');
    expect(
      quoteMinorText({
        currency: 'KWD',
        minorUnitDigits: 3,
        amountMinor: 1250,
      }),
    ).toBe('1.250');
    expect(
      quoteMinorText({ currency: 'CAD', minorUnitDigits: 2, amountMinor: -1 }),
    ).toBe('-0.01');
    expect(
      quoteMinorText({
        currency: 'CAD',
        minorUnitDigits: 2,
        amountMinor: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe('90071992547409.91');
    expect(() =>
      quoteMinorText({ currency: 'CAD', minorUnitDigits: 2, amountMinor: 1.2 }),
    ).toThrow(RangeError);
    expect(() =>
      quoteMinorText({
        currency: 'CAD',
        minorUnitDigits: -1,
        amountMinor: null,
      }),
    ).toThrow(RangeError);
    expect(
      quoteRevisionDelta(revision, { ...revision, kind: 'customer-estimate' }),
    ).toBeNull();
    expect(
      quoteRevisionDelta(revision, {
        ...revision,
        total: { ...revision.total, minorUnitDigits: 3 },
      }),
    ).toBeNull();
    expect(
      quoteRevisionDelta(revision, {
        ...revision,
        total: { ...revision.total, amountMinor: null },
      }),
    ).toBeNull();
  });
});

describe('invalid money presentation recovery', () => {
  const invalid = [
    { amountMinor: 1.5 }, { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { amountMinor: NaN }, { amountMinor: Infinity },
    { minorUnitDigits: -1 }, { minorUnitDigits: 9 },
    { minorUnitDigits: 1.5 }, { minorUnitDigits: NaN },
  ];
  it.each(invalid)('history renders unavailable for %j without relaxing the helper', (patch) => {
    const bad = { ...revision, total: { ...revision.total, ...patch } };
    expect(() => quoteMinorText(bad.total)).toThrow(RangeError);
    expect(render(QuoteRevisionHistory, { props: { revisions: [bad] } }).body).toContain('Amount unavailable');
  });
  it.each(invalid)('comparison recovers either invalid side for %j', (patch) => {
    const bad = { ...revision, id: 'bad', total: { ...revision.total, ...patch } };
    for (const [previous, current] of [[revision, bad], [bad, revision]]) {
      expect(() => quoteRevisionDelta(previous, current)).toThrow(RangeError);
      expect(render(QuoteRevisionComparison, { props: { previous, current } }).body).toContain('Amount unavailable');
    }
  });
  it('keeps unknown, mixed currency/scale/kind and overflowing differences incomparable', () => {
    for (const current of [
      { ...revision, total: { ...revision.total, amountMinor: null } },
      { ...revision, total: { ...revision.total, currency: 'USD' } },
      { ...revision, total: { ...revision.total, minorUnitDigits: 3 } },
      { ...revision, kind: 'customer-estimate' as const },
      { ...revision, total: { ...revision.total, amountMinor: Number.MIN_SAFE_INTEGER } },
    ]) {
      expect(quoteRevisionDelta(revision, current)).toBeNull();
      expect(render(QuoteRevisionComparison, { props: { previous: revision, current } }).body).toContain('Totals cannot be compared');
    }
  });
  it('preserves zero and exact negative differences', () => {
    for (const [amountMinor, expected] of [[1250, '0.00'], [1200, '-0.50']] as const) {
      const current = { ...revision, total: { ...revision.total, amountMinor } };
      const page = documentOf(render(QuoteRevisionComparison, { props: { previous: revision, current } }).body);
      expect(page.body.textContent).toContain(`Change in total: ${expected} CAD`);
    }
  });
});
