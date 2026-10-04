import { mount } from 'svelte';
import '@happyvertical/smrt-ui/themes/styles/material.css';
import Harness from './Harness.svelte';
import LineHarness from './LineHarness.svelte';
mount(location.search === '?line=1' ? LineHarness : Harness, { target: document.getElementById('app')! });
