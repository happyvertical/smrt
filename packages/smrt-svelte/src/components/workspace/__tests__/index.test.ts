/**
 * Smoke test: the workspace subpath barrel must export the new
 * NavTree and Breadcrumbs components (plus existing types).
 */

import { describe, expect, it } from 'vitest';
import * as workspace from '../index.js';

describe('workspace barrel', () => {
  it('exports NavTree', () => {
    expect(workspace.NavTree).toBeDefined();
  });

  it('exports Breadcrumbs', () => {
    expect(workspace.Breadcrumbs).toBeDefined();
  });
});
