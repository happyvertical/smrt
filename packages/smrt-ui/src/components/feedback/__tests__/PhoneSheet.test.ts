/**
 * PhoneSheet: a non-modal phone surface (full-screen page or bottom sheet)
 * that stays mounted while closed, closes on its button / Escape / swipe
 * down, and manages focus.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet, flushSync, tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import PhoneSheet from '../PhoneSheet.svelte';

const body = createRawSnippet(() => ({
  render: () => '<p>Sheet body</p>',
}));

describe('PhoneSheet', () => {
  it('renders a labelled dialog with a named close button when open', async () => {
    const { container } = render(PhoneSheet, {
      props: {
        open: true,
        title: 'Notifications',
        onclose: () => {},
        children: body,
      },
    });
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(dialog).toHaveAttribute('aria-hidden', 'false');
    expect(
      screen.getByRole('button', { name: 'Close Notifications' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sheet body')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('stays mounted but hidden and inert while closed', () => {
    render(PhoneSheet, {
      props: {
        open: false,
        title: 'Assistant',
        onclose: () => {},
        children: body,
      },
    });
    const sheet = screen.getByTestId('phone-sheet');
    expect(sheet).toHaveAttribute('aria-hidden', 'true');
    // jsdom has no `inert` IDL attribute, so Svelte sets it as a property.
    expect(
      sheet.hasAttribute('inert') ||
        (sheet as HTMLElement & { inert?: boolean }).inert,
    ).toBe(true);
    expect(sheet.classList.contains('open')).toBe(false);
  });

  it('closes on the close button and on Escape', async () => {
    const onclose = vi.fn();
    render(PhoneSheet, {
      props: {
        open: true,
        title: 'Assistant',
        onclose,
        closeLabel: 'Close the assistant',
        children: body,
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Close the assistant' }),
    );
    expect(onclose).toHaveBeenCalledTimes(1);
    screen.getByRole('dialog').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onclose).toHaveBeenCalledTimes(2);
  });

  it('moves focus in on open and back to the opener on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(PhoneSheet, {
      props: {
        open: false,
        title: 'Assistant',
        onclose: () => {},
        children: body,
      },
    });
    await rerender({ open: true });
    await tick();
    await tick();
    expect(document.activeElement).toBe(screen.getByTestId('phone-sheet'));
    await rerender({ open: false });
    flushSync();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('draws a grabber only for the sheet variant', () => {
    const { container } = render(PhoneSheet, {
      props: {
        open: true,
        title: 'Assistant',
        variant: 'sheet',
        onclose: () => {},
        children: body,
      },
    });
    expect(container.querySelector('.phone-sheet__grabber')).not.toBeNull();
    expect(container.querySelector('.phone-sheet--sheet')).not.toBeNull();
  });
});
