/**
 * Component tests for DateDisplay (Sweep S11, #1416).
 *
 * DateDisplay parses a Date/ISO/timestamp and renders a <time datetime> element
 * (or a fallback <span> for null/invalid input). Expected formatted strings are
 * derived via Intl.DateTimeFormat with the SAME options the component uses, so
 * assertions stay locale/timezone-robust. Relative mode is exercised with
 * offsets from `now`. Tests assert the real API from DateDisplay.svelte.
 */
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import DateDisplay from '../DateDisplay.svelte';

const LOCALE = 'en-CA';

/** Build the component's expected output for an absolute format. */
function expected(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  locale = LOCALE,
): string {
  return new Intl.DateTimeFormat(locale, options).format(date);
}

const SHORT = { month: 'short', day: 'numeric' } as const;
const MEDIUM = { year: 'numeric', month: 'short', day: 'numeric' } as const;
const LONG = {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
} as const;

describe('DateDisplay', () => {
  // Use a fixed local-noon date so date-part is timezone-stable.
  const sample = new Date(2024, 0, 15, 12, 0, 0); // 15 Jan 2024, local noon

  it('renders a <time> element with the ISO datetime attribute', () => {
    const { container } = render(DateDisplay, { props: { date: sample } });
    const time = container.querySelector('time');
    expect(time).toBeInTheDocument();
    expect(time).toHaveAttribute('datetime', sample.toISOString());
  });

  it('formats with medium options by default', () => {
    render(DateDisplay, { props: { date: sample } });
    expect(screen.getByText(expected(sample, MEDIUM))).toBeInTheDocument();
  });

  it('formats with short options', () => {
    render(DateDisplay, { props: { date: sample, format: 'short' } });
    expect(screen.getByText(expected(sample, SHORT))).toBeInTheDocument();
  });

  it('formats with long options', () => {
    render(DateDisplay, { props: { date: sample, format: 'long' } });
    expect(screen.getByText(expected(sample, LONG))).toBeInTheDocument();
  });

  it('includes time when showTime is set', () => {
    render(DateDisplay, { props: { date: sample, showTime: true } });
    const withTime = expected(sample, {
      ...MEDIUM,
      hour: 'numeric',
      minute: '2-digit',
    });
    expect(screen.getByText(withTime)).toBeInTheDocument();
  });

  it('respects a custom locale', () => {
    render(DateDisplay, {
      props: { date: sample, format: 'long', locale: 'fr-CA' },
    });
    expect(
      screen.getByText(expected(sample, LONG, 'fr-CA')),
    ).toBeInTheDocument();
  });

  it('parses an ISO string input', () => {
    const iso = '2024-01-15T12:00:00.000Z';
    const d = new Date(iso);
    const { container } = render(DateDisplay, { props: { date: iso } });
    expect(container.querySelector('time')).toHaveAttribute(
      'datetime',
      d.toISOString(),
    );
  });

  it('parses a numeric timestamp input', () => {
    const ts = sample.getTime();
    const { container } = render(DateDisplay, { props: { date: ts } });
    expect(container.querySelector('time')).toHaveAttribute(
      'datetime',
      new Date(ts).toISOString(),
    );
  });

  it('renders the fallback span for null input', () => {
    const { container } = render(DateDisplay, {
      props: { date: null, fallback: 'No date' },
    });
    expect(container.querySelector('time')).not.toBeInTheDocument();
    const span = screen.getByText('No date');
    expect(span).toHaveClass('date-fallback');
  });

  it('renders the default fallback for an invalid date string', () => {
    render(DateDisplay, { props: { date: 'not-a-date' } });
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('renders "just now" for the current time in relative mode', () => {
    render(DateDisplay, { props: { date: new Date(), format: 'relative' } });
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('renders "yesterday" for ~1 day ago in relative mode', () => {
    const d = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago → 1 day
    render(DateDisplay, { props: { date: d, format: 'relative' } });
    expect(screen.getByText('yesterday')).toBeInTheDocument();
  });

  it('renders "tomorrow" for a near-future date in relative mode', () => {
    const d = new Date(Date.now() + 23 * 60 * 60 * 1000); // 23h ahead → tomorrow
    render(DateDisplay, { props: { date: d, format: 'relative' } });
    expect(screen.getByText('tomorrow')).toBeInTheDocument();
  });

  it('appends a custom class to the time element', () => {
    const { container } = render(DateDisplay, {
      props: { date: sample, class: 'my-date' },
    });
    expect(container.querySelector('time')).toHaveClass('my-date');
  });

  it('is axe-clean with a date', async () => {
    const { container } = render(DateDisplay, { props: { date: sample } });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean with the fallback', async () => {
    const { container } = render(DateDisplay, { props: { date: null } });
    await expectNoA11yViolations(container);
  });
});
