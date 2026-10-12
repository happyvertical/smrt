/**
 * Cascade-layer declaration for smrt components (#3823).
 *
 * `ThemeProvider` injects this into `<head>` so the layer order exists before
 * any layered component rule. The same declaration ships as `layers.css`
 * (`@happyvertical/smrt-ui/styles/layers.css`). A test keeps the two in sync.
 */
export const SMRT_CASCADE_LAYERS_CSS =
  '@layer smrt.reset, smrt.structure, smrt.theme;';
