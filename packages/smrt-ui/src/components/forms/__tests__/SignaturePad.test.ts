/**
 * SignaturePad rendered states, pointer gating, PNG output, and native form
 * posting (smrt#3290).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y.js';
import SignaturePad from '../SignaturePad.svelte';
import {
  SIGNATURE_INK_COLOR,
  SIGNATURE_PAPER_COLOR,
} from '../signature-pad-logic.js';
import CaptureFormFixture from './capture-form.fixture.svelte';
import {
  stubCanvas,
  submittedEntries,
  useFileFieldStrategy,
} from './capture-test-env.js';

let context: ReturnType<typeof stubCanvas>;

beforeEach(() => {
  context = stubCanvas();
  useFileFieldStrategy('data-transfer');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function canvas(container: HTMLElement): HTMLCanvasElement {
  return container.querySelector('canvas') as HTMLCanvasElement;
}

function root(container: HTMLElement): HTMLElement {
  return container.querySelector('.signature-pad') as HTMLElement;
}

async function stroke(
  target: HTMLCanvasElement,
  pointerType = 'mouse',
  pointerId = 1,
) {
  await fireEvent.pointerDown(target, {
    pointerType,
    pointerId,
    clientX: 10,
    clientY: 10,
  });
  await fireEvent.pointerMove(target, {
    pointerType,
    pointerId,
    clientX: 60,
    clientY: 40,
  });
  await fireEvent.pointerUp(target, { pointerType, pointerId });
}

const useButton = () => screen.getByRole('button', { name: 'Use signature' });

describe('SignaturePad states', () => {
  it('starts empty on white paper with Use signature disabled', async () => {
    const { container } = render(SignaturePad);

    expect(root(container)).toHaveAttribute('data-state', 'empty');
    expect(useButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeEnabled();
    expect(canvas(container)).toHaveAttribute(
      'aria-label',
      'Signature area, not yet signed',
    );
    expect(
      screen.getByText('Sign with a stylus, your finger, or the mouse.'),
    ).toBeInTheDocument();
    // Paper is painted into the bitmap and shown behind it regardless of theme.
    expect(context.fillStyle).toBe(SIGNATURE_PAPER_COLOR);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 600, 240);
    expect(canvas(container).style.backgroundColor).toBe('rgb(255, 255, 255)');
    await expectNoA11yViolations(container);
  });

  it('enables Use signature once an accepted stroke exists, inked dark', async () => {
    const { container } = render(SignaturePad);
    await stroke(canvas(container));

    expect(root(container)).toHaveAttribute('data-state', 'signed');
    expect(canvas(container)).toHaveAttribute(
      'aria-label',
      'Signature area, signed',
    );
    expect(useButton()).toBeEnabled();
    expect(context.stroke).toHaveBeenCalled();
    expect(context.strokeStyle).toBe(SIGNATURE_INK_COLOR);
    await expectNoA11yViolations(container);
  });

  it('ignores finger and mouse under stylusOnly, and accepts the pen', async () => {
    const { container } = render(SignaturePad, { props: { stylusOnly: true } });
    expect(screen.getByText('Sign with the stylus.')).toBeInTheDocument();

    await stroke(canvas(container), 'touch');
    await stroke(canvas(container), 'mouse', 2);
    expect(root(container)).toHaveAttribute('data-state', 'empty');
    expect(useButton()).toBeDisabled();
    expect(context.stroke).not.toHaveBeenCalled();

    await stroke(canvas(container), 'pen', 3);
    expect(useButton()).toBeEnabled();
  });

  it('ignores a second pointer that did not start the stroke', async () => {
    const { container } = render(SignaturePad);
    await fireEvent.pointerMove(canvas(container), {
      pointerType: 'mouse',
      pointerId: 9,
    });
    expect(root(container)).toHaveAttribute('data-state', 'empty');
  });

  it('is inert when disabled', async () => {
    const { container } = render(SignaturePad, { props: { disabled: true } });
    await stroke(canvas(container));

    expect(root(container)).toHaveAttribute('data-state', 'empty');
    expect(useButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
  });

  it('returns a PNG through onCapture and locks the pad until cleared', async () => {
    const onCapture = vi.fn();
    const onClear = vi.fn();
    const { container } = render(SignaturePad, {
      props: { onCapture, onClear },
    });
    await stroke(canvas(container));
    await fireEvent.click(useButton());

    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'committed'),
    );
    const [{ blob, dataUrl }] = onCapture.mock.calls[0];
    expect(blob.type).toBe('image/png');
    expect(dataUrl).toMatch(/^data:image\/png/);
    expect(screen.getByRole('status')).toHaveTextContent('Signature attached.');
    expect(useButton()).toBeDisabled();

    context.stroke.mockClear();
    await stroke(canvas(container));
    expect(context.stroke).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(root(container)).toHaveAttribute('data-state', 'empty');
  });

  it('locks the pad while the PNG encodes so it commits once and matches the canvas', async () => {
    let finish!: () => void;
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(
      (callback, type) => {
        finish = () => callback(new Blob(['pixels'], { type }));
      },
    );
    const onCapture = vi.fn();
    const { container } = render(SignaturePad, { props: { onCapture } });
    await stroke(canvas(container));

    await fireEvent.click(useButton());
    expect(useButton()).toBeDisabled();
    await fireEvent.click(useButton());
    context.stroke.mockClear();
    await stroke(canvas(container), 'mouse', 2);
    expect(context.stroke).not.toHaveBeenCalled();

    finish();
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'committed'),
    );
    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it('discards an encoding superseded by Clear', async () => {
    let finish!: () => void;
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(
      (callback, type) => {
        finish = () => callback(new Blob(['pixels'], { type }));
      },
    );
    const onCapture = vi.fn();
    const { container } = render(SignaturePad, { props: { onCapture } });
    await stroke(canvas(container));
    await fireEvent.click(useButton());

    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    finish();
    await Promise.resolve();
    expect(onCapture).not.toHaveBeenCalled();
    expect(root(container)).toHaveAttribute('data-state', 'empty');
  });

  it('accepts label overrides', () => {
    render(SignaturePad, {
      props: { labels: { useSignature: 'Signer', clear: 'Effacer' } },
    });
    expect(screen.getByRole('button', { name: 'Signer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Effacer' })).toBeInTheDocument();
  });
});

describe('SignaturePad native form post', () => {
  it('posts the committed signature as signature.png and removes it on Clear', async () => {
    const { container } = render(CaptureFormFixture, {
      props: { kind: 'signature', name: 'signature' },
    });
    const form = container.querySelector('form') as HTMLFormElement;
    expect(root(container)).toHaveAttribute(
      'data-smrt-file-field',
      'data-transfer',
    );
    expect((submittedEntries(form).get('signature') as File).size).toBe(0);

    await stroke(canvas(container));
    await fireEvent.click(useButton());
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'committed'),
    );

    const posted = submittedEntries(form).getAll('signature') as File[];
    expect(posted).toHaveLength(1);
    expect(posted[0].name).toBe('signature.png');
    expect(posted[0].type).toBe('image/png');
    expect(submittedEntries(form).get('note')).toBe('hazard');

    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect((submittedEntries(form).get('signature') as File).size).toBe(0);
  });

  it('falls back to the formdata event when DataTransfer is unavailable', async () => {
    useFileFieldStrategy('formdata-event');
    const { container } = render(CaptureFormFixture, {
      props: { kind: 'signature', name: 'sig', fileName: 'flha-signature.png' },
    });
    await waitFor(() =>
      expect(root(container)).toHaveAttribute(
        'data-smrt-file-field',
        'formdata-event',
      ),
    );

    await stroke(canvas(container));
    await fireEvent.click(useButton());
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'committed'),
    );

    const posted = submittedEntries(
      container.querySelector('form') as HTMLFormElement,
    ).getAll('sig') as File[];
    expect(posted).toHaveLength(1);
    expect(posted[0].name).toBe('flha-signature.png');
  });
});
