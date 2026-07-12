// @vitest-environment jsdom
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import DevelopmentRequestForm from '../DevelopmentRequestForm.svelte';
import DevelopmentRequestList from '../DevelopmentRequestList.svelte';

describe('development request components', () => {
  it('submits a request through the browser-safe callback surface', async () => {
    const onsubmit = vi.fn();
    render(DevelopmentRequestForm, { props: { onsubmit } });
    await userEvent.selectOptions(screen.getByLabelText('Request type'), 'bug');
    await userEvent.type(
      screen.getByLabelText('Description'),
      'The save button is broken',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Submit request' }),
    );
    expect(onsubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bug',
        description: 'The save button is broken',
        visibility: 'requester',
        origin: 'managed-app',
      }),
    );
  });

  it('renders requester-scoped status without exposing another requester', () => {
    render(DevelopmentRequestList, {
      props: {
        requesterId: 'user-1',
        requests: [
          {
            id: 'r1',
            requesterId: 'user-1',
            type: 'feature',
            description: 'Dark mode',
            status: 'planned',
          },
          {
            id: 'r2',
            requesterId: 'user-2',
            type: 'bug',
            description: 'Private bug',
            status: 'submitted',
          },
        ],
      },
    });
    expect(screen.getByText('Dark mode')).toBeInTheDocument();
    expect(screen.getByText('planned')).toBeInTheDocument();
    expect(screen.queryByText('Private bug')).not.toBeInTheDocument();
  });

  it('is accessible', async () => {
    const form = render(DevelopmentRequestForm, {
      props: { onsubmit: vi.fn() },
    });
    await expectNoA11yViolations(form.container);
  });
});
