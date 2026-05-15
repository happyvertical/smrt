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

  it('exports RoleShell', () => {
    expect(workspace.RoleShell).toBeDefined();
  });

  it('re-exports ToolsDockEvents for typed dock:* event payloads', () => {
    // Compile-time assertion: the type must be importable from the barrel
    // so consumers can reference the built-in `'dock:*'` event payloads in
    // their own typed wrappers / stores.
    // (No runtime export; the `import type` above is the real check.)
    const _typeCheck: ToolsDockEvents['dock:change'] = {
      isOpen: false,
      activeTool: null,
      context: null,
    };
    expect(_typeCheck.isOpen).toBe(false);
  });
});
