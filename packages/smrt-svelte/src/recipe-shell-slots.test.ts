import { RECIPE_SHELL_SLOTS } from '@happyvertical/smrt-types';
import { describe, expect, it } from 'vitest';
import { SHELL_SLOTS } from './components/workspace/admin-shell/slots.js';

describe('recipe surface slots (#3708)', () => {
  it('RECIPE_SHELL_SLOTS in smrt-types matches the shell SHELL_SLOTS', () => {
    expect([...RECIPE_SHELL_SLOTS]).toEqual([...SHELL_SLOTS]);
  });
});
