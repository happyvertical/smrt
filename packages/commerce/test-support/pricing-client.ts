import { mount } from 'svelte';
import PricingVersionPreview from '../src/svelte/playground/PricingVersionPreview.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Pricing browser fixture requires #app');
mount(PricingVersionPreview, { target });
