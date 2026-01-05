import { describe, expect, it } from 'vitest';
import { elevationTokens, typographyTokens } from '../typography';

describe('Typography & Elevation Tokens', () => {
  it('should have valid typography tokens', () => {
    expect(
      typographyTokens['--md-sys-typescale-body-large-font'],
    ).toBeDefined();
    expect(typographyTokens['--md-sys-typescale-display-large-font']).toContain(
      'Roboto',
    );
  });

  it('should have valid elevation tokens', () => {
    expect(elevationTokens['--md-sys-elevation-level1']).toBeDefined();
  });
});
