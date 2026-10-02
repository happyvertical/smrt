/**
 * `createFormRetry()` around a form holding a named `CameraCapture` or
 * `SignaturePad` (#3290, #3291), through the structural fake of SvelteKit's
 * `use:enhance` from the form-retry tests.
 *
 * A successful submit of an unchanged form calls `update({ reset: true })`,
 * which resets the form and so empties every native file input. The capture
 * component must empty with it: otherwise it keeps showing the attachment
 * while the next submit posts an empty file entry, and the person believes a
 * photo or signature went with a record that has none.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeEnhance,
  fakeRunOnceServer,
} from '../form-retry/__tests__/fake-kit.js';
import { createFormRetry } from '../form-retry/controller.js';
import { resetFormRetryMemory } from '../form-retry/submission-key.js';
import CaptureFormFixture from './capture-form.fixture.svelte';
import {
  fakeStream,
  installMediaDevices,
  removeMediaDevices,
  stubCanvas,
  stubMediaPlayback,
  useFileFieldStrategy,
} from './capture-test-env.js';

type Kind = 'camera' | 'signature';
type Strategy = 'data-transfer' | 'formdata-event';

const FIELD: Record<Kind, string> = { camera: 'photo', signature: 'signature' };
const FILE: Record<Kind, string> = {
  camera: 'file:photo.jpg',
  signature: 'file:signature.png',
};

beforeEach(() => {
  resetFormRetryMemory();
  sessionStorage.clear();
  stubCanvas();
  stubMediaPlayback();
  installMediaDevices({
    getUserMedia: vi.fn().mockResolvedValue(fakeStream()),
  });
});

afterEach(() => {
  removeMediaDevices();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function root(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-state]') as HTMLElement;
}

async function expectState(container: HTMLElement, state: string) {
  await waitFor(() =>
    expect(root(container)).toHaveAttribute('data-state', state),
  );
}

async function commit(container: HTMLElement, kind: Kind) {
  if (kind === 'camera') {
    await expectState(container, 'streaming');
    await fireEvent.click(screen.getByRole('button', { name: 'Take photo' }));
    await expectState(container, 'reviewing');
    await fireEvent.click(screen.getByRole('button', { name: 'Use photo' }));
  } else {
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    await fireEvent.pointerDown(canvas, { pointerType: 'mouse', pointerId: 1 });
    await fireEvent.pointerMove(canvas, {
      pointerType: 'mouse',
      pointerId: 1,
      clientX: 40,
      clientY: 20,
    });
    await fireEvent.pointerUp(canvas, { pointerType: 'mouse', pointerId: 1 });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Use signature' }),
    );
  }
  await expectState(container, 'committed');
}

/**
 * A browser fires `formdata` while `new FormData(form)` builds the entry list;
 * jsdom does not, so the fake kit's submit hook dispatches it for the
 * `formdata-event` strategy's listener.
 */
function browserFormData(form: HTMLFormElement) {
  return (formData: FormData) => {
    const event = new Event('formdata');
    Object.defineProperty(event, 'formData', { value: formData });
    form.dispatchEvent(event);
  };
}

describe('createFormRetry with a capture field', () => {
  it.each<[Kind, Strategy]>([
    ['camera', 'data-transfer'],
    ['camera', 'formdata-event'],
    ['signature', 'data-transfer'],
    ['signature', 'formdata-event'],
  ])('a successful submit clears the %s (%s), so the next submit cannot post a shown-but-empty attachment', async (kind, strategy) => {
    useFileFieldStrategy(strategy);
    const name = FIELD[kind];
    const onClear = vi.fn();
    const { container } = render(CaptureFormFixture, {
      props: { kind, name, onClear },
    });
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-smrt-file-field', strategy),
    );
    const form = container.querySelector('form') as HTMLFormElement;
    const server = fakeRunOnceServer();
    const retry = createFormRetry({ form: `capture-${kind}`, storage: null });
    retry.attach(form);
    const kit = fakeEnhance(form, retry.enhance(), server);

    await commit(container, kind);
    await kit.submit(browserFormData(form));

    expect(retry.state.status).toBe('success');
    expect(kit.updates).toEqual([{ reset: true }]);
    expect(server.rows).toHaveLength(1);
    expect(server.rows[0].fields[name]).toEqual([FILE[kind]]);

    // The reset reached the component: nothing is shown, onClear fired.
    await expectState(container, kind === 'camera' ? 'streaming' : 'empty');
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    // The next submit posts what is shown: no file, and not the old one.
    await kit.submit(browserFormData(form));
    expect(server.rows).toHaveLength(2);
    expect(server.rows[1].fields[name]).toEqual(['file:']);

    // A new capture posts as its own record.
    await commit(container, kind);
    await kit.submit(browserFormData(form));
    expect(server.rows).toHaveLength(3);
    expect(server.rows[2].fields[name]).toEqual([FILE[kind]]);
  });

  it('keeps the capture when the person moved on before the submit resolved', async () => {
    useFileFieldStrategy('data-transfer');
    const onClear = vi.fn();
    const { container } = render(CaptureFormFixture, {
      props: { kind: 'signature', name: 'signature', onClear },
    });
    const form = container.querySelector('form') as HTMLFormElement;
    const server = fakeRunOnceServer();
    const retry = createFormRetry({ form: 'capture-moved-on', storage: null });
    retry.attach(form);
    const kit = fakeEnhance(form, retry.enhance(), server);

    const held = server.hold();
    const first = kit.submit();
    await vi.waitFor(() => expect(retry.state.status).toBe('submitting'));
    // The next entry is signed while the first submit is unresolved.
    await commit(container, 'signature');
    held.release();
    await first;

    expect(kit.updates).toEqual([{ reset: false }]);
    expect(root(container)).toHaveAttribute('data-state', 'committed');
    expect(onClear).not.toHaveBeenCalled();
    await kit.submit();
    expect(server.rows.at(-1)?.fields.signature).toEqual([
      'file:signature.png',
    ]);
  });
});
