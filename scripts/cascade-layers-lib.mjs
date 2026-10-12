/**
 * Shared helpers for the smrt cascade-layer contract (#3823).
 *
 * Every component `<style>` block in `packages/*\/src` must have its top-level
 * rules inside `@layer smrt.<name> { … }`. The codemod wraps unlayered bodies
 * and the lint gate fails anything else. Both use the same top-level scanner so
 * they agree on what "layered" means.
 */

export const SMRT_LAYER_NAMES = ['reset', 'structure', 'theme'];
export const SMRT_LAYER_ORDER = SMRT_LAYER_NAMES.map((name) => `smrt.${name}`);
export const SMRT_CASCADE_LAYERS_DECLARATION = `@layer ${SMRT_LAYER_ORDER.join(', ')};`;

const SMRT_LAYER_NAME_RE = /^smrt\.(reset|structure|theme)$/;

/**
 * Split a CSS source into top-level items. Each item is a statement
 * (`…;`) or a block (`… { … }`) with its source text and offsets.
 * Comments and strings are skipped correctly. Throws on unclosed blocks.
 *
 * @param {string} css
 * @returns {{ text: string, start: number, end: number, statement: boolean }[]}
 */
export function topLevelItems(css) {
  const items = [];
  const n = css.length;
  let i = 0;

  while (i < n) {
    // skip whitespace and top-level comments
    if (/\s/.test(css[i])) {
      i++;
      continue;
    }
    if (css.startsWith('/*', i)) {
      const close = css.indexOf('*/', i + 2);
      if (close === -1) throw new Error('unclosed comment in <style> body');
      i = close + 2;
      continue;
    }

    const start = i;
    let depth = 0;
    let statement = false;
    let closed = false;

    while (i < n) {
      const ch = css[i];
      if (css.startsWith('/*', i)) {
        const close = css.indexOf('*/', i + 2);
        if (close === -1) throw new Error('unclosed comment in <style> body');
        i = close + 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = skipString(css, i);
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          i++;
          closed = true;
          break;
        }
      } else if (ch === ';' && depth === 0) {
        i++;
        statement = true;
        closed = true;
        break;
      }
      i++;
    }

    if (!closed) throw new Error('unclosed rule or block in <style> body');
    items.push({ text: css.slice(start, i), start, end: i, statement });
  }

  return items;
}

function skipString(css, i) {
  const quote = css[i];
  let j = i + 1;
  while (j < css.length) {
    if (css[j] === '\\') {
      j += 2;
      continue;
    }
    if (css[j] === quote) return j + 1;
    j++;
  }
  throw new Error('unclosed string in <style> body');
}

/**
 * True when an item is a smrt-layer block (`@layer smrt.x { … }`) or a
 * smrt-layer declaration statement (`@layer smrt.a, smrt.b;`).
 *
 * @param {{ text: string, statement: boolean }} item
 */
export function isSmrtLayerItem(item) {
  const match = /^@layer\s+([^{;]+?)\s*(\{[\s\S]*\}|;)$/.exec(item.text.trim());
  if (!match) return false;
  const names = match[1].split(',').map((name) => name.trim());
  return names.every((name) => SMRT_LAYER_NAME_RE.test(name));
}

/**
 * Classify a `<style>` body.
 * - `empty`: no rules or only comments
 * - `layered`: every top-level item is an smrt layer block or declaration
 * - `unlayered`: no top-level item is an smrt layer
 * - `mixed`: some items are smrt layers and some are not (must be fixed by hand)
 *
 * @param {string} css
 * @returns {{ status: 'empty'|'layered'|'unlayered'|'mixed', items: ReturnType<typeof topLevelItems> }}
 */
export function classifyStyleBody(css) {
  const items = topLevelItems(css);
  if (items.length === 0) return { status: 'empty', items };
  const layered = items.filter(isSmrtLayerItem).length;
  if (layered === items.length) return { status: 'layered', items };
  if (layered === 0) return { status: 'unlayered', items };
  return { status: 'mixed', items };
}

/**
 * Top-level `@import` or `@charset` cannot live inside a layer block, so an
 * unlayered body containing one is refused instead of wrapped.
 *
 * @param {ReturnType<typeof topLevelItems>} items
 */
export function hasLayerIncompatibleItem(items) {
  return items.some((item) => /^@(import|charset)\b/.test(item.text.trim()));
}

/**
 * Wrap an unlayered body in `@layer smrt.theme { … }`. Idempotency is the
 * caller's job (only call this for `unlayered` bodies).
 *
 * @param {string} css
 */
export function wrapInThemeLayer(css) {
  const inner = css.replace(/^\s*\n/, '').replace(/\s+$/, '');
  return `\n@layer smrt.theme {\n${inner}\n}\n`;
}

/**
 * Extract every plain `<style>` block from a `.svelte` source.
 * Returns the body and its offsets inside the source. Throws if a `<style`
 * opening tag is not the plain `<style>` form or is unclosed.
 *
 * @param {string} source
 * @returns {{ body: string, bodyStart: number, bodyEnd: number }[]}
 */
export function extractStyleBlocks(source) {
  const blocks = [];
  const openRe = /<style(\s[^>]*)?>/g;
  let match;
  while ((match = openRe.exec(source)) !== null) {
    if (match[1] !== undefined) {
      throw new Error(`<style ${match[1].trim()}> attributes are not supported by the cascade-layer contract`);
    }
    const bodyStart = match.index + match[0].length;
    const close = source.indexOf('</style>', bodyStart);
    if (close === -1) throw new Error('unclosed <style> block');
    blocks.push({ body: source.slice(bodyStart, close), bodyStart, bodyEnd: close });
    openRe.lastIndex = close + '</style>'.length;
  }
  return blocks;
}
