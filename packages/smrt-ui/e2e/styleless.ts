import '../src/themes/styles/smrt.css';
import { mount } from 'svelte';
import StylelessPreview from '../src/svelte/playground/StylelessPreview.svelte';

mount(StylelessPreview, { target: document.getElementById('app')! });
