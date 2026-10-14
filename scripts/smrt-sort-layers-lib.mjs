/** Shared, conservative property classifier and Svelte AST helpers (#3917). */
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { allPackageSrcDirs, listFiles, ROOT } from './smrt-token-scan-lib.mjs';

const { parse } = createRequire(join(ROOT, 'packages/smrt-ui/package.json'))('svelte/compiler');
export { ROOT };
export const TODO_MARKER = 'smrt-sort-todo:';

const STRUCTURE = new Set(`display position top right bottom left z-index float clear
box-sizing width height min-width max-width min-height max-height inline-size block-size
min-inline-size max-inline-size min-block-size max-block-size aspect-ratio
gap row-gap column-gap order align-content align-items align-self justify-content
justify-items justify-self place-content place-items place-self overflow overflow-x
overflow-y overflow-block overflow-inline overflow-clip-margin clip clip-path
white-space white-space-collapse text-wrap text-wrap-mode text-wrap-style
overflow-wrap word-wrap word-break text-overflow hyphens line-clamp -webkit-line-clamp
cursor pointer-events touch-action user-select resize object-fit object-position
contain container container-name container-type isolation list-style list-style-type
list-style-position list-style-image`.split(/\s+/));
const THEME = new Set(`color accent-color caret-color color-scheme print-color-adjust
forced-color-adjust box-shadow text-shadow line-height letter-spacing word-spacing
text-align text-indent text-transform text-rendering vertical-align appearance
filter backdrop-filter fill fill-opacity fill-rule stroke stroke-width stroke-opacity
stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset scrollbar-color
scrollbar-width`.split(/\s+/));
const ROLE = new Set(['opacity', 'visibility', 'content', 'transform', 'transform-origin',
  'transform-style', 'translate', 'rotate', 'scale', 'perspective', 'perspective-origin']);

// Enumerate actual longhands: an unfamiliar suffix must not inherit a guessed
// classification merely because it starts with "font-" or "grid-".
function family(set, prefix, suffixes) {
  set.add(prefix);
  for (const suffix of suffixes.split(/\s+/).filter(Boolean)) set.add(`${prefix}-${suffix}`);
}
family(STRUCTURE, 'flex', 'basis direction flow grow shrink wrap');
family(STRUCTURE, 'grid', 'area auto-columns auto-flow auto-rows column column-start column-end row row-start row-end template template-areas template-columns template-rows');
const sides = 'top right bottom left block block-start block-end inline inline-start inline-end';
for (const property of ['padding', 'margin', 'scroll-margin', 'scroll-padding']) family(STRUCTURE, property, sides);
family(STRUCTURE, 'inset', 'block block-start block-end inline inline-start inline-end');
family(STRUCTURE, 'overscroll-behavior', 'x y block inline');
family(THEME, 'background', 'attachment blend-mode clip color image origin position position-x position-y repeat size');
family(THEME, 'border', 'collapse spacing width style color radius image image-source image-slice image-width image-outset image-repeat');
for (const side of sides.split(' ')) family(THEME, `border-${side}`, 'width style color');
for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'start-start', 'start-end', 'end-start', 'end-end']) THEME.add(`border-${corner}-radius`);
family(THEME, 'outline', 'color offset style width');
family(THEME, 'font', 'family feature-settings kerning language-override optical-sizing palette size size-adjust stretch style synthesis synthesis-position synthesis-small-caps synthesis-style synthesis-weight variant variant-alternates variant-caps variant-east-asian variant-emoji variant-ligatures variant-numeric variant-position variation-settings weight');
family(THEME, 'text-decoration', 'color line skip-ink style thickness');
family(THEME, 'text-emphasis', 'color position style');
family(THEME, 'transition', 'behavior delay duration property timing-function');
family(THEME, 'animation', 'composition delay direction duration fill-mode iteration-count name play-state range range-start range-end timeline timing-function');
family(THEME, 'mask', 'clip composite image mode origin position repeat size type');

/** Unknown/custom properties deliberately need human judgment, not a theme default. */
export function classifyProperty(property) {
  const p = property.toLowerCase().replace(/^-(?:webkit|moz|ms|o)-/, '');
  if (ROLE.has(p)) return 'role';
  if (STRUCTURE.has(p)) return 'structure';
  if (THEME.has(p)) return 'theme';
  return 'unknown';
}

export function parseComponent(source) {
  const ast = parse(source, { modern: true });
  if (ast.css?.attributes.length) throw new Error('<style> attributes require manual sorting');
  return ast;
}

export function componentFiles(packageNames = []) {
  const names = packageNames.map((name) => name.replace(/^@happyvertical\//, ''));
  const dirs = allPackageSrcDirs();
  for (const name of names) {
    if (!dirs.some(({ pkg }) => pkg === name)) throw new Error(`Unknown package: ${name}`);
  }
  return dirs.filter(({ pkg }) => !names.length || names.includes(pkg))
    .flatMap(({ dir }) => listFiles(dir, ['.svelte'])).sort();
}

export function relativeFile(file) { return relative(ROOT, file).replaceAll('\\', '/'); }

/** Visit declarations with their enclosing layer, selectors and conditional wrappers. */
export function walkCss(node, callback, context = { layer: '', path: [], keyframes: false }) {
  if (!node) return;
  let next = context;
  if (node.type === 'Atrule') {
    if (node.name === 'layer' && node.block) {
      const layer = context.layer ? `${context.layer}.${node.prelude.trim()}` : node.prelude.trim();
      next = { ...context, layer };
    } else if (node.block) {
      next = { ...context, path: [...context.path, `@${node.name} ${node.prelude}`],
        keyframes: context.keyframes || /^(?:-webkit-)?keyframes$/.test(node.name) };
    }
  } else if (node.type === 'Rule') {
    next = { ...context, path: [...context.path, node.prelude] };
  }
  callback(node, next);
  for (const child of node.children ?? []) walkCss(child, callback, next);
  if (node.block) walkCss(node.block, callback, next);
}

export function hasStructure(css) {
  let found = false;
  walkCss(css, (node, context) => {
    if (node.type === 'Atrule' && node.block && context.layer === 'smrt.structure') found = true;
  });
  return found;
}

/** Distinct owned class names, not selector occurrences or consumer :global() classes. */
export function internalClasses(ast) {
  const names = new Set();
  function selectors(node, global = false) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'PseudoClassSelector' && node.name === 'global') return;
    if (node.type === 'ClassSelector' && !global) names.add(node.name);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) for (const item of child) selectors(item, global);
      else if (child && typeof child === 'object') selectors(child, global);
    }
  }
  function css(node, global = false) {
    if (!node) return;
    // Svelte's block form :global { ... } also has no owned selectors inside.
    if (node.type === 'Rule') {
      const globalBlock = node.prelude.children?.every((complex) => complex.children?.every(
        (relative) => relative.selectors?.every((s) => s.type === 'PseudoClassSelector' && s.name === 'global' && !s.args)));
      global ||= globalBlock;
      if (!global) selectors(node.prelude);
    }
    for (const child of node.children ?? []) css(child, global);
    if (node.block) css(node.block, global);
  }
  css(ast.css);
  function markup(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'RegularElement' || node.type === 'SvelteElement') {
      for (const attribute of node.attributes ?? []) {
        if (attribute.type === 'ClassDirective') names.add(attribute.name);
        if (attribute.type === 'Attribute' && attribute.name === 'class' && Array.isArray(attribute.value)
          && attribute.value.every((part) => part.type === 'Text')) {
          for (const name of attribute.value.map((part) => part.data).join('').split(/\s+/).filter(Boolean)) names.add(name);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'attributes') continue;
      if (Array.isArray(child)) for (const item of child) markup(item);
      else if (child && typeof child === 'object') markup(child);
    }
  }
  markup(ast.fragment);
  return [...names].filter((name) => !/^smrt-[a-z0-9]+(?:-[a-z0-9]+)*__[a-z0-9][a-z0-9_-]*$/.test(name)).sort();
}

export function layerViolations(source, ast = parseComponent(source)) {
  const errors = [];
  if (!hasStructure(ast.css)) return errors;
  walkCss(ast.css, (node, context) => {
    if (node.type !== 'Declaration' || context.keyframes) return;
    const category = classifyProperty(node.property);
    const expected = category === 'structure' || category === 'theme' ? `smrt.${category}` : null;
    if (expected && ['smrt.structure', 'smrt.theme'].includes(context.layer) && context.layer !== expected) {
      errors.push(`line ${source.slice(0, node.start).split('\n').length}: ${node.property} belongs in ${expected}, found ${context.layer}`);
    }
  });
  return errors;
}

export function declarationRecords(source) {
  const records = [];
  walkCss(parseComponent(source).css, (node, context) => {
    if (node.type === 'Declaration') records.push({
      layer: context.layer,
      path: context.path.map((part) => typeof part === 'string' ? part : source.slice(part.start, part.end)),
      property: node.property, value: node.value, line: source.slice(0, node.start).split('\n').length,
    });
  });
  return records;
}
