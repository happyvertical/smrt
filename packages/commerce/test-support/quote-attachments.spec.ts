import { JSDOM } from 'jsdom';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Harness from './QuoteAttachmentsHarness.svelte';

describe.each(['quote', 'purchase'] as const)('%s attachment composition', (kind) => {
  it('gives actual Assets upload and editor controls independent native forms', () => {
    const document = new JSDOM(render(Harness, { props: { kind } }).body).window.document;
    expect(document.forms).toHaveLength(2);
    const editor = document.querySelector<HTMLInputElement>('[name=editorToken]')!.form!;
    const upload = document.querySelector<HTMLInputElement>('input[type=file]')!.form!;
    expect(editor.getAttribute('action')).toBe(`/${kind}-save`);
    expect(upload.getAttribute('action')).toBe(`/${kind}-upload`);
    expect(upload.enctype).toBe('multipart/form-data');
    expect(editor.querySelector('[name=uploadToken]')).toBeNull();
    expect(upload.querySelector('[name=editorToken]')).toBeNull();
    expect(upload.closest('form')?.parentElement?.closest('form')).toBeNull();
    expect(editor.querySelector<HTMLButtonElement>('button[type=submit]')?.form).toBe(editor);
  });
  it.each([{ readonly: true }, { busy: true }])('preserves disabled upload controls for %j', (state) => {
    const document = new JSDOM(render(Harness, { props: { kind, ...state } }).body).window.document;
    expect(document.querySelector('input[type=file]')?.matches(':disabled')).toBe(true);
    expect(document.querySelector('input[type=file]')?.form?.getAttribute('action')).toBe(`/${kind}-upload`);
  });
});
