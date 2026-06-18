// @vitest-environment jsdom
/**
 * First component test in smrt-projects via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import DurationDisplay from '../DurationDisplay.svelte';

describe('DurationDisplay', () => {
  it('renders decimal hours to one decimal place', () => {
    render(DurationDisplay, { props: { hours: 2.5 } });
    expect(screen.getByText('2.5')).toBeInTheDocument();
  });

  it('renders an HH:MM value in hhmm format', () => {
    render(DurationDisplay, { props: { hours: 1.5, format: 'hhmm' } });
    expect(screen.getByText('1:30')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(DurationDisplay, {
      props: { hours: 8, showLabel: true },
    });
    await expectNoA11yViolations(container);
  });
});
