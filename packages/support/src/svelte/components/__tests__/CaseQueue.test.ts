// @vitest-environment jsdom
/**
 * Component coverage for CaseQueue via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { SupportCaseView } from '../../types.js';
import CaseQueue from '../CaseQueue.svelte';

function caseView(overrides: Partial<SupportCaseView> = {}): SupportCaseView {
  return {
    id: 'case-1',
    caseNumber: 'SUP-1',
    subject: 'Login is broken',
    status: 'in_progress',
    priority: 'high',
    severity: 'sev2',
    channelKind: 'chat',
    clientProfileId: 'client-1',
    projectId: 'project-1',
    assignedSpecialistId: 'spec-1',
    assignedSpecialistName: 'Ada',
    reopenCount: 0,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-02T11:30:00.000Z',
    resolutionSummary: '',
    ...overrides,
  };
}

describe('CaseQueue', () => {
  it('renders case number, subject, badges, and assignee', async () => {
    const { container } = render(CaseQueue, {
      props: { cases: [caseView()] },
    });
    expect(screen.getByText('SUP-1')).toBeInTheDocument();
    expect(screen.getByText('Login is broken')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('in progress')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('invokes onselect with the case id', async () => {
    const onselect = vi.fn();
    render(CaseQueue, { props: { cases: [caseView()], onselect } });
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Open case SUP-1: Login is broken',
      }),
    );
    expect(onselect).toHaveBeenCalledWith('case-1');
  });

  it('shows the empty message when there are no cases', () => {
    render(CaseQueue, {
      props: { cases: [], emptyMessage: 'Queue is clear' },
    });
    expect(screen.getByText('Queue is clear')).toBeInTheDocument();
  });

  it('falls back to unassigned when no specialist is set', () => {
    render(CaseQueue, {
      props: {
        cases: [
          caseView({
            assignedSpecialistId: null,
            assignedSpecialistName: null,
          }),
        ],
      },
    });
    expect(screen.getByText('unassigned')).toBeInTheDocument();
  });
});
