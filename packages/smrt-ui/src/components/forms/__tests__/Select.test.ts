/**
 * Golden test for Select (Sweep L1, #1420).
 *
 * Select forwards aria attributes (so it can be labelled / error-associated)
 * and inherits id / describedby / invalid from a wrapping FormGroup via context.
 */

import { expectNoA11yViolations } from '../../../test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import Select from '../Select.svelte';

function options() {
  return createRawSnippet(() => ({
    render: () => `<option value="a">A</option><option value="b">B</option>`,
  }));
}

describe('Select', () => {
  it('forwards aria-label / aria-describedby / aria-invalid', () => {
    render(Select, {
      props: {
        'aria-label': 'Country',
        'aria-describedby': 'country-hint',
        'aria-invalid': 'true',
        children: options(),
      },
    });
    const select = screen.getByRole('combobox', { name: 'Country' });
    expect(select).toHaveAttribute('aria-describedby', 'country-hint');
    expect(select).toHaveAttribute('aria-invalid', 'true');
  });

  it('is axe-clean when labelled', async () => {
    const { container } = render(Select, {
      props: { 'aria-label': 'Country', children: options() },
    });
    await expectNoA11yViolations(container);
  });
});
