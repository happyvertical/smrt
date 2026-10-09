import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ShellSectionIcon from '../admin-shell/ShellSectionIcon.svelte';
import {
  SHELL_DEFAULT_SECTION_ICON,
  SHELL_ICON_PATHS,
} from '../admin-shell/shell-icons.js';

afterEach(cleanup);

describe('ShellSectionIcon', () => {
  it('never prints an unknown name; it draws the default glyph', () => {
    const { container } = render(ShellSectionIcon, {
      name: 'definitely-not-an-icon',
    });
    expect(container.textContent?.trim()).toBe('');
    expect(container.querySelector('path')?.getAttribute('d')).toBe(
      SHELL_ICON_PATHS[SHELL_DEFAULT_SECTION_ICON],
    );
  });

  it('draws repeat and tag as real glyphs', () => {
    for (const name of ['repeat', 'tag', 'archive']) {
      const { container } = render(ShellSectionIcon, { name });
      expect(container.querySelector('path')?.getAttribute('d')).toBe(
        SHELL_ICON_PATHS[name as keyof typeof SHELL_ICON_PATHS],
      );
      cleanup();
    }
  });
});
