import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import SubscriptionSummary from './SubscriptionSummary.svelte';

describe('SubscriptionSummary', () => {
  it('renders period dates with a deterministic locale and timezone', () => {
    const { body } = render(SubscriptionSummary, {
      props: {
        periodDisposition: 'renews',
        periodEnd: '2026-07-01T00:00:00Z',
      },
    });

    expect(body).toContain('Jul 1, 2026');
  });

  it('honours an explicit billing timezone', () => {
    const { body } = render(SubscriptionSummary, {
      props: {
        periodDisposition: 'ends',
        periodEnd: '2026-07-01T00:00:00Z',
        periodTimeZone: 'America/Edmonton',
      },
    });

    expect(body).toContain('Jun 30, 2026');
  });

  it('does not render an invalid billing date', () => {
    const { body } = render(SubscriptionSummary, {
      props: {
        periodDisposition: 'renews',
        periodEnd: 'not-a-date',
      },
    });

    expect(body).not.toContain('Invalid Date');
    expect(body).not.toContain('Period');
  });
});
