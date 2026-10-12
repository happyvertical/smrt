/**
 * CSS stylesheet helpers for the smrt cascade-layer contract (#3823).
 *
 * Global stylesheets under `packages/*\/src/themes/styles` carry rules that
 * compete with component styles. Unlayered, they would beat every smrt layer
 * regardless of specificity. These helpers layer the rule-bearing items and
 * leave alone the parts that cannot compete for a cascade decision.
 */
import { isSmrtLayerItem, topLevelItems } from './cascade-layers-lib.mjs';

/**
 * An item is exempt from layering when it cannot compete for a cascade
 * decision: `@import`, `@charset`, `@font-face`, a statement, or a
 * declaration-only block that only defines custom properties (the generated
 * token blocks, which the lockstep test pins byte-for-byte).
 *
 * @param {{ text: string, statement: boolean }} item
 */
export function isLayerExemptCssItem(item) {
  const text = item.text.trim();
  if (/^@(import|charset|font-face)\b/.test(text)) return true;
  if (item.statement) return true;
  const open = text.indexOf('{');
  if (open === -1) return true;
  const body = text.slice(open + 1, text.lastIndexOf('}')).replace(/\/\*[\s\S]*?\*\//g, '');
  if (body.includes('{')) return false;
  const declarations = body
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  return declarations.length > 0 && declarations.every((declaration) => declaration.startsWith('--'));
}

/**
 * Top-level CSS items that still need an smrt layer.
 *
 * @param {string} css
 */
export function unlayeredCssItems(css) {
  return topLevelItems(css).filter((item) => !isLayerExemptCssItem(item) && !isSmrtLayerItem(item));
}

/**
 * Wrap each maximal run of adjacent layerable CSS items in one
 * `@layer smrt.<layer> { … }` block. Exempt items and existing smrt layers
 * break runs and stay byte-identical, so the function is idempotent.
 *
 * @param {string} css
 * @param {'reset'|'structure'|'theme'} layer
 */
export function wrapCssInLayer(css, layer) {
  const items = topLevelItems(css);
  let out = '';
  let cursor = 0;
  let run = null;

  const flush = () => {
    if (!run) return;
    out += css.slice(cursor, run.start);
    out += `@layer smrt.${layer} {\n${css.slice(run.start, run.end)}\n}`;
    cursor = run.end;
    run = null;
  };

  for (const item of items) {
    const layerable = !isLayerExemptCssItem(item) && !isSmrtLayerItem(item);
    if (layerable) {
      run = run ? { start: run.start, end: item.end } : { start: item.start, end: item.end };
    } else {
      flush();
    }
  }
  flush();
  out += css.slice(cursor);
  return out;
}
