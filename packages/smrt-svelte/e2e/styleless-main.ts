import '@happyvertical/smrt-ui/themes/styles/all.css';
import { mount } from 'svelte';
import ShellStylelessPreview from '../src/svelte/playground/ShellStylelessPreview.svelte';

mount(ShellStylelessPreview, { target: document.getElementById('app')! });
