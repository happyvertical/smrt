import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { ADMIN_SHELL_CONTEXT } from '../workspace/admin-shell/context.js';
import { createShellState } from '../workspace/admin-shell/state.svelte.js';
import ActivityList from './ActivityList.svelte';

it('binds only its authorized entries and removes them on actor change and disposal', async () => {
  const shell = createShellState();
  shell.upsertActivity({
    id: 'other',
    label: 'Other feed',
    kind: 'audit',
    scope: 'system',
    status: 'completed',
  });
  const context = new Map([[ADMIN_SHELL_CONTEXT, shell]]);
  const view = render(ActivityList, {
    props: {
      entries: [
        {
          id: 'one',
          title: 'Authorized action',
          occurredAt: '2026-01-01',
          href: 'javascript:alert(1)',
        },
      ],
    },
    context,
  });
  expect(await screen.findByText('Authorized action')).toBeInTheDocument();
  expect(screen.queryByText('Other feed')).not.toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  await view.rerender({ entries: [] });
  expect(screen.queryByText('Authorized action')).not.toBeInTheDocument();
  expect(await screen.findByText('No activity.')).toBeInTheDocument();
  view.unmount();
  expect(shell.listActivities().map((entry) => entry.id)).toEqual(['other']);
});
