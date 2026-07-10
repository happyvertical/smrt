import { describe, expect, it } from 'vitest';
import playground from '../playground.js';

describe('smrt-ui playground', () => {
  it('publishes themed base-control and data-table previews', () => {
    expect(playground.packageName).toBe('@happyvertical/smrt-ui');
    expect(playground.entries.map((entry) => entry.id)).toEqual([
      'base-controls',
      'interactive-controls',
      'feedback-overlays',
      'collections',
      'data-table',
    ]);

    for (const entry of playground.entries) {
      expect(entry.loadComponent).toEqual(expect.any(Function));
      expect(entry.modes).toHaveProperty('mock');
    }
  });
});
