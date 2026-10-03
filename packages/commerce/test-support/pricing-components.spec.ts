import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { PricingVersionDecision, PricingVersionSummary } from '../src/svelte/index.js';
import type { PricingVersionData } from '../src/svelte/pricing-types.js';

const version: PricingVersionData = { id: 'v2', kind: 'customer-estimate', label: 'Version 2', status: 'future-decision-state', counterparty: 'Customer', total: { amountMinor: 9007199254740991, currency: 'CAD', minorUnitDigits: 2 }, sources: [{ id: 'retained', label: 'Unknown retained price', amountMinor: null }] };
const actions = [{ label: 'Request decision', name: 'intent', value: 'caller-action', formAction: '/review' }];

describe('pricing version public contracts', () => {
  it('renders exact saved money and unknown source amounts without inference', () => {
    const html = render(PricingVersionSummary, { props: { version } }).body;
    expect(html).toContain('90071992547409.91');
    expect(html).toContain('future-decision-state');
    expect(html).toContain('Amount unavailable');
    expect(html).toContain('Unknown retained price');
  });
  it('represents empty sources and explicit zero without confusing them with unknown', () => {
    const html = render(PricingVersionSummary, { props: { version: { ...version, sources: undefined, total: { amountMinor: 0, currency: 'JPY', minorUnitDigits: 0 } } } }).body;
    expect(html).toContain('0 JPY');
    expect(html).toContain('No pricing sources supplied');
  });
  it('retains native action, caller identity and failed reason text including repeated fields', () => {
    const html = render(PricingVersionDecision, { props: { version, actions, action: '/decide', reasonName: 'decisionReason', reason: 'Retained <text>', error: 'Source changed', hiddenFields: [{name:'requestId',value:'same-token'},{name:'sourceId',value:'a'},{name:'sourceId',value:'b'}] } }).body;
    expect(html).toContain('action="/decide"');
    expect(html).toContain('formaction="/review"');
    expect(html).toContain('name="intent"');
    expect(html).toContain('value="caller-action"');
    expect(html).toContain('same-token');
    expect(html.match(/name="sourceId"/g)).toHaveLength(2);
    expect(html).toContain('name="decisionReason"');
    expect(html).toContain('Retained &lt;text');
    expect(html).toContain('role="alert"');
  });
  it('read-only viewers receive no hidden request identity or mutation controls', () => {
    const html = render(PricingVersionDecision, { props: { version, actions, action: '/decide', readOnly: true, reason: 'Retained reason', hiddenFields:[{name:'requestId',value:'secret-to-viewer'}] } }).body;
    expect(html).not.toContain('<form');
    expect(html).not.toContain('secret-to-viewer');
    expect(html).toContain('Retained reason');
  });
  it('does not invent decisions when the application supplies none', () => {
    const html = render(PricingVersionDecision, { props: { version, actions: [], action: '/decide' } }).body;
    expect(html).not.toContain('<form');
    expect(html).toContain('No decisions are currently available');
  });
  it('disables submissions while busy without dropping native hidden fields', () => {
    const html = render(PricingVersionDecision, { props: { version, actions, action: '/decide', busy: true, hiddenFields:[{name:'requestId',value:'retained'}] } }).body;
    expect(html).toContain('disabled');
    expect(html).toContain('value="retained"');
  });
  it('keeps summaries available when supplied amounts are fractional or unsafe', () => {
    for (const invalid of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      const html = render(PricingVersionSummary, { props: { version: { ...version, total: { ...version.total, amountMinor: invalid }, sources: [{ id: 'bad', label: 'Invalid source', amountMinor: invalid }] } } }).body;
      expect(html.match(/Amount unavailable/g)).toHaveLength(2);
      expect(html).toContain('Invalid source');
    }
  });
  it('renders an invalid currency scale as unavailable rather than guessing', () => {
    const html = render(PricingVersionSummary, { props: { version: { ...version, total: { ...version.total, minorUnitDigits: 9 } } } }).body;
    expect(html).toContain('Amount unavailable');
  });
  it('registers public slots with the exact exported components', () => {
    expect(ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'pricing-version-summary')).toBe(PricingVersionSummary);
    expect(ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'pricing-version-decision')).toBe(PricingVersionDecision);
  });
});
