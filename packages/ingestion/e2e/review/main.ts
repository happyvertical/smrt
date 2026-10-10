import { mount } from 'svelte';
import '@happyvertical/smrt-ui/themes/styles/material.css';
import Harness from './Harness.svelte';

mount(Harness, { target: document.getElementById('app')! });
