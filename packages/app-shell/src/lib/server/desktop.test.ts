import { describe, expect, it } from 'vitest';
import { isDesktopWrapper } from './desktop.ts';

describe('isDesktopWrapper', () => {
  it('is true only when the wrapper gave the sidecar a launch secret', () => {
    expect(
      isDesktopWrapper({ SMRT_DESKTOP_OWNER_LINK_SECRET: 'a'.repeat(64) }),
    ).toBe(true);
    expect(isDesktopWrapper({ SMRT_DESKTOP_OWNER_LINK_SECRET: '' })).toBe(
      false,
    );
    expect(isDesktopWrapper({})).toBe(false);
  });
});
