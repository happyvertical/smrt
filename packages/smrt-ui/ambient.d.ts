declare module '*.svelte' {
  import type { Component } from 'svelte';

  const component: Component<Record<string, any>>;
  export default component;
}

// Vite `?inline` CSS imports (the playground embeds unstyled.css as text).
declare module '*.css?inline' {
  const css: string;
  export default css;
}

// pdf.js ships no declarations for its worker entry; it is imported for its
// side effect on `globalThis.pdfjsWorker` (display/pdf-opener.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
