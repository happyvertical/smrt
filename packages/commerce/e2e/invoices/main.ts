import { mount } from 'svelte';
import '@happyvertical/smrt-ui/themes/styles/material.css';
import Harness from './Harness.svelte';
import { moneyFixture } from './fixture.js';
import InvoiceRecordHarness from './InvoiceRecordHarness.svelte';
import TaxSummaryBrowserHarness from './TaxSummaryBrowserHarness.svelte';
const params = new URLSearchParams(location.search);
const colorScheme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = 'material';
document.documentElement.dataset.colorScheme = colorScheme;
if (params.get('report') === 'tax-summary') mount(TaxSummaryBrowserHarness, { target: document.getElementById('app')! });
else if (params.get('record') === 'invoice' || params.get('record') === 'credit') mount(InvoiceRecordHarness, { target: document.getElementById('app')!, props: { sourceKind: params.get('record') === 'credit' ? 'credit_note' : 'invoice' } });
else {
  const money = (params.get('money') ?? 'A') as 'A' | 'B' | 'C' | 'D' | 'E';
  const roundingScope = params.get('scope') === 'document' ? 'document' : 'line';
  mount(Harness, { target: document.getElementById('app')!, props: {
    colorScheme,
    initial: { money: moneyFixture(money, roundingScope, params.get('frozen') === '1'), action: '/save-money' },
  } });
}
