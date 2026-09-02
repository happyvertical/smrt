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

  // #2605: `showLabel` used to be inert. `decimal` rendered `h` whatever the
  // prop said, and `hhmm` rendered an empty `<span class="unit">` instead of a
  // label. These pin the unit to the prop, and pin the unchanged defaults so a
  // later change to them has to be deliberate.
  describe('showLabel', () => {
    it('renders the decimal unit by default', () => {
      const { container } = render(DurationDisplay, { props: { hours: 2.5 } });
      expect(container.querySelector('.unit')?.textContent).toBe('h');
    });

    it('renders the decimal unit when showLabel is set', () => {
      const { container } = render(DurationDisplay, {
        props: { hours: 2.5, showLabel: true },
      });
      expect(container.querySelector('.unit')?.textContent).toBe('h');
    });

    it('drops the decimal unit when showLabel is cleared', () => {
      const { container } = render(DurationDisplay, {
        props: { hours: 2.5, showLabel: false },
      });
      expect(container.querySelector('.unit')).toBeNull();
      expect(container.textContent?.trim()).toBe('2.5');
    });

    it.each([
      undefined,
      true,
      false,
    ])('renders no unit element in hhmm format with showLabel=%s', (showLabel) => {
      const { container } = render(DurationDisplay, {
        props: { hours: 1.5, format: 'hhmm' as const, showLabel },
      });
      expect(container.querySelector('.unit')).toBeNull();
      expect(container.textContent?.trim()).toBe('1:30');
    });
  });

  it('is axe-clean', async () => {
    const { container } = render(DurationDisplay, {
      props: { hours: 8, showLabel: true },
    });
    await expectNoA11yViolations(container);
  });
});
