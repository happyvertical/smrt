/**
 * Smoke test: the workspace subpath barrel must export the new
 * NavTree and Breadcrumbs components (plus existing types).
 */

import { describe, expect, it } from 'vitest';
import type { ToolsDockEvents } from '../index.js';
import * as workspace from '../index.js';

describe('workspace barrel', () => {
  it('exports NavTree', () => {
    expect(workspace.NavTree).toBeDefined();
  });

  it('exports Breadcrumbs', () => {
    expect(workspace.Breadcrumbs).toBeDefined();
  });

  it('re-exports ToolsDockEvents for declaration merging', () => {
    // Compile-time assertion: the type must be importable from the barrel
    // so consumers can declaration-merge their own events into it.
    // (No runtime export; the `import type` above is the real check.)
    const _typeCheck: ToolsDockEvents['change'] = {
      isOpen: false,
      activeTool: null,
      context: null,
    };
    expect(_typeCheck.isOpen).toBe(false);
  });
});
