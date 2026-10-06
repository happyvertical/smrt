import { describe, expect, it } from 'vitest';
import playground from '../playground.js';

describe('smrt-ui playground', () => {
  it('publishes themed base-control, data-table, and capture previews', () => {
    expect(playground.packageName).toBe('@happyvertical/smrt-ui');
    expect(playground.entries.map((entry) => entry.id)).toEqual([
      'permission-picker',
      'code-selectors',
      'base-controls',
      'interactive-controls',
      'feedback-overlays',
      'collections',
      'data-table',
      'calendar',
      'capture',
    ]);

    for (const entry of playground.entries) {
      expect(entry.loadComponent).toEqual(expect.any(Function));
      expect(entry.modes).toHaveProperty('mock');
    }
  });
});
