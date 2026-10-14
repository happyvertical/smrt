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
