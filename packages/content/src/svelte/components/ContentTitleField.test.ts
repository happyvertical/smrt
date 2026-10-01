// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentTitleField from './ContentTitleField.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];

function renderField(props: Record<string, unknown>) {
  const target = document.createElement('h1');
  document.body.appendChild(target);
  mounted.push(mount(ContentTitleField, { target, props }));
  flushSync();
  const field = target.querySelector('textarea');
  if (!field) throw new Error('no title field');
  return field;
}

afterEach(() => {
  while (mounted.length > 0) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
});

describe('ContentTitleField', () => {
  it('is a labelled one-row field with a name and id', () => {
    const field = renderField({
      value: 'Council passes budget',
      name: 'title',
      id: 'article-title',
      placeholder: 'Untitled article',
      required: true,
    });
    expect(field.getAttribute('aria-label')).toBe('Title');
    expect(field.name).toBe('title');
    expect(field.id).toBe('article-title');
    expect(field.rows).toBe(1);
    expect(field.required).toBe(true);
    expect(field.placeholder).toBe('Untitled article');
    expect(field.value).toBe('Council passes budget');
  });

  it('never adds a newline on Enter', () => {
    const field = renderField({ value: 'Budget' });
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it('turns pasted line breaks into spaces', () => {
    const onChange = vi.fn();
    const field = renderField({ value: '', onChange });
    field.value = 'Council\npasses\r\nbudget';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(field.value).toBe('Council passes budget');
    expect(onChange).toHaveBeenLastCalledWith('Council passes budget');
  });

  it('marks itself invalid and points at its message', () => {
    const field = renderField({
      value: '',
      invalid: true,
      describedBy: 'title-error',
    });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe('title-error');
  });
});
