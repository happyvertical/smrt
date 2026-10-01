import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import FormActionBar from '../FormActionBar.svelte';

const actions = createRawSnippet(() => ({
  render: () =>
    '<span><button type="button">Cancel</button><button type="submit">Publish</button></span>',
}));

describe('FormActionBar', () => {
  it('is a labelled group carrying the shell contract attribute', () => {
    render(FormActionBar, {
      props: { label: 'Video actions', children: actions },
    });
    const group = screen.getByRole('group', { name: 'Video actions' });
    expect(group.hasAttribute('data-form-action-bar')).toBe(true);
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
  });

  it('defaults its accessible name and supports the plain variant', () => {
    render(FormActionBar, { props: { plain: true, children: actions } });
    const group = screen.getByRole('group', { name: 'Form actions' });
    expect(group.classList.contains('plain')).toBe(true);
  });
});
