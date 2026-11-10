/**
 * The planner's header controls, as SVG paths for smrt-ui's `Icon` (a filled
 * path in a 24x24 box, the same language as the shell's own icons).
 *
 * The chef's hat (a toque: three lobes over a crown and a band) is an
 * original drawing, so no outside licence applies; neither smrt-ui's presets
 * nor smrt-svelte's `SHELL_ICON_PATHS` have one. The export control uses
 * smrt-ui's `download` preset by name (`EXPORT_ICON`).
 */
export const CHEF_HAT_ICON =
  'M4 9.5a3.5 3.5 0 1 1 7 0a3.5 3.5 0 1 1-7 0zM13 9.5a3.5 3.5 0 1 1 7 0a3.5 3.5 0 1 1-7 0zM8 7a4 4 0 1 1 8 0a4 4 0 1 1-8 0zM6 9.5h12V15H6zM7 16.5h10a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-1.5a1 1 0 0 1 1-1z';

/** smrt-ui's preset icon for the export control. */
export const EXPORT_ICON = 'download';

/** Specs: a bulleted list of requirements. Original drawing. */
export const SPECS_ICON =
  'M4 5h3v3H4zM9 5.5h11v2H9zM4 10.5h3v3H4zM9 11h11v2H9zM4 16h3v3H4zM9 16.5h11v2H9z';

/** Features: three tiles and a round one, like pieces to add. Original drawing. */
export const FEATURES_ICON =
  'M4 4h7v7H4zM4 13h7v7H4zM13 13h7v7h-7zM16.5 3.5a4 4 0 1 1 0 8a4 4 0 1 1 0-8z';

/** Styles: a drop of colour. Original drawing. */
export const STYLES_ICON =
  'M12 2.5c3.5 4.2 6 7.4 6 10.5a6 6 0 0 1-12 0c0-3.1 2.5-6.3 6-10.5z';
