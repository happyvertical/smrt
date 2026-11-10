import { describe, expect, it } from 'vitest';
import { normalizeObservedImageRegions } from './observed-regions.js';

const valid = {
  version: 1,
  coordinateSpace: 'display-oriented',
  regions: [
    {
      id: 'r1',
      text: 'Visible blue learner response',
      rect: [0.2, 0.3, 0.1, 0.1],
    },
  ],
};
describe('advisory image observations', () => {
  it('copies bounded observed regions without verified boxes', () => {
    expect(normalizeObservedImageRegions(valid)).toEqual(valid);
    expect(normalizeObservedImageRegions(valid)).not.toBe(valid);
  });
  it.each([
    undefined,
    null,
    [],
    { ...valid, version: 2 },
    { ...valid, coordinateSpace: 'raw' },
    { ...valid, regions: Array(65).fill(valid.regions[0]) },
    ...[
      [NaN, 0, 1, 1],
      [0, 0, 0, 1],
      [-1, 0, 1, 1],
      [0.9, 0, 0.2, 1],
      [0, 0, Infinity, 1],
    ].map((rect) => ({ ...valid, regions: [{ ...valid.regions[0], rect }] })),
    { ...valid, regions: [valid.regions[0], valid.regions[0]] },
  ])('omits invalid metadata %#', (value) =>
    expect(normalizeObservedImageRegions(value)).toBeUndefined());
});
