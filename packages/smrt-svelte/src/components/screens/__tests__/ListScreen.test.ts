import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ListScreen from '../ListScreen.svelte';
import { taskDefinition, taskPolicy, taskRows } from './fixtures.js';

describe('ListScreen', () => {
  it('renders policy-derived columns and formatted cells, and nothing the policy omits', () => {
    render(ListScreen, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        rows: taskRows,
        locale: 'en-US',
      },
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Tasks' }),
    ).toBeInTheDocument();
    const headers = screen
      .getAllByRole('columnheader')
      .map((h) => (h.textContent ?? '').replace(/\s*↕\s*$/, '').trim());
    expect(headers).toEqual([
      'Task name',
      'Priority',
      'Budget',
      'Done',
      'Due at',
    ]);
    const row = screen.getByRole('row', { name: /Write docs/ });
    expect(within(row).getByText('$1,250.50')).toBeInTheDocument();
    expect(within(row).getByText('No')).toBeInTheDocument();
    expect(
      screen.getByRole('row', { name: /Ship release/ }),
    ).toBeInTheDocument();
  });

  it('activates a row with the raw record', async () => {
    const onselect = vi.fn();
    render(ListScreen, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        rows: taskRows,
        onselect,
      },
    });
    await userEvent.click(screen.getByText('Ship release'));
    expect(onselect).toHaveBeenCalledWith(taskRows[1]);
  });

  it('filters rows by the search box', async () => {
    render(ListScreen, {
      props: { definition: taskDefinition, policy: taskPolicy, rows: taskRows },
    });
    await userEvent.type(screen.getByRole('searchbox'), 'ship');
    expect(await screen.findByText('Ship release')).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(screen.queryByText('Write docs')).not.toBeInTheDocument(),
    );
  });

  it('offers a create action only when oncreate is supplied', async () => {
    const oncreate = vi.fn();
    const { unmount } = render(ListScreen, {
      props: { definition: taskDefinition, policy: taskPolicy, rows: taskRows },
    });
    expect(
      screen.queryByRole('button', { name: 'New task' }),
    ).not.toBeInTheDocument();
    unmount();
    render(ListScreen, {
      props: {
        definition: taskDefinition,
        policy: taskPolicy,
        rows: taskRows,
        oncreate,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(oncreate).toHaveBeenCalledOnce();
  });

  it('shows an empty state', () => {
    render(ListScreen, {
      props: { definition: taskDefinition, policy: taskPolicy, rows: [] },
    });
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
  });

  it('refuses a policy for another object', () => {
    render(ListScreen, {
      props: {
        definition: taskDefinition,
        policy: { ...taskPolicy, objectRef: '@acme/tasks:Other' },
        rows: taskRows,
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /not '@acme\/tasks:Task'/,
    );
    expect(screen.queryByText('Write docs')).not.toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(ListScreen, {
      props: { definition: taskDefinition, policy: taskPolicy, rows: taskRows },
    });
    await expectNoA11yViolations(container);
  });
});
