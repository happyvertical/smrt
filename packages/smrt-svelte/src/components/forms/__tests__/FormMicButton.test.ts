/**
 * Component test for FormMicButton (Sweep S11, #1416).
 *
 * Follows the golden pattern (src/components/ui/__tests__/Button.test.ts).
 * FormMicButton only renders when smrt mode is active AND a form context is
 * present (`{#if isSmrt && formContext}`). Both come from Provider-backed
 * lookups that throw / return null outside a <Provider>, so we mock
 * `useAppState` (smrt mode) and `tryGetFormContext` (a stub form context). The
 * stub stands in for the real form coordinator — we never mock business logic,
 * only the context boundary that a <Provider> would otherwise supply.
 *
 * The component polls `formContext.isFormListening`/`isExtracting` on a 50ms
 * interval to drive its label/state, so listening/extracting assertions wait
 * for that poll via Testing Library's `findBy*`.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'smrt' }, setMode: vi.fn() }),
}));

const toggleListening = vi.fn();
let formState: { isFormListening: boolean; isExtracting: boolean } = {
  isFormListening: false,
  isExtracting: false,
};

vi.mock('../../../state/form-context.js', () => ({
  tryGetFormContext: () => ({
    get mode() {
      return 'smrt' as const;
    },
    get isFormListening() {
      return formState.isFormListening;
    },
    get isExtracting() {
      return formState.isExtracting;
    },
    toggleListening,
    registerField: vi.fn(),
    unregisterField: vi.fn(),
    getFieldSchema: () => [],
  }),
}));

import FormMicButton from '../FormMicButton.svelte';

describe('FormMicButton', () => {
  beforeEach(() => {
    toggleListening.mockClear();
    formState = { isFormListening: false, isExtracting: false };
  });

  it('renders a button labelled "Click to speak" when idle', () => {
    render(FormMicButton);
    expect(
      screen.getByRole('button', { name: 'Click to speak' }),
    ).toBeInTheDocument();
  });

  it('is keyboard-focusable (tabindex 0)', () => {
    render(FormMicButton);
    expect(
      screen.getByRole('button', { name: 'Click to speak' }),
    ).toHaveAttribute('tabindex', '0');
  });

  it('toggles listening on the form context when clicked', async () => {
    render(FormMicButton);
    await userEvent.click(
      screen.getByRole('button', { name: 'Click to speak' }),
    );
    expect(toggleListening).toHaveBeenCalledTimes(1);
  });

  it('toggles listening when activated with Enter', async () => {
    render(FormMicButton);
    const button = screen.getByRole('button', { name: 'Click to speak' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(toggleListening).toHaveBeenCalledTimes(1);
  });

  it('relabels to "Stop listening" once the form is listening', async () => {
    formState = { isFormListening: true, isExtracting: false };
    render(FormMicButton);
    expect(
      await screen.findByRole('button', { name: 'Stop listening' }),
    ).toBeInTheDocument();
  });

  it('is axe-clean in the idle state', async () => {
    const { container } = render(FormMicButton);
    await expectNoA11yViolations(container);
  });

  it('is axe-clean in the listening state', async () => {
    formState = { isFormListening: true, isExtracting: false };
    const { container } = render(FormMicButton);
    await screen.findByRole('button', { name: 'Stop listening' });
    await expectNoA11yViolations(container);
  });
});
