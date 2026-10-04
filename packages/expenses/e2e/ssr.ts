import { render } from 'svelte/server';
import ExpenseForm from '../src/svelte/components/ExpenseForm.svelte';
import type { ExpenseFormProps } from '../src/svelte/types.js';
import { values } from './fixture.js';
export function page(props: Partial<ExpenseFormProps> = {}): string {
  const { body } = render(ExpenseForm, { props: { action: '/save', values, correcting: true, hiddenFields: [{ name: 'requestId', value: 'same-request' }, { name: 'tenantId', value: 'same-tenant' }, { name: 'predecessorId', value: 'same-predecessor' }], ...props } });
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native expense proof</title></head><body>${body}</body></html>`;
}

export async function reviewPage(message = ''): Promise<string> {
  const { default: ReviewHarness } = await import('./ReviewHarness.svelte');
  const { body } = render(ReviewHarness, { props: { message } });
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native review proof</title></head><body>${body}</body></html>`;
}
