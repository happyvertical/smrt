import '../src/themes/styles/base.css';
import '../src/themes/styles/smrt.css';
import { mount } from 'svelte';
import ForcedColors from './ForcedColors.svelte';

const params = new URLSearchParams(location.search);
mount(ForcedColors, {
  target: document.getElementById('app')!,
  props: {
    inline: params.has('inline'),
    scheme: params.get('scheme') === 'dark' ? 'dark' : 'light',
  },
});
