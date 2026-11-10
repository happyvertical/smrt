import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import QuoteEditor from '../src/svelte/components/QuoteEditor.svelte';

describe('quote money header', () => {
  it('renders inclusive tax and rejects a typed tax that disagrees with line calculation', () => {
    const body = render(QuoteEditor, {
      props: {
        kind: 'customer-estimate',
        action: '/quotes',
        counterparties: [{ id: 'customer', label: 'Customer' }],
        values: {
          counterpartyId: 'customer', reference: 'Q-1', date: '2026-10-13', validUntil: '',
          currency: 'CAD', total: '105.00', tax: '4.00', scope: '', inclusions: '',
          exclusions: '', reason: '',
          lines: [{ id: 'line', description: 'Work', quantity: '1', unitRate: '105.00' }],
        },
        money: { lineAmountType: 'inclusive', taxMinor: 500, totalMinor: 10500, minorUnitDigits: 2 },
      },
    }).body;
    expect(body).toContain('Amounts are tax inclusive');
    expect(body).toContain('Includes tax of 5.00');
    expect(body).toContain('Tax must match calculated line tax.');
    expect(body).toContain('name="lineAmountType"');
  });
});
