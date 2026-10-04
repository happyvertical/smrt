import { hydrate } from 'svelte';
import Harness from './QuoteAttachmentsHarness.svelte';
const target = document.getElementById('attachment-composition')!;
hydrate(Harness, { target, props: { kind: target.dataset.kind as 'quote' | 'purchase' } });
