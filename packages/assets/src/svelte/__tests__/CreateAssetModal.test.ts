// @vitest-environment jsdom
/**
 * Component coverage for CreateAssetModal via the shared S11 harness (#1416).
 * The jsdom `<dialog>` showModal/close polyfill comes from the shared setup.
 */
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import CreateAssetModal from '../CreateAssetModal.svelte';

const baseProps = (over = {}) => ({
  open: true,
  oncreate: vi.fn(),
  onclose: vi.fn(),
  ...over,
});

describe('CreateAssetModal', () => {
  it('renders the upload dialog with a dropzone when open and empty', () => {
    render(CreateAssetModal, { props: baseProps() });
    expect(
      screen.getByRole('heading', { name: 'Upload Asset', hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Drag & drop/, { hidden: true })).toBeTruthy();
  });

  it('pre-loads an initial file into the metadata form', () => {
    // A non-image file avoids URL.createObjectURL (unimplemented in jsdom).
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    render(CreateAssetModal, { props: baseProps({ initialFile: file }) });
    expect(screen.getByText('notes.txt', { hidden: true })).toBeInTheDocument();
  });

  it('closes via Cancel', async () => {
    const onclose = vi.fn();
    render(CreateAssetModal, { props: baseProps({ onclose }) });
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel', hidden: true }),
    );
    expect(onclose).toHaveBeenCalled();
  });

  it('submits the pre-loaded file', async () => {
    const oncreate = vi.fn();
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    render(CreateAssetModal, {
      props: baseProps({ initialFile: file, oncreate }),
    });
    await userEvent.click(
      screen.getByRole('button', { name: /Upload/, hidden: true }),
    );
    expect(oncreate).toHaveBeenCalledWith(
      expect.objectContaining({ file: expect.any(File) }),
    );
  });
});
