import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  mountPhotoCutout: vi.fn(),
  setMouthOpen: vi.fn(),
}));

vi.mock('@happyvertical/animation', () => ({
  mountPhotoCutout: mocks.mountPhotoCutout,
}));

import {
  createHelperStyleRegistry,
  createPhotoCutoutHelperStyle,
  type HelperStyleDefinition,
} from '../registry.js';

const style = (id: string): HelperStyleDefinition => ({
  id,
  label: id,
  mount: () => ({ destroy: vi.fn(), setMouthOpen: vi.fn() }),
});

describe('helper style registry', () => {
  const photoInput = () => ({
    target: {} as HTMLElement,
    offering: {
      id: 'photo:1',
      label: 'Saved photo',
      styleId: 'photo-cutout',
      source: 'saved' as const,
      assetId: '1',
    },
    payload: { rig: {}, image: new Blob(['photo'], { type: 'image/png' }) },
  });

  it('keeps speech-envelope amplitude through the boolean playback callback', () => {
    mocks.mountPhotoCutout.mockReturnValue({
      destroy: mocks.destroy,
      setMouthOpen: mocks.setMouthOpen,
    });
    const renderer = createPhotoCutoutHelperStyle().mount(photoInput());
    if (renderer instanceof Promise)
      throw new Error('Expected synchronous mount');

    renderer.setMouthOpen(0.18);
    renderer.setSpeaking?.(true);
    renderer.setMouthOpen(0.79);
    renderer.setSpeaking?.(true);
    renderer.setSpeaking?.(false);
    renderer.destroy();

    expect(mocks.setMouthOpen.mock.calls).toEqual([[0.18], [0.79], [0]]);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it('keeps the panel independent of registered style implementations', () => {
    const thirdParty = style('paper-doll');
    const registry = createHelperStyleRegistry([style('happy'), thirdParty]);
    expect(registry.get('paper-doll')).toBe(thirdParty);
    expect(registry.list().map((entry) => entry.id)).toEqual([
      'happy',
      'paper-doll',
    ]);
  });

  it('rejects blank and duplicate registered identifiers', () => {
    expect(() =>
      createHelperStyleRegistry([style(''), style('photo')]),
    ).toThrow('blank');
    expect(() =>
      createHelperStyleRegistry([style('photo'), style('photo')]),
    ).toThrow('Duplicate');
  });

  it('refuses photographic payloads that do not include a Blob', () => {
    const photo = createPhotoCutoutHelperStyle();
    expect(() =>
      photo.mount({
        target: {} as HTMLElement,
        offering: {
          id: 'photo:1',
          label: 'Saved photo',
          styleId: 'photo-cutout',
          source: 'saved',
          assetId: '1',
        },
        payload: { rig: {} },
      }),
    ).toThrow('validated rig and image');
  });
});
