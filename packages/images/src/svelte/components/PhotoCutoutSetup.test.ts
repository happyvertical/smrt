// @vitest-environment jsdom
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PhotoCutoutSetup from './PhotoCutoutSetup.svelte';

let component: ReturnType<typeof mount>;
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === name,
  );
async function click(name: string) {
  await vi.waitFor(() =>
    expect(button(name), `${name}: ${document.body.textContent}`).toBeTruthy(),
  );
  button(name)?.click();
  await tick();
}

const mocks = vi.hoisted(() => ({
  isolate: vi.fn(),
  detectFaceLandmarks: vi.fn(),
  mouth: vi.fn(),
  expression: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('../head-isolation.ts', () => ({ isolatePhotoHead: mocks.isolate }));
vi.mock('@happyvertical/images/segmentation', () => ({
  detectFaceLandmarks: mocks.detectFaceLandmarks,
}));
vi.mock('@happyvertical/animation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/animation')>()),
  mountPhotoCutout: () => ({
    setMouthOpen: mocks.mouth,
    setExpression: mocks.expression,
    destroy: mocks.destroy,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      decode = async () => {};
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-head');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  mocks.isolate.mockResolvedValue({
    file: new File(['synthetic'], 'head.png', { type: 'image/png' }),
    width: 100,
    height: 120,
    outline: {
      points: [
        { x: 100, y: 0 },
        { x: 900, y: 0 },
        { x: 900, y: 1000 },
        { x: 100, y: 1000 },
      ],
    },
  });
  mocks.detectFaceLandmarks.mockResolvedValue({
    mouthLeft: { x: 340, y: 520 },
    mouthRight: { x: 660, y: 520 },
    chin: { x: 500, y: 880 },
  });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(async () => {
  if (component) await unmount(component);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('redo during speech', () => {
  it.each([
    'head isolation',
    'mouth segmentation',
  ])('stops and neutralizes speech before pending %s', async (stage) => {
    let active:
      | {
          signal: AbortSignal;
          onLevel: (level: number) => void;
          onStart?: () => void;
        }
      | undefined;
    const speechPreview = vi.fn(
      (_text: string, options: NonNullable<typeof active>) => {
        active = options;
        options.onStart?.();
        options.onLevel(1);
        return new Promise<void>(() => {});
      },
    );
    component = mount(PhotoCutoutSetup, {
      target: document.body,
      props: { speechPreview },
    });
    await tick();
    const input = document.querySelector('input');
    if (!input) throw new Error('Photo input is missing');
    Object.defineProperty(input, 'files', {
      value: [new File(['synthetic'], 'source.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    await click('Isolate head');
    await click('Continue: segment mouth');
    await click('Play speech');
    expect(active?.signal.aborted).toBe(false);
    expect(mocks.mouth).toHaveBeenLastCalledWith(1);
    expect(mocks.expression).toHaveBeenLastCalledWith(
      expect.objectContaining({ jawTiltDegrees: 7 }),
    );
    mocks.isolate.mockImplementation(() => new Promise(() => {}));
    mocks.detectFaceLandmarks.mockImplementation(() => new Promise(() => {}));
    await click(`Redo ${stage}`);
    await vi.waitFor(() => expect(active?.signal.aborted).toBe(true));
    expect(mocks.mouth).toHaveBeenLastCalledWith(0);
    expect(mocks.expression).toHaveBeenLastCalledWith({
      headTiltDegrees: 0,
      jawTiltDegrees: 0,
    });
    await vi.waitFor(() =>
      expect(
        stage === 'head isolation' ? mocks.isolate : mocks.detectFaceLandmarks,
      ).toHaveBeenCalledTimes(2),
    );
    expect(button('Cancel')).toBeTruthy();
    expect(mocks.destroy).not.toHaveBeenCalled();
    active?.onLevel(1);
    expect(mocks.mouth).toHaveBeenLastCalledWith(0);
  });
});

describe('local mouth landmarks', () => {
  it('uses the isolated local image without fetching a vision endpoint', async () => {
    component = mount(PhotoCutoutSetup, { target: document.body });
    await tick();
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Photo picker is missing');
    Object.defineProperty(input, 'files', {
      value: [new File(['synthetic'], 'source.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await click('Isolate head');
    await click('Continue: segment mouth');
    await vi.waitFor(() => expect(button('Open mouth')).toBeTruthy());
    expect(mocks.detectFaceLandmarks).toHaveBeenCalledWith(
      expect.any(Image),
      expect.objectContaining({
        assetBaseUrl: '/api/dev-image-segmentation',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('photo picker', () => {
  it('keeps the accepted photo when an unsupported replacement is selected', async () => {
    component = mount(PhotoCutoutSetup, { target: document.body });
    await tick();
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Photo picker is missing');
    expect(input.getAttribute('aria-label')).toBe('Choose character photo');
    expect(button('Isolate head')?.disabled).toBe(true);
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['synthetic'], 'source.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(button('Isolate head')?.disabled).toBe(false);
    Object.defineProperty(input, 'files', {
      value: [new File(['not an image'], 'source.txt', { type: 'text/plain' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(document.body.textContent).toContain(
      'Your previous photo is still selected.',
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    await click('Isolate head');
    await vi.waitFor(() => expect(mocks.isolate).toHaveBeenCalledTimes(1));
  });
});

function dropPhoto(file: File) {
  const picker = document.querySelector('label.file-picker');
  if (!picker) throw new Error('File picker drop target is missing');
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
  picker.dispatchEvent(event);
}

describe('photo picker drop', () => {
  it('accepts a first dropped photo for isolation', async () => {
    component = mount(PhotoCutoutSetup, { target: document.body });
    await tick();
    const photo = new File(['first'], 'first.png', { type: 'image/png' });
    dropPhoto(photo);
    await tick();
    expect(URL.createObjectURL).toHaveBeenCalledWith(photo);
    expect(button('Isolate head')?.disabled).toBe(false);
    await click('Isolate head');
    await vi.waitFor(() => expect(mocks.isolate).toHaveBeenCalledTimes(1));
  });

  it('cancels pending work and clears the old rig when a replacement is dropped', async () => {
    component = mount(PhotoCutoutSetup, { target: document.body });
    await tick();
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('Photo picker is missing');
    Object.defineProperty(input, 'files', {
      value: [new File(['first'], 'first.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    await click('Isolate head');
    await click('Continue: segment mouth');
    await vi.waitFor(() => expect(button('Open mouth')).toBeTruthy());
    const previousHead = await mocks.isolate.mock.results[0].value;
    let complete: (head: typeof previousHead) => void = () => {};
    mocks.isolate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await click('Redo head isolation');
    await vi.waitFor(() => expect(mocks.isolate).toHaveBeenCalledTimes(2));
    const pendingSignal = mocks.isolate.mock.calls[1][1].signal;
    expect(pendingSignal.aborted).toBe(false);
    const replacement = new File(['replacement'], 'replacement.png', {
      type: 'image/png',
    });
    dropPhoto(replacement);
    await tick();
    expect(pendingSignal.aborted).toBe(true);
    expect(URL.createObjectURL).toHaveBeenLastCalledWith(replacement);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(button('Open mouth')).toBeUndefined();
    expect(button('Continue: segment mouth')).toBeUndefined();
    expect(button('Isolate head')?.disabled).toBe(false);
    complete(previousHead);
    await tick();
    expect(button('Continue: segment mouth')).toBeUndefined();
    expect(
      document.querySelector('img[alt="Selected character source"]'),
    ).toBeTruthy();
  });
});
