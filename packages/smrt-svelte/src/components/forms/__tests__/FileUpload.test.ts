/**
 * Component test for FileUpload (Sweep S11, #1416).
 *
 * Follows the golden pattern (src/components/ui/__tests__/Button.test.ts).
 * The native `<input type="file">` is visually hidden (so not in the a11y tree);
 * the interactive surface is a `role="button"` drop zone. We assert the input's
 * accept/multiple wiring and that selecting a file fires the change handler.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import FileUpload from '../FileUpload.svelte';

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input;
}

const png = (name = 'photo.png') =>
  new File(['data'], name, { type: 'image/png' });

describe('FileUpload', () => {
  it('renders a file input and a drop-zone button with the label', () => {
    const { container } = render(FileUpload, {
      props: { label: 'Drop files', hint: 'or browse' },
    });
    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByText('Drop files')).toBeInTheDocument();
    expect(fileInput(container)).toBeInTheDocument();
  });

  it('forwards accept and multiple to the file input', () => {
    const { container } = render(FileUpload, {
      props: { accept: 'image/png,.pdf', multiple: true },
    });
    const input = fileInput(container);
    expect(input).toHaveAttribute('accept', 'image/png,.pdf');
    expect(input).toHaveAttribute('multiple');
  });

  it('omits the multiple attribute by default', () => {
    const { container } = render(FileUpload);
    expect(fileInput(container)).not.toHaveAttribute('multiple');
  });

  it('fires onchange and lists the file when one is selected', async () => {
    const onchange = vi.fn();
    const { container } = render(FileUpload, {
      props: { accept: 'image/png', onchange },
    });
    await userEvent.upload(fileInput(container), png('selfie.png'));
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange.mock.calls[0][0]).toHaveLength(1);
    expect(onchange.mock.calls[0][0][0].name).toBe('selfie.png');
    expect(screen.getByText('selfie.png')).toBeInTheDocument();
  });

  it('removes a selected file via its remove button', async () => {
    const onchange = vi.fn();
    const { container } = render(FileUpload, { props: { onchange } });
    await userEvent.upload(fileInput(container), png('doc.png'));
    expect(screen.getByText('doc.png')).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: /remove doc\.png/i }),
    );
    expect(screen.queryByText('doc.png')).not.toBeInTheDocument();
    expect(onchange).toHaveBeenLastCalledWith([]);
  });

  it('rejects an oversized file and shows a max-size error', async () => {
    // userEvent.upload honors the `accept` filter, so we exercise rejection via
    // maxSize (which it does not enforce). A 4-byte file exceeds maxSize: 1.
    const onchange = vi.fn();
    const { container } = render(FileUpload, {
      props: { accept: 'image/png', maxSize: 1, onchange },
    });
    await userEvent.upload(fileInput(container), png('big.png'));
    expect(screen.queryByText('big.png')).not.toBeInTheDocument();
    expect(screen.getByText(/exceed the maximum size/i)).toBeInTheDocument();
  });

  it('disables the drop zone when disabled', () => {
    render(FileUpload, { props: { disabled: true } });
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '-1');
  });

  it('is axe-clean in the default state', async () => {
    const { container } = render(FileUpload, {
      props: { label: 'Upload your documents' },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean after a file is selected', async () => {
    const { container } = render(FileUpload, {
      props: { label: 'Upload your documents' },
    });
    await userEvent.upload(fileInput(container), png('report.png'));
    await expectNoA11yViolations(container);
  });
});
