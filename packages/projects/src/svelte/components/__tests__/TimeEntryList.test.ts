// @vitest-environment jsdom
/**
 * Component coverage for TimeEntryList via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import TimeEntryList from '../TimeEntryList.svelte';

const entries = [
  {
    id: 'e1',
    date: '2026-06-01',
    description: 'First task',
    status: 'draft',
    hours: 2,
  },
  {
    id: 'e2',
    date: '2026-06-02',
    description: 'Second task',
    status: 'draft',
    hours: 4,
  },
] as any[];

describe('TimeEntryList', () => {
  it('renders a card per entry', () => {
    render(TimeEntryList, { props: { entries } });
    expect(screen.getByText('First task')).toBeInTheDocument();
    expect(screen.getByText('Second task')).toBeInTheDocument();
  });

  it('shows the empty message when there are no entries', () => {
    render(TimeEntryList, {
      props: { entries: [], emptyMessage: 'No time entries' },
    });
    expect(screen.getByText('No time entries')).toBeInTheDocument();
  });

  it('selects all entries via the header checkbox', async () => {
    const onselectionchange = vi.fn();
    render(TimeEntryList, {
      props: { entries, selectable: true, onselectionchange },
    });
    await userEvent.click(screen.getByLabelText('Select all time entries'));
    expect(onselectionchange).toHaveBeenCalledWith(['e1', 'e2']);
  });

  it('is axe-clean', async () => {
    const { container } = render(TimeEntryList, {
      props: { entries, selectable: true, onselectionchange: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });
});
