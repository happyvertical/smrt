import { describe, expect, it } from 'vitest';
import { elevationTokens, typographyTokens } from '../typography';

describe('Typography & Elevation Tokens', () => {
  it('should have valid typography tokens', () => {
    expect(typographyTokens['--smrt-typography-body-large-font']).toBeDefined();
    expect(typographyTokens['--smrt-typography-display-large-font']).toContain(
      'Roboto',
    );
  });

  it('should have valid elevation tokens', () => {
    expect(elevationTokens['--smrt-elevation-1']).toBeDefined();
  });
});
