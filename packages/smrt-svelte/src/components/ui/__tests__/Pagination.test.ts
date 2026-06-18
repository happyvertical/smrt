/**
 * Component test for Pagination (Sweep S11, #1416).
 *
 * Pagination has two modes: link mode (anchors, default) and callback mode
 * (buttons + `onPageChange`). This suite exercises the callback mode for
 * interaction (clicking pages/prev/next fires the callback; bounds disable the
 * edge controls) and verifies the navigation landmark, current-page marking,
 * and a11y. aria-labels resolve to their registered English defaults outside a
 * Provider (e.g. "Previous page", "Go to page 2").
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Pagination from '../Pagination.svelte';

describe('Pagination', () => {
  it('renders nothing when there is a single page', () => {
    const { container } = render(Pagination, {
      props: { currentPage: 1, totalPages: 1 },
    });
    expect(container.querySelector('.pagination')).toBeNull();
  });

  it('renders a navigation landmark with the provided aria-label', () => {
    render(Pagination, {
      props: { currentPage: 1, totalPages: 5, 'aria-label': 'Article pages' },
    });
    expect(
      screen.getByRole('navigation', { name: 'Article pages' }),
    ).toBeInTheDocument();
  });

  it('marks the current page with aria-current and renders it as a non-link', () => {
    render(Pagination, {
      props: { currentPage: 3, totalPages: 5, onPageChange: vi.fn() },
    });
    const current = screen.getByText('3');
    expect(current).toHaveAttribute('aria-current', 'page');
    // current page is a span, not a button
    expect(current.tagName).toBe('SPAN');
  });

  it('fires onPageChange with the clicked page number (callback mode)', async () => {
    const onPageChange = vi.fn();
    render(Pagination, {
      props: { currentPage: 1, totalPages: 5, onPageChange },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Go to page 3' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('fires onPageChange for prev and next relative to the current page', async () => {
    const onPageChange = vi.fn();
    render(Pagination, {
      props: { currentPage: 3, totalPages: 5, onPageChange },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Previous page' }),
    );
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenLastCalledWith(4);
  });

  it('disables prev/first on the first page and blocks their callback', async () => {
    const onPageChange = vi.fn();
    render(Pagination, {
      props: { currentPage: 1, totalPages: 5, onPageChange },
    });
    const prev = screen.getByRole('button', { name: 'Previous page' });
    const first = screen.getByRole('button', { name: 'First page' });
    expect(prev).toBeDisabled();
    expect(first).toBeDisabled();
    await userEvent.click(prev);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('disables next/last on the last page and blocks their callback', async () => {
    const onPageChange = vi.fn();
    render(Pagination, {
      props: { currentPage: 5, totalPages: 5, onPageChange },
    });
    const next = screen.getByRole('button', { name: 'Next page' });
    const last = screen.getByRole('button', { name: /Last page/ });
    expect(next).toBeDisabled();
    expect(last).toBeDisabled();
    await userEvent.click(next);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('renders numbered pages as links in link mode (no onPageChange)', () => {
    render(Pagination, {
      props: { currentPage: 1, totalPages: 3, baseUrl: '/articles' },
    });
    const page2 = screen.getByRole('link', { name: 'Go to page 2' });
    expect(page2).toHaveAttribute('href', '/articles/page/2');
  });

  it('is axe-clean in callback mode on a middle page', async () => {
    const { container } = render(Pagination, {
      props: { currentPage: 3, totalPages: 10, onPageChange: vi.fn() },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean in link mode at the first-page boundary', async () => {
    const { container } = render(Pagination, {
      props: { currentPage: 1, totalPages: 4, baseUrl: '/articles' },
    });
    await expectNoA11yViolations(container);
  });
});
