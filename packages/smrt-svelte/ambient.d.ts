declare module '*.svelte' {
  import type { Component } from 'svelte';

  const component: Component<Record<string, any>>;
  export default component;
}

declare module '@happyvertical/smrt-ui/themes/styles/*.css';
