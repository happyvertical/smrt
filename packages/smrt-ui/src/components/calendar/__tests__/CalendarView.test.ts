import { act, render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import CalendarView from '../CalendarView.svelte';
import type { CalendarItem } from '../calendar-model.js';

const tz = 'America/Edmonton';
const now = new Date('2026-09-29T18:00:00Z');
const items: CalendarItem[] = [
  { id: 'fair', title: 'Fall Fair', start: '2026-09-05', end: '2026-09-07' },
  {
    id: 'council',
    title: 'Council meeting',
    start: new Date('2026-09-15T01:00:00Z'),
    label: 'Council',
    href: '/meetings/sept',
  },
  { id: 'a', title: 'Game A', start: new Date('2026-09-20T18:00:00Z') },
  { id: 'b', title: 'Game B', start: new Date('2026-09-20T19:00:00Z') },
  { id: 'c', title: 'Game C', start: new Date('2026-09-20T20:00:00Z') },
  { id: 'd', title: 'Game D', start: new Date('2026-09-20T21:00:00Z') },
];

function renderMonth(props: Record<string, unknown> = {}) {
  return render(CalendarView, {
    props: {
      items,
      timeZone: tz,
      locale: 'en-US',
      weekStartsOn: 0,
      mode: 'month',
      now,
      year: 2026,
      month: 9,
      ...props,
    },
  });
}

describe('CalendarView (month)', () => {
  it('renders a localized grid in the given zone', () => {
    renderMonth();
    expect(
      screen.getByRole('heading', { name: 'September 2026' }),
    ).toBeTruthy();
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    // 19:00 MDT on the 14th, not the 15th (UTC)
    expect(
      screen.getByRole('button', {
        name: 'Monday, September 14, 2026, 1 item',
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Tuesday, September 29, 2026' })
        .getAttribute('aria-current'),
    ).toBe('date');
  });

  it('renders month names in the requested locale', () => {
    renderMonth({ locale: 'fr-FR' });
    expect(screen.getByRole('heading').textContent?.trim()).toBe(
      'septembre 2026',
    );
  });

  it('renders all-day spans as bands and overflow as +N more', async () => {
    const onSelectDate = vi.fn();
    const { container } = renderMonth({ onSelectDate });
    // Sat Sep 5 - Mon Sep 7 wraps: one segment per week row.
    const bands = [...container.querySelectorAll<HTMLElement>('.cv-band')];
    expect(bands.map((b) => b.textContent?.trim())).toEqual([
      'Fall Fair',
      'Fall Fair',
    ]);
    expect(bands[0].style.gridColumn).toBe('7 / span 1');
    expect(bands[0].classList.contains('cv-band--after')).toBe(true);
    expect(bands[1].style.gridColumn).toBe('1 / span 2');
    expect(bands[1].classList.contains('cv-band--before')).toBe(true);

    const more = screen.getByText('+2 more');
    await userEvent.click(more);
    expect(onSelectDate).toHaveBeenCalledWith('2026-09-20');
    const panel = screen.getByRole('region', {
      name: 'Sunday, September 20, 2026',
    });
    expect(within(panel).getAllByRole('button', { name: /Game/ })).toHaveLength(
      4,
    );
    await userEvent.click(
      within(panel).getByRole('button', {
        name: 'Close Sunday, September 20, 2026',
      }),
    );
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('navigates with prev/next/today and reports the month', async () => {
    const onNavigate = vi.fn();
    render(CalendarView, {
      props: {
        items,
        timeZone: tz,
        locale: 'en-US',
        mode: 'month',
        now,
        onNavigate,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ year: 2026, month: 10 });
    expect(screen.getByRole('heading').textContent?.trim()).toBe(
      'October 2026',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onNavigate).toHaveBeenLastCalledWith({ year: 2026, month: 9 });
  });

  it('moves focus with arrow keys and crosses months', async () => {
    const onNavigate = vi.fn();
    renderMonth({ onNavigate, year: undefined, month: undefined });
    const today = screen.getByRole('button', {
      name: 'Tuesday, September 29, 2026',
    });
    expect(today.tabIndex).toBe(0);
    today.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect((document.activeElement as HTMLElement).dataset.cvDay).toBe(
      '2026-09-30',
    );
    await userEvent.keyboard('{ArrowRight}');
    expect(onNavigate).toHaveBeenLastCalledWith({ year: 2026, month: 10 });
    expect((document.activeElement as HTMLElement).dataset.cvDay).toBe(
      '2026-10-01',
    );
    await userEvent.keyboard('{ArrowUp}');
    expect((document.activeElement as HTMLElement).dataset.cvDay).toBe(
      '2026-09-24',
    );
    await userEvent.keyboard('{Home}');
    expect((document.activeElement as HTMLElement).dataset.cvDay).toBe(
      '2026-09-20',
    );
  });

  it('turns days into links with dayHref', () => {
    renderMonth({ dayHref: (d: string) => `/events/${d}` });
    const link = screen.getByRole('link', {
      name: 'Monday, September 14, 2026, 1 item',
    });
    expect(link.getAttribute('href')).toBe('/events/2026-09-14');
  });
});

describe('CalendarView accessibility', () => {
  it('is axe-clean in month mode with an open day', async () => {
    const { container } = renderMonth({ selectedDate: '2026-09-20' });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean in agenda mode', async () => {
    const { container } = renderMonth({ mode: 'agenda' });
    await expectNoA11yViolations(container);
  });
});

describe('CalendarView (agenda)', () => {
  it('lists days with items and a day strip', async () => {
    const onItemSelect = vi.fn();
    render(CalendarView, {
      props: {
        items,
        timeZone: tz,
        locale: 'en-US',
        mode: 'agenda',
        now,
        year: 2026,
        month: 9,
        onItemSelect,
      },
    });
    const strip = screen.getByRole('toolbar', {
      name: 'Days in September 2026',
    });
    expect(within(strip).getAllByRole('button')).toHaveLength(30);
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent?.trim());
    expect(headings).toEqual([
      'Saturday, September 5, 2026',
      'Sunday, September 6, 2026',
      'Monday, September 7, 2026',
      'Monday, September 14, 2026',
      'Sunday, September 20, 2026',
    ]);
    const link = screen.getByRole('link', { name: /Council meeting/ });
    expect(link.getAttribute('href')).toBe('/meetings/sept');
    expect(link.textContent).toContain('7:00 PM');
    expect(link.textContent).toContain('Council');
    expect(screen.getAllByText('Until Sep 7').length).toBeGreaterThan(0);

    await userEvent.click(
      within(strip).getByRole('button', {
        name: 'Thursday, September 10, 2026',
      }),
    );
    expect(
      screen.getByRole('heading', { name: 'Thursday, September 10, 2026' }),
    ).toBeTruthy();
    expect(screen.getAllByText('Nothing scheduled').length).toBe(1);
  });

  it('switches to the agenda on phones in auto mode', async () => {
    const matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 48rem)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      const { container } = render(CalendarView, {
        props: { items, timeZone: tz, locale: 'en-US', now },
      });
      await Promise.resolve();
      expect(
        container.querySelector('[data-view]')?.getAttribute('data-view'),
      ).toBe('agenda');
      expect(screen.queryByRole('grid')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('CalendarView robustness', () => {
  it('falls back instead of throwing on an invalid time zone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() =>
        renderMonth({ timeZone: 'Mars/Olympus_Mons' }),
      ).not.toThrow();
      expect(
        screen.getByRole('heading', { name: 'September 2026' }),
      ).toBeTruthy();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Mars/Olympus_Mons'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('moves the today highlight after midnight without a now prop', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      // 23:59 on Sep 29 in Edmonton (05:59Z on the 30th).
      vi.setSystemTime(new Date('2026-09-30T05:59:00Z'));
      renderMonth({ now: undefined });
      const day = (name: string) => screen.getByRole('button', { name });
      await act(() => {});
      expect(
        day('Tuesday, September 29, 2026').getAttribute('aria-current'),
      ).toBe('date');

      await act(() => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      expect(
        day('Wednesday, September 30, 2026').getAttribute('aria-current'),
      ).toBe('date');
      expect(
        day('Tuesday, September 29, 2026').getAttribute('aria-current'),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CalendarView (week)', () => {
  const props = {
    mode: 'week' as const,
    date: '2026-09-29',
    weekStartsOn: 1,
    timeZone: tz,
    locale: 'en-US',
    now,
  };

  it('renders seven days across months, zoned items, bands and day links', async () => {
    const onSelectDate = vi.fn();
    const { container } = render(CalendarView, {
      props: {
        ...props,
        onSelectDate,
        dayHref: (key) => `/day/${key}`,
        items: [
          {
            id: 'band',
            title: 'Holiday',
            start: '2026-09-27',
            end: '2026-09-30',
            tone: 'warning',
          },
          { id: 'timed', title: 'Meeting', start: '2026-09-29T01:00:00Z' },
        ],
      },
    });
    expect(screen.getAllByRole('gridcell')).toHaveLength(7);
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
    expect(container.querySelector('.cv-band')?.getAttribute('data-tone')).toBe(
      'warning',
    );
    expect(
      screen
        .getByRole('link', { name: /Monday, September 28, 2026, 2 items/ })
        .getAttribute('href'),
    ).toBe('/day/2026-09-28');
    await userEvent.click(
      screen.getByRole('link', { name: /Sunday, October 4, 2026/ }),
    );
    expect(onSelectDate).toHaveBeenCalledWith('2026-10-04');
    await expectNoA11yViolations(container);
  });

  it('opens cross-month selection and overflow only inside the visible week', async () => {
    const { container, rerender } = render(CalendarView, {
      props: {
        ...props,
        maxPerDay: 1,
        items: [
          { id: 'first', title: 'First event', start: '2026-10-01T18:00:00Z' },
          {
            id: 'hidden',
            title: 'Hidden event',
            start: '2026-10-01T19:00:00Z',
          },
        ],
      },
    });
    await userEvent.click(
      screen.getByRole('button', {
        name: /Thursday, October 1, 2026, 2 items/,
      }),
    );
    expect(
      screen.getByRole('heading', { name: 'Thursday, October 1, 2026' }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: /Close.*Thursday, October 1, 2026/ }),
    );
    await userEvent.click(screen.getByText('+2 more'));
    const panel = container.querySelector('.cv-day-panel') as HTMLElement;
    expect(within(panel).getByText('Hidden event')).toBeTruthy();

    await rerender({
      ...props,
      date: '2027-01-01',
      selectedDate: '2027-01-01',
    });
    expect(
      screen.getByRole('heading', { name: 'Friday, January 1, 2027' }),
    ).toBeTruthy();
    await rerender({
      ...props,
      date: '2027-01-08',
      selectedDate: '2027-01-01',
    });
    expect(container.querySelector('.cv-day-panel')).toBeNull();
  });

  it('reports date-based navigation within a month, today and controlled changes', async () => {
    const onNavigate = vi.fn();
    const { rerender } = render(CalendarView, {
      props: { ...props, onNavigate },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Previous week' }),
    );
    expect(onNavigate).toHaveBeenLastCalledWith({
      year: 2026,
      month: 9,
      date: '2026-09-21',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(onNavigate).toHaveBeenLastCalledWith({
      year: 2026,
      month: 9,
      date: '2026-09-28',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(onNavigate).toHaveBeenLastCalledWith({
      year: 2026,
      month: 9,
      date: '2026-09-28',
    });
    await rerender({ ...props, date: '2027-01-01', onNavigate });
    expect(
      screen.getByRole('button', { name: 'Friday, January 1, 2027' }),
    ).toBeTruthy();
  });

  it('moves roving keyboard focus across weeks and selects the focused day', async () => {
    const onNavigate = vi.fn();
    const onSelectDate = vi.fn();
    const { container } = render(CalendarView, {
      props: { ...props, onNavigate, onSelectDate },
    });
    screen.getByRole('button', { name: 'Tuesday, September 29, 2026' }).focus();
    await userEvent.keyboard('{End}{ArrowRight}');
    expect(document.activeElement?.getAttribute('data-cv-day')).toBe(
      '2026-10-05',
    );
    expect(onNavigate).toHaveBeenLastCalledWith({
      year: 2026,
      month: 10,
      date: '2026-10-05',
    });
    await userEvent.keyboard('{PageUp}{Home}{Enter}');
    expect(onSelectDate).toHaveBeenLastCalledWith('2026-09-28');
    expect(
      container.querySelectorAll('[data-cv-day][tabindex="0"]'),
    ).toHaveLength(1);
  });

  it('uses a seven-day phone agenda when auto selects the week grid', async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    try {
      const { container } = render(CalendarView, {
        props: { ...props, mode: 'auto', autoMode: 'week' },
      });
      await act();
      expect(container.querySelector('[data-view="agenda"]')).toBeTruthy();
      expect(container.querySelectorAll('[data-cv-day]')).toHaveLength(7);
      expect(screen.getByText('Nothing scheduled this week')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
      expect(
        container.querySelector('[data-cv-day="2026-10-05"]'),
      ).toBeTruthy();
    } finally {
      window.matchMedia = original;
    }
  });
});
