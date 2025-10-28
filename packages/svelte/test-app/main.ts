import '../src/styles/tokens.css';
import { mount } from 'svelte';
import App from './App.svelte';

console.log('Main.ts loaded');
console.log('App target:', document.getElementById('app'));

const app = mount(App, {
  target: document.getElementById('app')!,
});

console.log('App instance created:', app);

export default app;
