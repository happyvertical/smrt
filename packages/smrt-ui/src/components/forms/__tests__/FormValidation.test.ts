import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet, tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Form from '../Form.svelte';
import { validateBeforeSubmit } from '../form-validation.js';
import PasswordInput from '../PasswordInput.svelte';

function plainForm() {
  document.body.innerHTML = `<form method="POST" action="?/x">
    <label for="e">Email</label><input id="e" name="email" type="email" required />
    <button type="submit">Go</button></form>`;
  const form = document.querySelector('form') as HTMLFormElement;
  const handle = validateBeforeSubmit(form);
  return { form, handle, email: form.querySelector('#e') as HTMLInputElement };
}

describe('validateBeforeSubmit', () => {
  it('shows no reasons on first render but blocks submit via aria-disabled', () => {
    const { form, email } = plainForm();
    expect(form.noValidate).toBe(true);
    expect(email).not.toHaveAttribute('aria-invalid');
    expect(form.querySelector('.smrt-field-error')).toBeNull();
    expect(form.querySelector('button')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows the reason once touched, wired with aria-invalid/describedby', async () => {
    const { form, email } = plainForm();
    await userEvent.click(email);
    await userEvent.tab();
    const msg = form.querySelector('.smrt-field-error') as HTMLElement;
    expect(msg.textContent).toMatch(/\S/);
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email.getAttribute('aria-describedby')).toContain(msg.id);
  });

  it('blocks a submit attempt, reveals reasons and focuses the field', async () => {
    const { form, email } = plainForm();
    const submit = vi.fn();
    form.addEventListener('submit', submit);
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(submit).not.toHaveBeenCalled();
    expect(form.querySelector('.smrt-field-error')).not.toBeNull();
    expect(document.activeElement).toBe(email);
  });

  it('lets a valid submit through untouched and clears reasons', async () => {
    const { form, email } = plainForm();
    const submit = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submit);
    await userEvent.click(email);
    await userEvent.tab();
    await userEvent.type(email, 'a@b.co');
    expect(form.querySelector('.smrt-field-error')).toBeNull();
    expect(email).not.toHaveAttribute('aria-invalid');
    const go = screen.getByRole('button', { name: 'Go' });
    expect(go).not.toHaveAttribute('aria-disabled');
    await userEvent.click(go);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].defaultPrevented).toBe(true); // only by the test
  });

  it('restores native validation on destroy', () => {
    const { form, handle } = plainForm();
    handle.destroy();
    expect(form.noValidate).toBe(false);
  });
});

describe('PasswordInput', () => {
  it('toggles visibility with an accessible checkbox that is not submitted', async () => {
    render(PasswordInput, { props: { name: 'password' } });
    const field = document.querySelector(
      'input[name="password"]',
    ) as HTMLInputElement;
    expect(field.type).toBe('password');
    const toggle = screen.getByRole('checkbox', { name: 'Show password' });
    expect(toggle).not.toHaveAttribute('name');
    await userEvent.click(toggle);
    expect(field.type).toBe('text');
  });

  it('flags a confirm mismatch with a reason and does not name the confirm field', async () => {
    render(PasswordInput, { props: { name: 'password', confirm: true } });
    const pw = document.querySelector(
      'input[name="password"]',
    ) as HTMLInputElement;
    const confirm = screen.getByLabelText(
      'Confirm password',
    ) as HTMLInputElement;
    expect(confirm.hasAttribute('name')).toBe(false);
    await userEvent.type(pw, 'secret1');
    await userEvent.type(confirm, 'secret2');
    expect(confirm.validationMessage).toBe('Passwords do not match');
    await userEvent.clear(confirm);
    await userEvent.type(confirm, 'secret1');
    expect(confirm.validity.valid).toBe(true);
    await userEvent.type(pw, 'x'); // password changes after confirm
    expect(confirm.validationMessage).toBe('Passwords do not match');
  });
});

const body = createRawSnippet(() => ({
  render: () =>
    '<div><input name="n" required /><button type="submit">Save</button></div>',
}));

describe('Form validate', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is opt-in: reasons appear after a blocked submit attempt', async () => {
    render(Form, {
      props: { validate: true, preventDefault: false, children: body },
    });
    await tick();
    const form = document.querySelector('form') as HTMLFormElement;
    expect(form.noValidate).toBe(true);
    expect(form.querySelector('.smrt-field-error')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(form.querySelector('.smrt-field-error')).not.toBeNull();
  });

  it('leaves forms without `validate` alone', () => {
    render(Form, { props: { children: body } });
    const form = document.querySelector('form') as HTMLFormElement;
    expect(form.noValidate).toBe(false);
    expect(form.querySelector('button')).not.toHaveAttribute('aria-disabled');
  });
});
