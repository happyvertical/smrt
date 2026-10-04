import { mount } from 'svelte';
import PurchasingPlayground from '../src/svelte/components/PurchasingPlayground.svelte';
import PurchasingReviewHarness from './purchasing-review-harness.svelte';
const target = document.getElementById('app');
if (!target) throw new Error('Purchasing fixture requires #app');
if (location.pathname === '/purchase-review-refresh') mount(PurchasingReviewHarness, { target });
else mount(PurchasingPlayground, { target, props: { reduction: true } });
