/**
 * Regression: FileUpload validation errors are announced (C7).
 *
 * The error `<p>` was a plain element, so async reject errors (wrong type /
 * oversize) were not surfaced to screen readers — unlike Form/TextInput which
 * announce. The fix makes it a live region (role="alert" + aria-live).
 */
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import FileUpload from '../FileUpload.svelte';

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input;
}

describe('FileUpload — error live region (C7)', () => {
  it('announces a max-size error via role="alert"', async () => {
    const { container } = render(FileUpload, {
      // maxSize forces a validation error without an `accept` filter (which
      // userEvent.upload would otherwise apply before the file reaches the
      // component, suppressing the error path under test).
      props: { label: 'Upload', maxSize: 4 },
    });

    const big = new File(['way too many bytes'], 'big.bin', {
      type: 'application/octet-stream',
    });
    await userEvent.upload(fileInput(container), big);

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveAttribute('aria-live');
      expect(alert.textContent).toMatch(/maximum size/i);
    });
  });
});
