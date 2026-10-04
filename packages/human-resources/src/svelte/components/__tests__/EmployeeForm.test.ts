// @vitest-environment jsdom
/**
 * Component coverage for EmployeeForm via the shared S11 harness (#1416): the
 * fields shown for a hire and for an edit, `onsubmit` values,
 * required-field and format validation tied to each field, worker-type
 * suggestions, the login choice, and accessibility.
 */
import {
  expectNoA11yViolations,
  fireEvent,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import EmployeeForm from '../EmployeeForm.svelte';

const existing = {
  employeeNumber: 'E-100',
  workerType: 'apprentice',
  position: 'Carpenter',
  userId: 'user-1',
};

async function setDate(label: RegExp, value: string): Promise<void> {
  await fireEvent.input(screen.getByLabelText(label), { target: { value } });
}

describe('EmployeeForm', () => {
  it('renders the hire fields with the worker type defaulted to employee', async () => {
    render(EmployeeForm, { props: { onsubmit: vi.fn() } });
    expect(screen.getByLabelText(/Employee number/)).toHaveValue('');
    expect(screen.getByLabelText(/Worker type/)).toHaveValue('employee');
    expect(screen.getByLabelText(/Position/)).toHaveValue('');
    expect(screen.getByLabelText(/Start date/)).toHaveAttribute('type', 'date');
    expect(screen.queryByLabelText(/Effective date/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Login/)).toHaveValue('');
    expect(
      screen.getByRole('button', { name: 'Hire employee' }),
    ).toBeInTheDocument();
  });

  it('submits a new hire with trimmed values and no persistence of its own', async () => {
    const onsubmit = vi.fn();
    render(EmployeeForm, { props: { onsubmit } });
    await userEvent.type(screen.getByLabelText(/Employee number/), ' E-200 ');
    await userEvent.type(screen.getByLabelText(/Position/), 'Electrician');
    await setDate(/Start date/, '2026-10-05');
    await userEvent.click(
      screen.getByRole('button', { name: 'Hire employee' }),
    );
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith({
        employeeNumber: 'E-200',
        workerType: 'employee',
        position: 'Electrician',
        userId: null,
        startedOn: '2026-10-05',
        effectiveOn: null,
      }),
    );
  });

  it('prefills the start date from today', async () => {
    const onsubmit = vi.fn();
    render(EmployeeForm, { props: { onsubmit, today: '2026-10-03' } });
    await vi.waitFor(() =>
      expect(screen.getByLabelText(/Start date/)).toHaveValue('2026-10-03'),
    );
    await userEvent.type(screen.getByLabelText(/Employee number/), 'E-201');
    await userEvent.click(
      screen.getByRole('button', { name: 'Hire employee' }),
    );
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledWith(
        expect.objectContaining({ startedOn: '2026-10-03' }),
      ),
    );
  });

  it('offers the suggested worker types and accepts another value', async () => {
    const onsubmit = vi.fn();
    const { container } = render(EmployeeForm, {
      props: { onsubmit, today: '2026-10-03' },
    });
    const workerType = screen.getByLabelText(/Worker type/);
    const suggestions = container.querySelector(
      `datalist#${CSS.escape(workerType.getAttribute('list') ?? '')}`,
    );
    expect(
      [...(suggestions?.querySelectorAll('option') ?? [])].map(
        (option) => option.value,
      ),
    ).toEqual(['employee', 'apprentice', 'contractor']);

    await userEvent.type(screen.getByLabelText(/Employee number/), 'E-202');
    await userEvent.clear(workerType);
    await userEvent.type(workerType, 'seasonal-worker');
    await userEvent.click(
      screen.getByRole('button', { name: 'Hire employee' }),
    );
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledWith(
        expect.objectContaining({ workerType: 'seasonal-worker' }),
      ),
    );
  });

  it('does not submit while a required field is empty', async () => {
    const onsubmit = vi.fn();
    render(EmployeeForm, { props: { onsubmit } });
    expect(screen.getByLabelText(/Employee number/)).toBeRequired();
    expect(screen.getByLabelText(/Worker type/)).toBeRequired();
    expect(screen.getByLabelText(/Start date/)).toBeRequired();
    expect(screen.getByLabelText(/Position/)).not.toBeRequired();
    expect(screen.getByLabelText(/Login/)).not.toBeRequired();
    await userEvent.click(
      screen.getByRole('button', { name: 'Hire employee' }),
    );
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('rejects a blank employee number and a worker type that is not kebab-case', async () => {
    const onsubmit = vi.fn();
    render(EmployeeForm, { props: { onsubmit, today: '2026-10-03' } });
    await userEvent.type(screen.getByLabelText(/Employee number/), '   ');
    const workerType = screen.getByLabelText(/Worker type/);
    await userEvent.clear(workerType);
    await userEvent.type(workerType, 'Seasonal Worker');
    await userEvent.click(
      screen.getByRole('button', { name: 'Hire employee' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Enter an employee number.');
    expect(alert).toHaveTextContent(
      'Enter a worker type using lowercase words joined by hyphens.',
    );
    expect(workerType).toHaveAttribute('aria-invalid', 'true');
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('ties each validation message to its field', async () => {
    const { container } = render(EmployeeForm, {
      props: { onsubmit: vi.fn(), today: '2026-10-03' },
    });
    const described = (field: HTMLElement) =>
      (field.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .filter(Boolean)
        .map((id) => container.querySelector(`#${CSS.escape(id)}`)?.textContent)
        .map((text) => text?.trim());
    const employeeNumber = screen.getByLabelText(/Employee number/);
    const workerType = screen.getByLabelText(/Worker type/);
    // Before validation a field is described by its hint only.
    expect(employeeNumber).not.toHaveAttribute('aria-describedby');
    expect(described(workerType)).toEqual([
      'Pick a suggestion or enter your own: lowercase words joined by hyphens.',
    ]);

    await userEvent.type(employeeNumber, '   ');
    await userEvent.clear(workerType);
    await userEvent.type(workerType, 'Seasonal Worker');
    await userEvent.click(
      screen.getByRole('button', { name: 'Hire employee' }),
    );
    await screen.findByRole('alert');
    expect(described(employeeNumber)).toEqual(['Enter an employee number.']);
    expect(described(workerType)).toEqual([
      'Pick a suggestion or enter your own: lowercase words joined by hyphens.',
      'Enter a worker type using lowercase words joined by hyphens.',
    ]);
    // The start date passed, so it points at no message.
    expect(screen.getByLabelText(/Start date/)).not.toHaveAttribute(
      'aria-describedby',
    );
  });

  it('edits an employment: loaded values, a fixed employee number, an effective date and no start date', async () => {
    const onsubmit = vi.fn();
    render(EmployeeForm, {
      props: { employee: existing, onsubmit, today: '2026-10-03' },
    });
    const employeeNumber = screen.getByLabelText(/Employee number/);
    expect(employeeNumber).toHaveValue('E-100');
    expect(employeeNumber).toHaveAttribute('readonly');
    expect(screen.getByLabelText(/Worker type/)).toHaveValue('apprentice');
    expect(screen.getByLabelText(/Position/)).toHaveValue('Carpenter');
    expect(screen.getByLabelText(/Login/)).toHaveValue('user-1');
    expect(screen.queryByLabelText(/Start date/)).not.toBeInTheDocument();
    const effectiveOn = screen.getByLabelText(/Effective date/);
    expect(effectiveOn).toHaveAttribute('type', 'date');
    expect(effectiveOn).toBeRequired();
    expect(effectiveOn).toHaveValue('2026-10-03');
    await setDate(/Effective date/, '2026-11-01');

    const position = screen.getByLabelText(/Position/);
    await userEvent.clear(position);
    await userEvent.type(position, 'Foreman');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith({
        employeeNumber: 'E-100',
        workerType: 'apprentice',
        position: 'Foreman',
        userId: 'user-1',
        startedOn: null,
        effectiveOn: '2026-11-01',
      }),
    );
  });

  it('does not submit an edit without an effective date', async () => {
    const onsubmit = vi.fn();
    render(EmployeeForm, { props: { employee: existing, onsubmit } });
    expect(screen.getByLabelText(/Effective date/)).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onsubmit).not.toHaveBeenCalled();
    await setDate(/Effective date/, '2026-10-04');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ effectiveOn: '2026-10-04', startedOn: null }),
      ),
    );
  });

  it('keeps the current login selectable when the host options leave it out, so saving never unlinks it', async () => {
    const onsubmit = vi.fn();
    render(EmployeeForm, {
      props: {
        employee: existing,
        onsubmit,
        today: '2026-10-03',
        logins: [{ value: 'user-2', label: 'bob@example.com' }],
      },
    });
    const login = screen.getByRole('combobox', { name: /Login/ });
    expect(login).toHaveValue('user-1');
    expect(
      [...login.querySelectorAll('option')].map((option) => [
        option.value,
        option.textContent?.trim(),
      ]),
    ).toEqual([
      ['', 'No login'],
      ['user-1', 'Current login (user-1)'],
      ['user-2', 'bob@example.com'],
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ userId: 'user-1' }),
      ),
    );
  });

  it('offers the host logins as a choice and can clear the link', async () => {
    const onsubmit = vi.fn();
    render(EmployeeForm, {
      props: {
        employee: existing,
        onsubmit,
        today: '2026-10-03',
        logins: [
          { value: 'user-1', label: 'ada@example.com' },
          { value: 'user-2', label: 'bob@example.com' },
        ],
      },
    });
    const login = screen.getByRole('combobox', { name: /Login/ });
    expect(login).toHaveValue('user-1');
    await userEvent.selectOptions(login, 'No login');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() =>
      expect(onsubmit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: null }),
      ),
    );
  });

  it('calls oncancel and blocks input while loading', async () => {
    const oncancel = vi.fn();
    const { unmount } = render(EmployeeForm, {
      props: { onsubmit: vi.fn(), oncancel },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(oncancel).toHaveBeenCalledOnce();
    unmount();

    render(EmployeeForm, { props: { onsubmit: vi.fn(), loading: true } });
    expect(screen.getByLabelText(/Employee number/)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });

  it('is axe-clean for a hire and for an edit', async () => {
    const hire = render(EmployeeForm, {
      props: { onsubmit: vi.fn(), oncancel: vi.fn() },
    });
    await expectNoA11yViolations(hire.container);
    hire.unmount();
    const edit = render(EmployeeForm, {
      props: {
        employee: existing,
        onsubmit: vi.fn(),
        today: '2026-10-03',
        logins: [{ value: 'user-2', label: 'bob@example.com' }],
      },
    });
    await expectNoA11yViolations(edit.container);
    edit.unmount();
    // With validation messages showing.
    const invalid = render(EmployeeForm, {
      props: { onsubmit: vi.fn(), today: '2026-10-03' },
    });
    await userEvent.type(screen.getByLabelText(/Employee number/), '   ');
    await userEvent.click(
      screen.getByRole('button', { name: 'Hire employee' }),
    );
    await screen.findByRole('alert');
    await expectNoA11yViolations(invalid.container);
  });
});
