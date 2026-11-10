/**
 * Behaviour tests for the party form submit hooks (#3501): an `enhance`
 * action reaches the mounted native form and is destroyed with it, an
 * `onsubmit` handler can take over submission, and `getFormElement()`
 * exposes the native element, so `ssr = false` hosts never have to find the
 * form after mount.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CustomerForm from '../src/svelte/components/CustomerForm.svelte';
import VendorForm from '../src/svelte/components/VendorForm.svelte';

const forms = [
  { name: 'CustomerForm', component: CustomerForm, save: 'Add customer' },
  { name: 'VendorForm', component: VendorForm, save: 'Add vendor' },
] as const;

describe.each(forms)('$name submit hooks', ({ component, save }) => {
  it('applies enhance to the native form and destroys it on unmount', () => {
    const destroy = vi.fn();
    const enhance = vi.fn((_form: HTMLFormElement) => ({ destroy }));
    const view = render(component as never, {
      props: { values: { name: 'Northstar' }, enhance } as never,
    });
    const form = view.container.querySelector('form');
    expect(form).toBeInstanceOf(HTMLFormElement);
    expect(enhance).toHaveBeenCalledTimes(1);
    expect(enhance.mock.calls[0]?.[0]).toBe(form);
    expect(
      (view.component as unknown as { getFormElement(): HTMLFormElement | null })
        .getFormElement(),
    ).toBe(form);
    view.unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('passes native submit events, including the submitter intent, to onsubmit', async () => {
    const onsubmit = vi.fn((event: SubmitEvent) => {
      event.preventDefault();
      return new FormData(
        event.currentTarget as HTMLFormElement,
        event.submitter,
      );
    });
    render(component as never, {
      props: {
        values: { name: 'Northstar', identityKind: 'business' },
        onsubmit,
      } as never,
    });
    const buttons = screen.getAllByRole('button', { name: save });
    await userEvent.click(buttons[buttons.length - 1] as HTMLElement);
    expect(onsubmit).toHaveBeenCalledTimes(1);
    const event = onsubmit.mock.calls[0]?.[0] as SubmitEvent;
    expect(event.defaultPrevented).toBe(true);
    const data = onsubmit.mock.results[0]?.value as FormData;
    expect(data.get('intent')).toBe('save');
    expect(data.get('name')).toBe('Northstar');
  });
});
