// Default font family - can be overridden via --smrt-font-family CSS variable
const fontFamily = 'var(--smrt-font-family, Roboto, sans-serif)';

export const typographyTokens = {
  // Font family token for customization
  '--smrt-font-family': 'Roboto, sans-serif',

  '--smrt-typography-display-large-font': `400 57px/64px ${fontFamily}`,
  '--smrt-typography-display-medium-font': `400 45px/52px ${fontFamily}`,
  '--smrt-typography-display-small-font': `400 36px/44px ${fontFamily}`,

  '--smrt-typography-headline-large-font': `400 32px/40px ${fontFamily}`,
  '--smrt-typography-headline-medium-font': `400 28px/36px ${fontFamily}`,
  '--smrt-typography-headline-small-font': `400 24px/32px ${fontFamily}`,

  '--smrt-typography-title-large-font': `400 22px/28px ${fontFamily}`,
  '--smrt-typography-title-medium-font': `500 16px/24px ${fontFamily}`,
  '--smrt-typography-title-small-font': `500 14px/20px ${fontFamily}`,

  '--smrt-typography-label-large-font': `500 14px/20px ${fontFamily}`,
  '--smrt-typography-label-medium-font': `500 12px/16px ${fontFamily}`,
  '--smrt-typography-label-small-font': `500 11px/16px ${fontFamily}`,

  '--smrt-typography-body-large-font': `400 16px/24px ${fontFamily}`,
  '--smrt-typography-body-medium-font': `400 14px/20px ${fontFamily}`,
  '--smrt-typography-body-small-font': `400 12px/16px ${fontFamily}`,
};

// Simplified elevation using box-shadow
export const elevationTokens = {
  '--smrt-elevation-0': 'none',
  '--smrt-elevation-1':
    '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 1px 3px 1px rgba(0,0,0,0.15)',
  '--smrt-elevation-2':
    '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 2px 6px 2px rgba(0,0,0,0.15)',
  '--smrt-elevation-3':
    '0px 1px 3px 0px rgba(0,0,0,0.3), 0px 4px 8px 3px rgba(0,0,0,0.15)',
  '--smrt-elevation-4':
    '0px 2px 3px 0px rgba(0,0,0,0.3), 0px 6px 10px 4px rgba(0,0,0,0.15)',
  '--smrt-elevation-5':
    '0px 4px 4px 0px rgba(0,0,0,0.3), 0px 8px 12px 6px rgba(0,0,0,0.15)',
};
