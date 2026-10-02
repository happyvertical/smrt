import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OwnerSetupForm from '../OwnerSetupForm.svelte';

let container: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;

function render(props: Record<string, unknown>) {
  component = mount(OwnerSetupForm, {
    target: container,
    props: props as never,
  });
  return tick();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  container.remove();
});

describe('OwnerSetupForm', () => {
  it('renders the setup contract: POST form, hidden token, name and email fields', async () => {
    await render({ data: { available: true, token: 'tok-123' } });
    const form = container.querySelector('form') as HTMLFormElement;
    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    expect(form.hasAttribute('action')).toBe(false);
    const token = form.querySelector('input[name="token"]') as HTMLInputElement;
    expect(token.type).toBe('hidden');
    expect(token.value).toBe('tok-123');
    const name = form.querySelector('input[name="name"]') as HTMLInputElement;
    const email = form.querySelector('input[name="email"]') as HTMLInputElement;
    expect(name.required).toBe(true);
    expect(name.autocomplete).toBe('name');
    expect(email.type).toBe('email');
    expect(email.required).toBe(true);
    expect(email.autocomplete).toBe('email');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // The token is never rendered as visible text.
    expect(container.textContent).not.toContain('tok-123');
  });

  it('gives every field an accessible name and a keyboard-reachable submit', async () => {
    await render({ data: { available: true, token: 't' } });
    expect(container.querySelector('h1')?.textContent).toBe(
      'Set up your local application',
    );
    for (const field of ['name', 'email']) {
      const input = container.querySelector(
        `input[name="${field}"]`,
      ) as HTMLInputElement;
      const label = input.closest('label');
      expect(label?.textContent?.trim().toLowerCase()).toContain(field);
    }
    const button = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('Create owner');
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it('works without JavaScript: no submit handler intercepts the native POST', async () => {
    await render({ data: { available: true, token: 't' }, action: '/setup' });
    const form = container.querySelector('form') as HTMLFormElement;
    expect(form.getAttribute('action')).toBe('/setup');
    const event = new Event('submit', { cancelable: true, bubbles: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('applies an injected enhance action and destroys it on unmount', async () => {
    const destroy = vi.fn();
    const enhance = vi.fn(() => ({ destroy }));
    await render({ data: { available: true, token: 't' }, enhance });
    expect(enhance).toHaveBeenCalledWith(container.querySelector('form'));
    unmount(component as never);
    component = undefined;
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('shows validation and server errors as an alert while keeping the form', async () => {
    await render({
      data: { available: true, token: 't' },
      form: {
        code: 'setup_invalid_input',
        message: 'Name, email, and a valid setup token are required.',
      },
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      'Name, email, and a valid setup token are required.',
    );
    expect(container.querySelector('form')).not.toBeNull();
  });

  it('shows the already-claimed or disabled state without a form or token', async () => {
    await render({ data: { available: false, token: 'should-not-render' } });
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain(
      'Local owner setup is unavailable or has already been completed.',
    );
    expect(container.textContent).not.toContain('should-not-render');
  });

  it('asks for the optional tenantName only when requested', async () => {
    await render({ data: { available: true, token: 't' } });
    expect(container.querySelector('input[name="tenantName"]')).toBeNull();
    unmount(component as never);
    component = undefined;
    container.innerHTML = '';
    await render({
      data: { available: true, token: 't' },
      askTenantName: true,
    });
    const input = container.querySelector(
      'input[name="tenantName"]',
    ) as HTMLInputElement;
    expect(input.required).toBe(false);
  });

  it('never persists or logs the token', async () => {
    const log = vi.spyOn(console, 'log');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await render({ data: { available: true, token: 'secret-token' } });
    expect(log).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    log.mockRestore();
    setItem.mockRestore();
  });
});
