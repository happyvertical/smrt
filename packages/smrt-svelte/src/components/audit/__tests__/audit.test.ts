import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AuditList from '../AuditList.svelte';
import RecordHistory from '../RecordHistory.svelte';
import type {
  AuditEntryLabel,
  AuditHistoryEntry,
  AuditResourceHref,
} from '../types.js';

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
    expect(container.querySelector('ol')).toHaveAttribute('role', 'list');
    expect(container.querySelector('ul')).toHaveAttribute('role', 'list');
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
  it('shows built-in filters by default', () => {
    render(AuditList, { entries });

    expect(screen.getByLabelText('Person ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Record ID')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Apply filters' }),
    ).toBeInTheDocument();
  });
  it('can hide built-in filters while retaining authorized entries', async () => {
    const { container } = render(AuditList, { entries, showFilters: false });

    expect(screen.queryByLabelText('Person ID')).toBeNull();
    expect(screen.queryByLabelText('Record ID')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply filters' })).toBeNull();
    expect(container.querySelectorAll('ol > li')).toHaveLength(entries.length);
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

  it('renders friendly labels, an authorized resource link and escaped formatted values', async () => {
    const resourceLabel = vi.fn(() => 'Kitchen renovation');
    const resourceHref = vi.fn(() => '/jobs/job-1');
    const actionLabel = vi.fn(() => '<em>Approved</em>');
    const fieldLabel = vi.fn(() => 'Status');
    const formatValue = vi.fn(
      (_value: unknown, context: { side: 'before' | 'after' }) =>
        context.side === 'before' ? '<img src=x>' : '<script>approved</script>',
    );
    const { container } = render(RecordHistory, {
      entries: [entries[1]],
      resourceLabel,
      resourceHref,
      actionLabel,
      fieldLabel,
      formatValue,
    });

    expect(
      screen.getByRole('link', { name: 'Kitchen renovation' }),
    ).toHaveAttribute('href', '/jobs/job-1');
    expect(
      screen.getByText('<em>Approved</em>', { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Status: <img src=x> → <script>approved</script>'),
    ).toBeInTheDocument();
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(resourceLabel).toHaveBeenCalledWith(entries[1]);
    expect(resourceHref).toHaveBeenCalledWith(entries[1]);
    expect(actionLabel).toHaveBeenCalledWith(entries[1]);
    expect(fieldLabel).toHaveBeenCalledWith('status', entries[1]);
    expect(formatValue).toHaveBeenCalledWith('draft', {
      entry: entries[1],
      field: 'status',
      side: 'before',
    });
    expect(formatValue).toHaveBeenCalledWith('approved', {
      entry: entries[1],
      field: 'status',
      side: 'after',
    });
    await expectNoA11yViolations(container);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,bad',
    '//example.com/jobs/job-1',
    '/\n/example.com/jobs/job-1',
    '/\t/example.com/jobs/job-1',
    '/\r/example.com/jobs/job-1',
    '\\\\example.com\\jobs\\job-1',
    'mailto:person@example.com',
  ])('renders unsafe resource href %s as plain text', (href) => {
    const { container } = render(RecordHistory, {
      entries: [entries[0]],
      resourceHref: () => href,
    });
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('Job / job-1');
  });

  it.each([
    '/jobs/job-1',
    'jobs/job-1',
    'https://example.com/jobs/job-1',
    'http://example.com/jobs/job-1',
  ])('links safe local or HTTP(S) resource href %s', (href) => {
    render(RecordHistory, {
      entries: [entries[0]],
      resourceHref: () => href,
    });
    expect(screen.getByRole('link', { name: 'Job / job-1' })).toHaveAttribute(
      'href',
      href,
    );
  });

  it('falls back to default text when presentation callbacks fail', () => {
    const fail = () => {
      throw new Error('presentation failed');
    };
    const malformedLabel = (() => 42) as unknown as AuditEntryLabel;
    const malformedHref = (() => ({
      href: '/jobs/job-1',
    })) as unknown as AuditResourceHref;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const entry = {
      ...entries[1],
      changes: {
        status: { before: circular, after: 'approved' },
      },
    };
    const { container } = render(RecordHistory, {
      entries: [entry],
      resourceLabel: malformedLabel,
      resourceHref: malformedHref,
      actionLabel: fail,
      fieldLabel: fail,
      formatValue: fail,
    });

    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('approved · Job / job-1');
    expect(container).toHaveTextContent('status: [object Object] → approved');
  });

  it('forwards presentation callbacks from AuditList', () => {
    render(AuditList, {
      entries: [entries[1]],
      resourceLabel: () => 'Kitchen renovation',
      resourceHref: () => '/jobs/job-1',
      actionLabel: () => 'Approved',
      fieldLabel: () => 'Status',
      formatValue: (value: unknown) => String(value).toUpperCase(),
    });

    const resourceLink = screen.getByRole('link', {
      name: 'Kitchen renovation',
    });
    expect(resourceLink).toHaveAttribute('href', '/jobs/job-1');
    expect(screen.getByText('Status: DRAFT → APPROVED')).toBeInTheDocument();
    expect(resourceLink.closest('p')).toHaveTextContent('bob · Approved');
  });
});
