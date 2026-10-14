import { mount } from 'svelte';
import '@happyvertical/smrt-ui/themes/styles/material.css';
import Harness from './Harness.svelte';
import { invoiceRoundingValues, moneyFixture } from './fixture.js';
import LineHarness from './LineHarness.svelte';
const params = new URLSearchParams(location.search);
if (params.get('line') === '1') mount(LineHarness, { target: document.getElementById('app')! });
else {
  const money = params.get('money') as 'A' | 'B' | 'C' | 'D' | 'E' | null;
  const roundingScope = params.get('scope') === 'document' ? 'document' : 'line';
  mount(Harness, { target: document.getElementById('app')!, props: {
    colorScheme: params.get('theme') === 'dark' ? 'dark' : 'light',
    initial: money ? { money: moneyFixture(money, roundingScope, params.get('frozen') === '1'), action: '/save-money' } : params.get('rounding') === 'invoice' ? { values: invoiceRoundingValues, roundingScope: 'invoice', action: '/save-invoice-rounding' } : {},
  } });
}
