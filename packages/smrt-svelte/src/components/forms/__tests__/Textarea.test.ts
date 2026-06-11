/**
 * Golden test for Textarea (Sweep L1, #1420).
 *
 * Textarea forwards aria attributes and inherits id / describedby / invalid from
 * a wrapping FormGroup via context.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Textarea from '../Textarea.svelte';

describe('Textarea', () => {
  it('forwards aria-label / aria-describedby / aria-invalid', () => {
    render(Textarea, {
      props: {
        'aria-label': 'Notes',
        'aria-describedby': 'notes-hint',
        'aria-invalid': 'true',
      },
    });
    const textarea = screen.getByRole('textbox', { name: 'Notes' });
    expect(textarea).toHaveAttribute('aria-describedby', 'notes-hint');
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
  });

  it('accepts typed input', async () => {
    render(Textarea, { props: { 'aria-label': 'Notes' } });
    const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Notes',
    });
    await userEvent.type(textarea, 'hello');
    expect(textarea).toHaveValue('hello');
  });

  it('is axe-clean when labelled', async () => {
    const { container } = render(Textarea, {
      props: { 'aria-label': 'Notes' },
    });
    await expectNoA11yViolations(container);
  });
});
