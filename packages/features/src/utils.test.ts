import { describe, expect, it } from 'vitest';
import { parseFeatureMetadata, serializeFeatureMetadata } from './utils.js';

describe('feature metadata helpers', () => {
  it('round-trips plain object metadata', () => {
    const serialized = serializeFeatureMetadata({
      audience: 'staff',
      rollout: 'alpha',
    });

    expect(parseFeatureMetadata(serialized)).toEqual({
      audience: 'staff',
      rollout: 'alpha',
    });
  });

  it('normalizes JSON object strings before storing them', () => {
    const serialized = serializeFeatureMetadata(
      '{"audience":"staff","rollout":"alpha"}',
    );

    expect(serialized).toBe('{"audience":"staff","rollout":"alpha"}');
    expect(parseFeatureMetadata(serialized)).toEqual({
      audience: 'staff',
      rollout: 'alpha',
    });
  });

  it('rejects non-object metadata strings during serialization', () => {
    expect(() => serializeFeatureMetadata('not-json')).toThrow(/plain object/);
    expect(() => serializeFeatureMetadata('["staff"]')).toThrow(/plain object/);
  });

  it('gracefully falls back for invalid stored metadata', () => {
    expect(parseFeatureMetadata('not-json')).toEqual({});
    expect(parseFeatureMetadata('["staff"]')).toEqual({});
  });
});
