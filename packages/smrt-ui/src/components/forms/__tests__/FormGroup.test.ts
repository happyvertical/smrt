/**
 * Golden test for FormGroup accessibility wiring (Sweep L1, #1420).
 *
 * FormGroup must make a wrapped base input programmatically accessible with no
 * extra wiring: a real <label> association, hint/error linked via
 * aria-describedby, and aria-invalid in the error state.
 */

import { expectNoA11yViolations } from '../../../test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Fixture from './form-group-input.fixture.svelte';

describe('FormGroup a11y wiring', () => {
  it('associates its label with the wrapped input', () => {
    render(Fixture, {});
    // getByLabelText only resolves if the label is programmatically associated.
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('links a hint via aria-describedby', () => {
    render(Fixture, { props: { hint: 'Work address preferred' } });
    const input = screen.getByLabelText('Email');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const hint = document.getElementById(describedBy as string);
    expect(hint).toHaveTextContent('Work address preferred');
  });

  it('sets aria-invalid and links the error in the error state', () => {
    render(Fixture, { props: { error: 'Email is required' } });
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    const error = document.getElementById(describedBy as string);
    expect(error).toHaveTextContent('Email is required');
    // error is announced
    expect(error).toHaveAttribute('role', 'alert');
  });

  it('is axe-clean (labelled control, associated hint)', async () => {
    const { container } = render(Fixture, {
      props: { hint: 'Work address preferred' },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean in the error state', async () => {
    const { container } = render(Fixture, {
      props: { error: 'Email is required' },
    });
    await expectNoA11yViolations(container);
  });
});
