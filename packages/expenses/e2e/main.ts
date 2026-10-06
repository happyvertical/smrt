import LifecycleHarness from './LifecycleHarness.svelte';
import { mount } from 'svelte';
import '@happyvertical/smrt-ui/themes/styles/material.css';
import Harness from './Harness.svelte';
import ReviewHarness from './ReviewHarness.svelte';
mount(location.search === '?lifecycle=1' ? LifecycleHarness : location.search === '?review=1' ? ReviewHarness : Harness, { target: document.getElementById('app')! });
