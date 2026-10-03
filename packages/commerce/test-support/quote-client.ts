import { mount } from 'svelte';
import QuotePlayground from '../src/svelte/components/QuotePlayground.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Quote browser fixture requires #app');
mount(QuotePlayground, { target });
