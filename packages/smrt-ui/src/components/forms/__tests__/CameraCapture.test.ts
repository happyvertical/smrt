/**
 * CameraCapture rendered states, stream release, and native form posting
 * (smrt#3290). `navigator.mediaDevices` is a fake; canvas, playback,
 * DataTransfer and the `formdata` event are jsdom stand-ins from
 * `capture-test-env.ts`.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y.js';
import CameraCapture from '../CameraCapture.svelte';
import CaptureFormFixture from './capture-form.fixture.svelte';
import {
  createFileList,
  type FakeTrack,
  fakeStream,
  installMediaDevices,
  removeMediaDevices,
  stubCanvas,
  stubMediaPlayback,
  submittedEntries,
  useFileFieldStrategy,
} from './capture-test-env.js';

function grantCamera(track: FakeTrack = { stop: vi.fn() }) {
  const getUserMedia = vi.fn().mockResolvedValue(fakeStream([track]));
  installMediaDevices({ getUserMedia });
  return { getUserMedia, track };
}

function rejectCamera(name: string) {
  const getUserMedia = vi.fn().mockRejectedValue(new DOMException('x', name));
  installMediaDevices({ getUserMedia });
  return getUserMedia;
}

function root(container: HTMLElement): HTMLElement {
  return container.querySelector('.camera-capture') as HTMLElement;
}

async function expectState(container: HTMLElement, state: string) {
  await waitFor(() =>
    expect(root(container)).toHaveAttribute('data-state', state),
  );
}

beforeEach(() => {
  stubCanvas();
  stubMediaPlayback();
  useFileFieldStrategy('data-transfer');
});

afterEach(() => {
  removeMediaDevices();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CameraCapture states', () => {
  it('shows the starting state while the permission prompt is pending', async () => {
    installMediaDevices({ getUserMedia: () => new Promise(() => {}) });
    const { container } = render(CameraCapture);

    await expectState(container, 'starting');
    expect(screen.getByRole('status')).toHaveTextContent('Starting camera…');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('streams a live preview with a Take photo action', async () => {
    const { getUserMedia } = grantCamera();
    const { container } = render(CameraCapture, {
      props: { facingMode: 'user' },
    });

    await expectState(container, 'streaming');
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'user' },
      audio: false,
    });
    expect(container.querySelector('video')).not.toHaveClass('hidden');
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeEnabled();
    await expectNoA11yViolations(container);
  });

  it.each([
    ['NotAllowedError', 'permission-denied', /Camera access was denied/],
    ['NotFoundError', 'no-camera', /No camera was found/],
    ['AbortError', 'error', /Could not access the camera/],
  ])('renders %s as the %s state with a retry', async (name, state, copy) => {
    const getUserMedia = rejectCamera(name);
    const { container } = render(CameraCapture);

    await expectState(container, state);
    expect(screen.getByRole('status')).toHaveTextContent(copy);
    await expectNoA11yViolations(container);

    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  });

  it('renders the unsupported state without getUserMedia, with no file-input fallback by default', async () => {
    installMediaDevices(undefined);
    const { container } = render(CameraCapture, { props: { name: 'photo' } });

    await expectState(container, 'unsupported');
    expect(screen.getByRole('status')).toHaveTextContent(
      /cannot use the camera/,
    );
    expect(container.querySelector('input[capture]')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders the off state when disabled and never requests the camera', async () => {
    const { getUserMedia } = grantCamera();
    const { container } = render(CameraCapture, { props: { disabled: true } });

    await expectState(container, 'off');
    expect(screen.getByRole('status')).toHaveTextContent('The camera is off.');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('accepts label overrides', async () => {
    rejectCamera('NotAllowedError');
    render(CameraCapture, {
      props: {
        labels: { permissionDenied: 'Kamera verweigert', retry: 'Nochmal' },
      },
    });

    expect(await screen.findByText('Kamera verweigert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nochmal' })).toBeInTheDocument();
  });
});

describe('CameraCapture review flow', () => {
  it('captures, reviews, retakes, and reports only the committed photo', async () => {
    const { getUserMedia, track } = grantCamera();
    const onCapture = vi.fn();
    const { container } = render(CameraCapture, { props: { onCapture } });
    await expectState(container, 'streaming');

    await fireEvent.click(screen.getByRole('button', { name: 'Take photo' }));
    await expectState(container, 'reviewing');
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('img', { name: 'Captured photo, not yet used' }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);

    await fireEvent.click(screen.getByRole('button', { name: 'Retake' }));
    await expectState(container, 'streaming');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(onCapture).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Take photo' }));
    await expectState(container, 'reviewing');
    await fireEvent.click(screen.getByRole('button', { name: 'Use photo' }));

    await expectState(container, 'committed');
    expect(onCapture).toHaveBeenCalledTimes(1);
    const [{ blob, dataUrl }] = onCapture.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/jpeg');
    expect(dataUrl).toMatch(/^data:image\/jpeg/);
    expect(screen.getByRole('status')).toHaveTextContent('Photo attached.');
    expect(
      screen.getByRole('img', { name: 'Attached photo' }),
    ).toBeInTheDocument();
  });

  it('stops the stream on unmount', async () => {
    const { track } = grantCamera();
    const { container, unmount } = render(CameraCapture);
    await expectState(container, 'streaming');

    unmount();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the stream when disabled and restarts it when re-enabled', async () => {
    const { getUserMedia, track } = grantCamera();
    const { container, rerender } = render(CameraCapture);
    await expectState(container, 'streaming');

    await rerender({ disabled: true });
    expect(track.stop).toHaveBeenCalledTimes(1);
    await expectState(container, 'off');

    await rerender({ disabled: false });
    await expectState(container, 'streaming');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('re-requests the camera when facingMode changes while live', async () => {
    const { getUserMedia, track } = grantCamera();
    const { container, rerender } = render(CameraCapture);
    await expectState(container, 'streaming');

    await rerender({ facingMode: 'user' });
    expect(track.stop).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(getUserMedia).toHaveBeenLastCalledWith({
        video: { facingMode: 'user' },
        audio: false,
      }),
    );
    await expectState(container, 'streaming');
  });

  it('keeps a photo under review across disable without reopening the camera', async () => {
    const { getUserMedia } = grantCamera();
    const { container, rerender } = render(CameraCapture);
    await expectState(container, 'streaming');
    await fireEvent.click(screen.getByRole('button', { name: 'Take photo' }));
    await expectState(container, 'reviewing');

    await rerender({ disabled: true });
    expect(root(container)).toHaveAttribute('data-state', 'reviewing');
    expect(screen.getByRole('button', { name: 'Use photo' })).toBeDisabled();

    await rerender({ disabled: false });
    expect(root(container)).toHaveAttribute('data-state', 'reviewing');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('releases a stream granted after unmount (late permission)', async () => {
    let grant!: (stream: MediaStream) => void;
    installMediaDevices({
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    });
    const track = { stop: vi.fn() };
    const { unmount } = render(CameraCapture);
    await waitFor(() => expect(grant).toBeTypeOf('function'));

    unmount();
    grant(fakeStream([track]));
    await waitFor(() => expect(track.stop).toHaveBeenCalledTimes(1));
  });
});

describe('CameraCapture native form post', () => {
  async function commitPhoto(container: HTMLElement) {
    await expectState(container, 'streaming');
    await fireEvent.click(screen.getByRole('button', { name: 'Take photo' }));
    await expectState(container, 'reviewing');
    await fireEvent.click(screen.getByRole('button', { name: 'Use photo' }));
    await expectState(container, 'committed');
  }

  it('posts the committed photo as a file through DataTransfer', async () => {
    grantCamera();
    const onClear = vi.fn();
    const { container } = render(CaptureFormFixture, {
      props: { kind: 'camera', name: 'photo', onClear },
    });
    const form = container.querySelector('form') as HTMLFormElement;
    expect(root(container)).toHaveAttribute(
      'data-smrt-file-field',
      'data-transfer',
    );
    expect(form.method).toBe('post');
    expect(form.enctype).toBe('multipart/form-data');

    // Before commit the field posts what an empty native file input posts.
    await expectState(container, 'streaming');
    expect((submittedEntries(form).get('photo') as File).size).toBe(0);

    await commitPhoto(container);
    const posted = submittedEntries(form).getAll('photo') as File[];
    expect(posted).toHaveLength(1);
    expect(posted[0].name).toBe('photo.jpg');
    expect(posted[0].type).toBe('image/jpeg');
    expect(posted[0].size).toBeGreaterThan(0);

    await fireEvent.click(screen.getByRole('button', { name: 'Retake' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect((submittedEntries(form).get('photo') as File).size).toBe(0);
  });

  it('honours fileName and imageType', async () => {
    grantCamera();
    const { container } = render(CaptureFormFixture, {
      props: {
        kind: 'camera',
        name: 'receipt',
        fileName: 'receipt.png',
        imageType: 'image/png',
      },
    });
    await commitPhoto(container);

    const posted = submittedEntries(
      container.querySelector('form') as HTMLFormElement,
    ).get('receipt') as File;
    expect(posted.name).toBe('receipt.png');
    expect(posted.type).toBe('image/png');
  });

  it('falls back to the formdata event when DataTransfer is unavailable', async () => {
    useFileFieldStrategy('formdata-event');
    grantCamera();
    const { container } = render(CaptureFormFixture, {
      props: { kind: 'camera', name: 'photo' },
    });
    const form = container.querySelector('form') as HTMLFormElement;
    await waitFor(() =>
      expect(root(container)).toHaveAttribute(
        'data-smrt-file-field',
        'formdata-event',
      ),
    );
    const field = container.querySelector('[data-smrt-capture-field]');
    expect(field).not.toHaveAttribute('name');

    await commitPhoto(container);
    const posted = submittedEntries(form).getAll('photo') as File[];
    expect(posted).toHaveLength(1);
    expect(posted[0].name).toBe('photo.jpg');
  });

  it('posts nothing but still reports the photo when no strategy exists', async () => {
    useFileFieldStrategy('none');
    grantCamera();
    const onCapture = vi.fn();
    const { container } = render(CaptureFormFixture, {
      props: { kind: 'camera', name: 'photo', onCapture },
    });
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-smrt-file-field', 'none'),
    );

    await commitPhoto(container);
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(
      submittedEntries(container.querySelector('form') as HTMLFormElement).has(
        'photo',
      ),
    ).toBe(false);
  });

  it('opt-in file-input fallback posts the chosen photo natively', async () => {
    installMediaDevices(undefined);
    const onCapture = vi.fn();
    const { container } = render(CaptureFormFixture, {
      props: {
        kind: 'camera',
        name: 'photo',
        fileInputFallback: true,
        onCapture,
      },
    });
    await expectState(container, 'fallback');
    expect(root(container)).toHaveAttribute(
      'data-smrt-file-field',
      'file-input',
    );
    const picker = screen.getByLabelText(
      'Take or choose a photo',
    ) as HTMLInputElement;
    expect(picker).toHaveAttribute('capture', 'environment');
    expect(picker).toHaveAttribute('accept', 'image/*');
    expect(container.querySelector('[data-smrt-capture-field]')).toBeNull();
    await expectNoA11yViolations(container);

    const chosen = new File(['jpeg'], 'IMG_0001.jpg', { type: 'image/jpeg' });
    picker.files = createFileList([chosen]);
    await fireEvent.change(picker);

    await expectState(container, 'committed');
    expect(onCapture).toHaveBeenCalledWith({
      blob: chosen,
      dataUrl: expect.stringMatching(/^data:image\/jpeg/),
    });
    expect(
      submittedEntries(
        container.querySelector('form') as HTMLFormElement,
      ).getAll('photo'),
    ).toEqual([chosen]);
  });
});
