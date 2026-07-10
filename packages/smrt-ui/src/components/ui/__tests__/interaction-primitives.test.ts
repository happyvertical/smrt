import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Fixture from './interaction-primitives.fixture.svelte';

describe('interaction primitives', () => {
  it('opens and dismisses a popover', async () => {
    render(Fixture);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(
      screen.queryByRole('dialog', { name: 'Filters' }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('supports disclosure and single-value accordion semantics', async () => {
    render(Fixture);
    await userEvent.click(screen.getByText('Details'));
    expect(screen.getByText('Disclosure details')).toBeVisible();
    await userEvent.click(
      screen.getByRole('button', { name: 'First section' }),
    );
    expect(
      screen.getByRole('region', { name: 'First section' }),
    ).toHaveTextContent('First content');
    await userEvent.click(
      screen.getByRole('button', { name: 'Second section' }),
    );
    expect(screen.queryByText('First content')).not.toBeInTheDocument();
  });

  it('is axe-clean with interactive content open', async () => {
    const { container } = render(Fixture);
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'First section' }),
    );
    await expectNoA11yViolations(container);
  });
});
