// @vitest-environment jsdom
/**
 * Regression (#4375): schedule rows are not `role="button"` (a `<tr>` wrapping
 * action buttons is an axe nested-interactive violation). The agent name is a
 * real button that fires `onScheduleClick`.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentScheduleData } from '../../types.js';
import AgentScheduleList from '../AgentScheduleList.svelte';

function schedule(): AgentScheduleData {
  return {
    id: 's1',
    agentType: 'Praeco',
    agentId: null,
    agentConfig: {},
    cron: '0 * * * *',
    timezone: 'UTC',
    enabled: true,
    status: 'active',
    lastRun: null,
    nextRun: null,
    lastStatus: null,
    lastError: null,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    maxConcurrent: 1,
    runningCount: 0,
    timeout: 60,
    method: 'run',
    methodArgs: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('AgentScheduleList row interactivity', () => {
  it('does not make table rows interactive', () => {
    const { container } = render(AgentScheduleList, {
      props: { schedules: [schedule()], onScheduleClick: vi.fn() },
    });
    expect(container.querySelector('tr[role="button"]')).toBeNull();
    expect(container.querySelector('tr[tabindex]')).toBeNull();
  });

  it('fires onScheduleClick from the agent-name button', async () => {
    const onScheduleClick = vi.fn();
    const s = schedule();
    render(AgentScheduleList, {
      props: { schedules: [s], onScheduleClick },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Praeco' }));
    expect(onScheduleClick).toHaveBeenCalledWith(s);
  });

  it('renders plain text when no onScheduleClick is provided', () => {
    render(AgentScheduleList, { props: { schedules: [schedule()] } });
    expect(screen.queryByRole('button', { name: 'Praeco' })).toBeNull();
    expect(screen.getByText('Praeco')).toBeInTheDocument();
  });
});
