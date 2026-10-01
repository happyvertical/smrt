/**
 * FileUpload native-form wiring (#3260).
 *
 * jsdom has no `DataTransfer` constructor, so these tests cover attribute
 * forwarding, the visually-hidden (not `hidden`) input, the required-error
 * announcement, and the no-DataTransfer fallback. The DataTransfer path and the
 * `new FormData(form)` post are proven in a real browser by
 * `e2e/file-upload.spec.ts`.
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import FileUpload from '../FileUpload.svelte';

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  return input;
}

const txt = (name: string, size = 4) =>
  new File(['a'.repeat(size)], name, { type: 'text/plain' });

describe('FileUpload — native form wiring', () => {
  it('forwards name, capture and required to the file input', () => {
    const { container } = render(FileUpload, {
      props: { name: 'photo', capture: 'environment', required: true },
    });
    const input = fileInput(container);
    expect(input).toHaveAttribute('name', 'photo');
    expect(input).toHaveAttribute('capture', 'environment');
    expect(input).toBeRequired();
  });

  it('omits name, capture and required by default', () => {
    const { container } = render(FileUpload);
    const input = fileInput(container);
    expect(input).not.toHaveAttribute('name');
    expect(input).not.toHaveAttribute('capture');
    expect(input).not.toBeRequired();
  });

  it('keeps the input focusable for native validation but out of the a11y tree and tab order', () => {
    const { container } = render(FileUpload, { props: { required: true } });
    const input = fileInput(container);
    // `hidden` would make the control unfocusable, so the browser could not
    // show its required bubble and would silently block the submit.
    expect(input).not.toHaveAttribute('hidden');
    expect(input).toHaveClass('file-upload__input');
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toHaveAttribute('tabindex', '-1');
    // Not nested inside the role="button" drop zone (nested-interactive).
    expect(screen.getByRole('button').contains(input)).toBe(false);
  });

  it('announces a failed required check through the error live region', async () => {
    const { container } = render(FileUpload, { props: { required: true } });
    const input = fileInput(container);
    expect(input.checkValidity()).toBe(false);
    await fireEvent(input, new Event('invalid'));
    expect(screen.getByRole('alert').textContent?.trim()).not.toBe('');
  });

  it('is axe-clean with name, capture and required', async () => {
    const { container } = render(FileUpload, {
      props: {
        label: 'Mill cert photo',
        name: 'photo',
        capture: 'environment',
        required: true,
      },
    });
    await expectNoA11yViolations(container);
  });
});

describe('FileUpload — fallback without the DataTransfer constructor', () => {
  it('runs in an environment without DataTransfer', () => {
    expect(typeof (globalThis as { DataTransfer?: unknown }).DataTransfer).toBe(
      'undefined',
    );
  });

  it('keeps the native selection when it matches the accepted list', async () => {
    const { container } = render(FileUpload, { props: { name: 'doc' } });
    const input = fileInput(container);
    await userEvent.upload(input, txt('a.txt'));
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(input.files).toHaveLength(1);
    expect(input.files?.[0].name).toBe('a.txt');
  });

  it('clears the input when a file is removed, so it never posts', async () => {
    const { container } = render(FileUpload, { props: { name: 'doc' } });
    const input = fileInput(container);
    await userEvent.upload(input, txt('a.txt'));
    await userEvent.click(
      screen.getByRole('button', { name: /remove a\.txt/i }),
    );
    expect(input.files).toHaveLength(0);
  });

  it('clears the input when the pick is rejected, so it never posts', async () => {
    const { container } = render(FileUpload, {
      props: { name: 'doc', maxSize: 1 },
    });
    const input = fileInput(container);
    await userEvent.upload(input, txt('big.txt'));
    expect(screen.queryByText('big.txt')).not.toBeInTheDocument();
    expect(input.files).toHaveLength(0);
  });

  it('clears the input when an accumulated list no longer matches it', async () => {
    const { container } = render(FileUpload, {
      props: { name: 'doc', multiple: true },
    });
    const input = fileInput(container);
    await userEvent.upload(input, txt('a.txt'));
    await userEvent.upload(input, txt('b.txt'));
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();
    expect(input.files).toHaveLength(0);
  });
});
