// @vitest-environment jsdom
/**
 * Component coverage for ExpiringQualificationsList via the shared S11
 * harness (#1416): rendering from props, soonest-first order, the empty
 * state, `onselect`, and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ExpiringQualificationView } from '../../types.js';
import ExpiringQualificationsList from '../ExpiringQualificationsList.svelte';

const items: ExpiringQualificationView[] = [
  {
    id: 'held-3',
    displayName: 'Cy Young',
    qualificationName: 'Forklift',
    expiresOn: '2026-10-20',
    daysUntilExpiry: 17,
  },
  {
    id: 'held-1',
    displayName: 'Ada Lovelace',
    qualificationName: 'First aid',
    expiresOn: '2026-10-03',
    daysUntilExpiry: 0,
  },
  {
    id: 'held-2',
    displayName: 'Bob Stone',
    qualificationName: 'Working at heights',
    expiresOn: '2026-10-04',
    daysUntilExpiry: 1,
  },
];

describe('ExpiringQualificationsList', () => {
  it('shows the person, the qualification, the expiry date and the days left', () => {
    render(ExpiringQualificationsList, { props: { items: [items[0]] } });
    expect(screen.getByText('Cy Young')).toBeInTheDocument();
    expect(screen.getByText('Forklift')).toBeInTheDocument();
    expect(screen.getByText('Expires 2026-10-20')).toBeInTheDocument();
    expect(screen.getByText('In 17 days')).toBeInTheDocument();
  });

  it('lists the soonest expiry first whatever order the host passes', () => {
    render(ExpiringQualificationsList, { props: { items } });
    expect(
      screen.getAllByRole('listitem').map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining('Ada Lovelace'),
      expect.stringContaining('Bob Stone'),
      expect.stringContaining('Cy Young'),
    ]);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('In 1 day')).toBeInTheDocument();
  });

  it('shows the default and a custom empty message', () => {
    const { unmount } = render(ExpiringQualificationsList, {
      props: { items: [] },
    });
    expect(
      screen.getByText('No qualifications expiring soon'),
    ).toBeInTheDocument();
    unmount();
    render(ExpiringQualificationsList, {
      props: { items: [], emptyMessage: 'All clear' },
    });
    expect(screen.getByText('All clear')).toBeInTheDocument();
  });

  it('calls onselect with the held-qualification id', async () => {
    const onselect = vi.fn();
    render(ExpiringQualificationsList, { props: { items, onselect } });
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Open qualification: Working at heights held by Bob Stone',
      }),
    );
    expect(onselect).toHaveBeenCalledExactlyOnceWith('held-2');
  });

  it('is axe-clean', async () => {
    const { container } = render(ExpiringQualificationsList, {
      props: { items, onselect: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });
});
