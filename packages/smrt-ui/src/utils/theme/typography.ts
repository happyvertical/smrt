// Default font family - can be overridden via --smrt-font-family CSS variable
const fontFamily = 'var(--smrt-font-family, Roboto, sans-serif)';

export const typographyTokens = {
  // Font family token for customization
  '--smrt-font-family': 'Roboto, sans-serif',

  '--md-sys-typescale-display-large-font': `400 57px/64px ${fontFamily}`,
  '--md-sys-typescale-display-medium-font': `400 45px/52px ${fontFamily}`,
  '--md-sys-typescale-display-small-font': `400 36px/44px ${fontFamily}`,

  '--md-sys-typescale-headline-large-font': `400 32px/40px ${fontFamily}`,
  '--md-sys-typescale-headline-medium-font': `400 28px/36px ${fontFamily}`,
  '--md-sys-typescale-headline-small-font': `400 24px/32px ${fontFamily}`,

  '--md-sys-typescale-title-large-font': `400 22px/28px ${fontFamily}`,
  '--md-sys-typescale-title-medium-font': `500 16px/24px ${fontFamily}`,
  '--md-sys-typescale-title-small-font': `500 14px/20px ${fontFamily}`,

  '--md-sys-typescale-label-large-font': `500 14px/20px ${fontFamily}`,
  '--md-sys-typescale-label-medium-font': `500 12px/16px ${fontFamily}`,
  '--md-sys-typescale-label-small-font': `500 11px/16px ${fontFamily}`,

  '--md-sys-typescale-body-large-font': `400 16px/24px ${fontFamily}`,
  '--md-sys-typescale-body-medium-font': `400 14px/20px ${fontFamily}`,
  '--md-sys-typescale-body-small-font': `400 12px/16px ${fontFamily}`,
};

// Simplified elevation using box-shadow
export const elevationTokens = {
  '--md-sys-elevation-level0': 'none',
  '--md-sys-elevation-level1':
    '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 1px 3px 1px rgba(0,0,0,0.15)',
  '--md-sys-elevation-level2':
    '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 2px 6px 2px rgba(0,0,0,0.15)',
  '--md-sys-elevation-level3':
    '0px 1px 3px 0px rgba(0,0,0,0.3), 0px 4px 8px 3px rgba(0,0,0,0.15)',
  '--md-sys-elevation-level4':
    '0px 2px 3px 0px rgba(0,0,0,0.3), 0px 6px 10px 4px rgba(0,0,0,0.15)',
  '--md-sys-elevation-level5':
    '0px 4px 4px 0px rgba(0,0,0,0.3), 0px 8px 12px 6px rgba(0,0,0,0.15)',
};
