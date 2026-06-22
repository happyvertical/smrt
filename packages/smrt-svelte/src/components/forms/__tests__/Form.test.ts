/**
 * Golden test for Form (Sweep L4, #1423).
 *
 * Form depends on the Provider-backed `useAppState`/`useSTT` hooks (they throw
 * outside a <Provider>), so we mock them to stub, non-listening defaults — this
 * is the reference pattern for testing hook-dependent components in isolation.
 * The aria-live status region is L1's deliverable (#1420); here we cover the
 * form element, children rendering, the onsubmit contract, and axe.
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));
vi.mock('../../../hooks/useSTT.svelte.js', () => ({
  useSTT: () => ({
    isListening: false,
    lastResult: '',
    isReady: false,
    adapterType: null,
    isInitializing: false,
    downloadProgress: 0,
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

import Form from '../Form.svelte';

function submitButton() {
  return createRawSnippet(() => ({
    render: () => `<button type="submit">Submit</button>`,
  }));
}

describe('Form', () => {
  it('renders a <form> with its children', () => {
    const { container } = render(Form, { props: { children: submitButton() } });
    expect(container.querySelector('form')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });

  it('calls onsubmit (preventing native submission) when submitted', async () => {
    const onsubmit = vi.fn();
    render(Form, { props: { children: submitButton(), onsubmit } });
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onsubmit).toHaveBeenCalledTimes(1);
  });

  it('exposes a polite aria-live status region for async state (L1)', () => {
    render(Form, { props: { children: submitButton() } });
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('is axe-clean', async () => {
    const { container } = render(Form, { props: { children: submitButton() } });
    await expectNoA11yViolations(container);
  });
});
