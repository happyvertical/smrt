/**
 * RelationInput moved to smrt-ui (#3637). The smrt-svelte forms barrel keeps a
 * deprecated re-export so published consumers keep working; it must be the very
 * same component, not a copy.
 */

import { RelationInput as SmrtUiRelationInput } from '@happyvertical/smrt-ui/forms';
import { describe, expect, it } from 'vitest';
import { RelationInput } from '../index.js';

describe('RelationInput re-export', () => {
  it('is the smrt-ui component', () => {
    expect(RelationInput).toBeDefined();
    expect(RelationInput).toBe(SmrtUiRelationInput);
  });
});
