import { mount } from 'svelte';
import '@happyvertical/smrt-ui/themes/styles/material.css';
import Harness from './Harness.svelte';
import { invoiceRoundingValues } from './fixture.js';
import LineHarness from './LineHarness.svelte';
if (location.search === '?line=1') mount(LineHarness, { target: document.getElementById('app')! });
else mount(Harness, { target: document.getElementById('app')!, props: { initial: location.search === '?rounding=invoice' ? { values: invoiceRoundingValues, roundingScope: 'invoice', action: '/save-invoice-rounding' } : {} } });
