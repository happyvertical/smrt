import { mount } from 'svelte';
import PartyBrowserHarness from './PartyBrowserHarness.svelte';

mount(PartyBrowserHarness, { target: document.getElementById('app')! });
