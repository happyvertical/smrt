import { describe, expect, it } from 'vitest';
import * as gnode from '../index.js';

// Baseline smoke test for the stub gnode package. The package is described
// as "stubs only — not implemented" (see CLAUDE.md). This test exists to
// document the stub interface contract and catch accidental removals
// before the federation layer is implemented. Implementation tracked
// upstream as the gnode federation roadmap.
describe('@happyvertical/smrt-gnode (stub)', () => {
  it('exports a version constant', () => {
    expect(typeof gnode.version).toBe('string');
    expect(gnode.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exports federation surface (stub)', () => {
    // The federation and protocols modules are exported via wildcard
    // re-exports. They currently surface stub functions and types.
    // Once federation is implemented the assertions below should be
    // tightened to behavioral checks.
    const exports = Object.keys(gnode);
    expect(exports).toContain('version');
    expect(exports.length).toBeGreaterThan(1);
  });
});
