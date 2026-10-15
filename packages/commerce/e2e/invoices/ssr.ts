import { render } from 'svelte/server';
import theme from '@happyvertical/smrt-ui/themes/styles/material.css?inline';
import Harness from './Harness.svelte';
import type { InvoiceEditorProps } from '../../src/svelte/invoices/types.js';
export function page(initial: InvoiceEditorProps): string {
  const { body, head } = render(Harness, { props: { initial } });
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native invoice proof</title><style>${theme}body{margin:8px;font-family:system-ui,sans-serif}*{box-sizing:border-box}</style>${head}</head><body>${body}</body></html>`;
}
