/**
 * Forced-colors (Windows High Contrast) token overrides (#3908).
 *
 * The single source for the theme-level contract documented in
 * `themes/README.md` ("Forced colors"). `styles/base.css` carries the same
 * declarations for stylesheet-only delivery (under `@media (forced-colors:
 * active)` and `[data-forced-colors]`); `ThemeProvider` appends them to the
 * root inline style while forced colors are active so a runtime theme or an
 * inline `primaryColor` cannot paint over the system palette. A unit test keeps
 * the two copies in step.
 *
 * Values are system colour keywords or inert shadows. Elevations are
 * transparent shadows, never `none`, because components compose `box-shadow`
 * lists such as `var(--smrt-inset-highlight), var(--smrt-elevation-3)`.
 */
const INERT_SHADOW = '0 0 0 0 transparent';

export const FORCED_COLORS_TOKENS: Readonly<Record<string, string>> = {
  '--smrt-hairline-color': 'CanvasText',
  '--smrt-hairline-strong-color': 'CanvasText',
  '--smrt-hairline': '1px solid CanvasText',
  '--smrt-hairline-strong': '1px solid CanvasText',
  '--smrt-inset-highlight': 'inset 0 0 0 0 transparent',
  '--smrt-elevation-0': INERT_SHADOW,
  '--smrt-elevation-1': INERT_SHADOW,
  '--smrt-elevation-2': INERT_SHADOW,
  '--smrt-elevation-3': INERT_SHADOW,
  '--smrt-elevation-4': INERT_SHADOW,
  '--smrt-elevation-5': INERT_SHADOW,
  '--smrt-focus-ring-color': 'Highlight',
  '--smrt-focus-ring-width': '3px',
  '--smrt-focus-ring-offset': '2px',
  '--smrt-glass-blur': '0px',
  '--smrt-glass-saturation': '100%',
  '--smrt-glass-surface': 'Canvas',
  '--smrt-glass-surface-strong': 'Canvas',
  '--smrt-glass-border': 'CanvasText',
  '--smrt-surface-overlay': 'Canvas',
  '--smrt-state-hover': '0',
  '--smrt-state-pressed': '0',
  '--smrt-state-selected': '0',
  '--smrt-state-focus': '0',
  '--smrt-state-dragged': '0',
  '--smrt-accent-color': 'Highlight',
  '--smrt-caret-color': 'CanvasText',
  '--smrt-selection-background': 'Highlight',
  '--smrt-selection-color': 'HighlightText',
  '--smrt-scrollbar-thumb': 'CanvasText',
  '--smrt-scrollbar-track': 'Canvas',
};
