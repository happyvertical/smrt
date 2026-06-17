// @vitest-environment jsdom
/**
 * Component coverage for TimeEntryCard via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import TimeEntryCard from '../TimeEntryCard.svelte';

const entry = {
  id: 'e1',
  date: '2026-06-01',
  description: 'Implement feature',
  status: 'draft',
  hours: 3,
  hourlyRate: 100,
  amount: 300,
  workerName: 'Ada Lovelace',
} as any;

describe('TimeEntryCard', () => {
  it('renders the entry description, status, and worker', () => {
    render(TimeEntryCard, { props: { entry } });
    expect(screen.getByText('Implement feature')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('forwards checkbox selection through onselect', async () => {
    const onselect = vi.fn();
    render(TimeEntryCard, {
      props: { entry, selectable: true, onselect },
    });
    await userEvent.click(
      screen.getByLabelText('Select time entry for Implement feature'),
    );
    expect(onselect).toHaveBeenCalledWith('e1', true);
  });

  it('invokes onclick when the card is activated', async () => {
    const onclick = vi.fn();
    render(TimeEntryCard, { props: { entry, onclick } });
    await userEvent.click(screen.getByText('Implement feature'));
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it('is axe-clean', async () => {
    const { container } = render(TimeEntryCard, {
      props: { entry, selectable: true, onselect: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });
});
