import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AuditList from '../AuditList.svelte';
import RecordHistory from '../RecordHistory.svelte';
import type { AuditHistoryEntry } from '../types.js';

const entries: AuditHistoryEntry[] = [
  {
    id: 'a',
    profileId: 'alice',
    action: 'created',
    resourceType: 'Job',
    resourceId: 'job-1',
    occurredAt: '2026-10-01T12:00:00Z',
  },
  {
    id: 'b',
    profileId: 'bob',
    action: 'approved',
    resourceType: 'Job',
    resourceId: 'job-1',
    occurredAt: '2026-10-03T12:00:00Z',
    reason: '<script>test</script>',
    changes: { status: { before: 'draft', after: 'approved' } },
  },
  {
    id: 'c',
    profileId: 'alice',
    action: 'new.action',
    resourceType: 'Employee',
    resourceId: 'employee-1',
    occurredAt: '2026-10-02T12:00:00Z',
  },
];

describe('audit views', () => {
  it('shows record history newest first with escaped reason and before/after', async () => {
    const { container } = render(RecordHistory, {
      entries,
      resourceType: 'Job',
      resourceId: 'job-1',
    });
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelector('ol > li')).toHaveTextContent(
      'bob · approved',
    );
    expect(
      screen.getByText('Reason: <script>test</script>'),
    ).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('status: draft → approved')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
  it('filters the authorized data by person, record and date', async () => {
    const user = userEvent.setup();
    const { container } = render(AuditList, { entries });
    await user.type(screen.getByLabelText('Person ID'), 'alice');
    await user.type(screen.getByLabelText('Record ID'), 'job-1');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(container.querySelectorAll('ol > li')).toHaveLength(1);
    expect(container.querySelector('ol')).toHaveTextContent('alice · created');
    await user.clear(screen.getByLabelText('Person ID'));
    await fireEvent.input(screen.getByLabelText('From date'), {
      target: { value: '2026-10-03' },
    });
    await fireEvent.input(screen.getByLabelText('To date'), {
      target: { value: '2026-10-03' },
    });
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(container.querySelectorAll('ol > li')).toHaveLength(1);
    expect(container.querySelector('ol')).toHaveTextContent('bob · approved');
    await expectNoA11yViolations(container);
  });
  it('passes server filters to the consumer and exposes loading/error/empty states', async () => {
    const user = userEvent.setup();
    const onfilter = vi.fn();
    const { rerender } = render(AuditList, { entries: [], onfilter });
    expect(screen.getByText('No audit entries.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Person ID'), 'bob');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(onfilter).toHaveBeenCalledWith({
      profileId: 'bob',
      resourceId: '',
      from: '',
      to: '',
    });
    await rerender({ entries: [], loading: true, error: 'Unavailable' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading audit entries',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Unavailable');
  });
});
