import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import EditForm from '../EditForm.svelte';
import { taskDefinition, taskPolicy, taskRows } from './fixtures.js';

describe('EditForm', () => {
  it('create: prefills policy defaults and submits wire values for the displayed fields', async () => {
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(EditForm, {
      props: { definition: taskDefinition, policy: taskPolicy, onsubmit },
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'New task' }),
    ).toBeInTheDocument();
    // policy label and help
    expect(screen.getByLabelText(/Task name/)).toBeInTheDocument();
    expect(screen.getByText('What needs doing')).toBeInTheDocument();
    // policy default (5) beats the manifest default (3)
    expect(screen.getByLabelText('Priority')).toHaveValue(5);
    // omitted / hidden fields are not rendered
    expect(screen.queryByLabelText(/secret/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/reference/i)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/Task name/), 'Plan launch');
    await userEvent.type(screen.getByLabelText(/Budget/), '19.99');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(onsubmit).toHaveBeenCalledOnce());
    const [values, context] = onsubmit.mock.calls[0];
    expect(context).toEqual({ isNew: true });
    expect(values).toMatchObject({
      title: 'Plan launch',
      budget: 1999,
      priority: 5,
      done: true,
      dueAt: null,
      ownerId: null,
    });
    expect(Object.keys(values)).not.toContain('secretToken');
    expect(Object.keys(values)).not.toContain('id');
  });

  it('blocks submit and reports required and malformed values', async () => {
    const onsubmit = vi.fn();
    render(EditForm, {
      props: { definition: taskDefinition, policy: taskPolicy, onsubmit },
    });
    await userEvent.type(screen.getByLabelText(/Budget/), '1.234');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onsubmit).not.toHaveBeenCalled();
    expect(
      await screen.findByText('This field is required.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Enter an amount such as 12.50.'),
    ).toBeInTheDocument();
  });

  it('keeps advanced fields behind a disclosure that opens on a problem', async () => {
    const onsubmit = vi.fn();
    const { container } = render(EditForm, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record: { ...taskRows[0], payload: { a: 1 } },
        onsubmit,
      },
    });
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Edit task' }),
    ).toBeInTheDocument();

    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    const json = await screen.findByLabelText('Payload');
    await userEvent.clear(json);
    await userEvent.type(json, 'not json');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter valid JSON.')).toBeInTheDocument();
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('edit: prefills the record and attaches server field errors', async () => {
    const onsubmit = vi
      .fn()
      .mockResolvedValue({ fieldErrors: { title: 'Already taken' } });
    render(EditForm, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record: taskRows[0],
        onsubmit,
      },
    });
    expect(screen.getByLabelText(/Task name/)).toHaveValue('Write docs');
    expect(screen.getByLabelText(/Budget/)).toHaveValue('1250.50');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Already taken')).toBeInTheDocument();
    expect(onsubmit.mock.calls[0][1]).toEqual({ isNew: false });
  });

  it('edit: saving another field keeps the datetime seconds and milliseconds', async () => {
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(EditForm, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record: { ...taskRows[0], dueAt: '2026-10-09T12:30:45.123Z' },
        onsubmit,
      },
    });
    const title = screen.getByLabelText(/Task name/);
    await userEvent.clear(title);
    await userEvent.type(title, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onsubmit).toHaveBeenCalledOnce());
    expect(onsubmit.mock.calls[0][0]).toMatchObject({
      title: 'Renamed',
      dueAt: '2026-10-09T12:30:45.123Z',
    });
  });

  it('shows a form-level error when the host throws', async () => {
    const onsubmit = vi.fn().mockRejectedValue(new Error('boom'));
    render(EditForm, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record: taskRows[0],
        onsubmit,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Could not save your changes.'),
    ).toBeInTheDocument();
  });

  it('cancels', async () => {
    const oncancel = vi.fn();
    render(EditForm, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        onsubmit: vi.fn(),
        oncancel,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(oncancel).toHaveBeenCalledOnce();
  });

  it('is axe-clean', async () => {
    const { container } = render(EditForm, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        record: taskRows[0],
        onsubmit: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
  });
});
