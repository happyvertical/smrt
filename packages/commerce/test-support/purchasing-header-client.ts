import { hydrate } from 'svelte';
import Header from '../src/svelte/components/PurchaseOrderHeaderForm.svelte';
const target = document.getElementById('header');
const data = document.getElementById('header-props');
if (!target || !data) throw new Error('Missing header fixture');
hydrate(Header, { target, props: { ...JSON.parse(data.textContent ?? '{}'), onsubmit: (event: SubmitEvent) => { document.documentElement.dataset.submitted = 'yes'; if (location.pathname === '/header-enhanced') event.preventDefault(); } } });
