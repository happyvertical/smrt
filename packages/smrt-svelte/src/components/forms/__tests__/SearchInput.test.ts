/**
 * Component test for SearchInput (Sweep S11, #1416).
 *
 * Follows the golden pattern (src/components/ui/__tests__/Button.test.ts).
 * A `type="search"` input surfaces as a `searchbox` role. The component is
 * Provider-free (its i18n falls back to registered defaults outside a Provider).
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SearchInput from '../SearchInput.svelte';

describe('SearchInput', () => {
  it('renders a searchbox with its default accessible name', () => {
    render(SearchInput);
    expect(
      screen.getByRole('searchbox', { name: 'Search' }),
    ).toBeInTheDocument();
  });

  it('uses ariaLabel as the accessible name and shows the placeholder', () => {
    render(SearchInput, {
      props: { ariaLabel: 'Find articles', placeholder: 'Type to search…' },
    });
    const box = screen.getByRole('searchbox', { name: 'Find articles' });
    expect(box).toHaveAttribute('placeholder', 'Type to search…');
  });

  it('reflects the value and disabled props', () => {
    render(SearchInput, {
      props: { ariaLabel: 'Search', value: 'hello', disabled: true },
    });
    const box = screen.getByRole('searchbox', { name: 'Search' });
    expect(box).toHaveValue('hello');
    expect(box).toBeDisabled();
  });

  it('fires oninput immediately while typing (no debounce)', async () => {
    const oninput = vi.fn();
    render(SearchInput, {
      props: { ariaLabel: 'Search', debounce: 0, oninput },
    });
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search' }),
      'ab',
    );
    expect(oninput).toHaveBeenCalledTimes(2);
    expect(oninput).toHaveBeenLastCalledWith('ab');
  });

  it('fires onsearch on Enter and onsubmit with the current value', async () => {
    const onsearch = vi.fn();
    const onsubmit = vi.fn();
    render(SearchInput, {
      props: { ariaLabel: 'Search', debounce: 0, onsearch, onsubmit },
    });
    const box = screen.getByRole('searchbox', { name: 'Search' });
    await userEvent.type(box, 'query{Enter}');
    expect(onsubmit).toHaveBeenCalledWith('query');
    expect(onsearch).toHaveBeenLastCalledWith('query');
  });

  it('shows a clear button once there is a value and clears on click', async () => {
    const oninput = vi.fn();
    render(SearchInput, {
      props: { ariaLabel: 'Search', debounce: 0, value: 'something', oninput },
    });
    const clear = screen.getByRole('button', { name: 'Clear search' });
    await userEvent.click(clear);
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
    expect(oninput).toHaveBeenLastCalledWith('');
  });

  it('does not render a clear button when empty', () => {
    render(SearchInput, { props: { ariaLabel: 'Search' } });
    expect(
      screen.queryByRole('button', { name: 'Clear search' }),
    ).not.toBeInTheDocument();
  });

  it('is axe-clean in the default state', async () => {
    const { container } = render(SearchInput, {
      props: { ariaLabel: 'Search the catalog' },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean with a value (clear button visible)', async () => {
    const { container } = render(SearchInput, {
      props: { ariaLabel: 'Search the catalog', value: 'shoes' },
    });
    await expectNoA11yViolations(container);
  });
});
