import { describe, expect, it, vi } from 'vitest';
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
