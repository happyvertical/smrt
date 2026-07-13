import { describe, expect, it } from 'vitest';
import * as legacyWorkspace from '../legacy.js';

describe('legacy workspace barrel', () => {
  it('exposes the opt-in ToolsDock compatibility surface', () => {
    expect(legacyWorkspace.ToolsDock).toBeDefined();
    expect(legacyWorkspace.defineToolsDock).toBeDefined();
    expect(legacyWorkspace.useToolsDock).toBeDefined();
  });
});
