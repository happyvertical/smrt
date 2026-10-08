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
  mouth: vi.fn(),
  expression: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('../head-isolation.ts', () => ({ isolatePhotoHead: mocks.isolate }));
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
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        landmarks: {
          mouthLeft: { x: 340, y: 520 },
          mouthRight: { x: 660, y: 520 },
          chin: { x: 500, y: 880 },
        },
      }),
    }),
  );
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
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    await click(`Redo ${stage}`);
    await vi.waitFor(() => expect(active?.signal.aborted).toBe(true));
    expect(mocks.mouth).toHaveBeenLastCalledWith(0);
    expect(mocks.expression).toHaveBeenLastCalledWith({
      headTiltDegrees: 0,
      jawTiltDegrees: 0,
    });
    await vi.waitFor(() =>
      expect(
        stage === 'head isolation' ? mocks.isolate : fetch,
      ).toHaveBeenCalledTimes(2),
    );
    expect(button('Cancel')).toBeTruthy();
    expect(mocks.destroy).not.toHaveBeenCalled();
    active?.onLevel(1);
    expect(mocks.mouth).toHaveBeenLastCalledWith(0);
  });
});
