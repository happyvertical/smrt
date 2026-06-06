#!/usr/bin/env node
/**
 * smrt-svelte design-token contract check.
 *
 * Diffs the `--smrt-*` CSS custom properties that smrt-svelte components
 * CONSUME (via `var(--smrt-...)`) against the ones the theme-delivery paths
 * actually EMIT. Fails CI on any token that is consumed but never emitted —
 * those tokens are frozen at their `var(..., fallback)` values and cannot be
 * themed across the material/glass/studio presets (see issue #1431).
 *
 * Emitted tokens are collected from every runtime delivery path:
 *   - static preset CSS: packages/smrt-svelte/src/themes/styles/*.css
 *   - JS theme generator: packages/smrt-svelte/src/themes/css-generator.ts
 *     (resolved structurally against the theme token scales)
 *   - simple ThemeProvider tokens: packages/smrt-svelte/src/theme/tokens.ts
 *   - workspace-shell tokens defined inline in component CSS (--smrt-ws-*)
 *
 * Consumed tokens are scraped from `var(--smrt-...)` references in any
 * .svelte / .ts / .css file under packages/smrt-svelte/src.
 *
 * Exit code: 0 if every consumed token is emitted, 1 otherwise.
 * Also verifies that each static preset stylesheet contains the token names
 * emitted by the JS preset generator for that preset.
 *
 * Run: `node scripts/check-svelte-tokens.mjs` or `pnpm check:svelte-tokens`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PKG = join(ROOT, 'packages', 'smrt-svelte');
const SRC = join(PKG, 'src');

/** Recursively list files under `dir` whose name ends in one of `exts`. */
function listFiles(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listFiles(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const VAR_RE = /var\(\s*(--smrt-[a-z0-9_-]+)/gi;

/** Collect every `--smrt-*` token referenced via var() under SRC. */
function collectConsumed() {
  const consumed = new Map(); // token -> count
  for (const file of listFiles(SRC, ['.svelte', '.ts', '.css'])) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(VAR_RE)) {
      consumed.set(m[1], (consumed.get(m[1]) ?? 0) + 1);
    }
  }
  return consumed;
}

const DEFINE_RE = /(--smrt-[a-z0-9_-]+)\s*:/gi;

/** Collect every `--smrt-*` token DEFINED (`--smrt-x: value`) in a CSS string. */
function collectDefinedInCss(text, into) {
  for (const m of text.matchAll(DEFINE_RE)) into.add(m[1]);
}

/**
 * The theme scale KEYS the generator iterates over. Mirrors
 * src/themes/types.ts (SpacingScale / TypographyScale / etc.) and
 * src/themes/shared.ts. Kept here so the check stays a pure string diff with
 * no module loading; src/themes/__tests__/css-generator.test.ts asserts the
 * generator output matches these keys so drift is caught by unit tests too.
 */
const SCALE_KEYS = {
  spacing: [
    '0', '0_5', '1', '1_5', '2', '2_5', '3', '3_5', '4', '5', '6', '7', '8',
    '9', '10', '11', '12', '14', '16', '20', '24',
    // additive Material-3 aliases (see shared.ts spacingAliases)
    'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl',
  ],
  radius: [
    'none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full',
    // additive Material-3 aliases (see shared.ts borderRadiusAliases)
    'extra-small', 'small', 'medium', 'large', 'extra-large',
  ],
  duration: [
    'instant', 'fast', 'normal', 'slow', 'slower',
    // additive Material-3 aliases (see shared.ts durationAliases)
    'short1', 'short2', 'short3', 'short4',
    'medium1', 'medium2', 'medium3', 'medium4',
    'long1', 'long2', 'long3', 'long4',
  ],
  easing: [
    'standard', 'standard-decelerate', 'standard-accelerate',
    'emphasized', 'emphasized-decelerate', 'emphasized-accelerate',
  ],
  elevation: ['0', '1', '2', '3', '4', '5'],
};

const TYPOGRAPHY_VARIANTS = [
  'display-large', 'display-medium', 'display-small',
  'headline-large', 'headline-medium', 'headline-small',
  'title-large', 'title-medium', 'title-small',
  'body-large', 'body-medium', 'body-small',
  'label-large', 'label-medium', 'label-small',
];

const TYPOGRAPHY_SUFFIXES = [
  'size', 'line-height', 'weight', 'tracking', 'font-family',
  // additive shorthand alias (see css-generator.ts)
  'font',
];

const BASE_COLOR_TOKENS = [
  'primary', 'on-primary', 'primary-container', 'on-primary-container',
  'secondary', 'on-secondary', 'secondary-container', 'on-secondary-container',
  'tertiary', 'on-tertiary', 'tertiary-container', 'on-tertiary-container',
  'error', 'on-error', 'error-container', 'on-error-container',
  'warning', 'on-warning', 'warning-container', 'on-warning-container',
  'success', 'on-success', 'success-container', 'on-success-container',
  'surface', 'on-surface', 'surface-variant', 'on-surface-variant',
  'surface-container', 'surface-container-low', 'surface-container-high',
  'surface-container-highest', 'surface-container-lowest',
  'surface-dim', 'surface-bright',
  'background', 'on-background',
  'outline', 'outline-variant',
  'inverse-surface', 'inverse-on-surface', 'inverse-primary',
  'shadow', 'scrim',
];

const GLASS_COLOR_TOKENS = [
  'glass-backdrop', 'glass-border',
];

const GLASS_EFFECT_TOKENS = [
  '--smrt-glass-blur',
  '--smrt-glass-saturation',
  '--smrt-glass-border-opacity',
  '--smrt-glass-background-opacity',
];

const FONT_WEIGHT_TOKEN_NAMES = ['normal', 'medium', 'semibold', 'bold'];

const Z_INDEX_TOKEN_NAMES = [
  'dropdown', 'sticky', 'overlay', 'modal', 'dialog', 'popover', 'toast',
  'tooltip',
];

/**
 * Tokens emitted by the JS theme generator (css-generator.ts) and the simple
 * ThemeProvider (theme/tokens.ts). These are not in static CSS but are still a
 * real runtime delivery path, so a consumed token they emit is themeable.
 */
function collectGeneratorEmitted(into) {
  for (const c of [...BASE_COLOR_TOKENS, ...GLASS_COLOR_TOKENS]) {
    into.add(`--smrt-color-${c}`);
  }
  into.add('--smrt-color-scheme');
  into.add('--smrt-theme-id');
  into.add('--smrt-theme-name');
  into.add('--smrt-font-family');
  for (const token of GLASS_EFFECT_TOKENS) into.add(token);
  for (const k of SCALE_KEYS.spacing) into.add(`--smrt-spacing-${k}`);
  for (const k of SCALE_KEYS.radius) into.add(`--smrt-radius-${k}`);
  for (const k of SCALE_KEYS.duration) into.add(`--smrt-duration-${k}`);
  for (const k of SCALE_KEYS.easing) into.add(`--smrt-easing-${k}`);
  for (const k of SCALE_KEYS.elevation) into.add(`--smrt-elevation-${k}`);
  for (const v of TYPOGRAPHY_VARIANTS) {
    for (const s of TYPOGRAPHY_SUFFIXES) {
      into.add(`--smrt-typography-${v}-${s}`);
    }
  }
  into.add('--smrt-font-family-mono');
  for (const name of FONT_WEIGHT_TOKEN_NAMES) {
    into.add(`--smrt-typography-weight-${name}`);
  }
  for (const name of Z_INDEX_TOKEN_NAMES) {
    into.add(`--smrt-z-index-${name}`);
  }
}

function collectPresetGeneratorTokens({ includeGlass = false } = {}) {
  const emitted = new Set();
  for (const c of BASE_COLOR_TOKENS) emitted.add(`--smrt-color-${c}`);
  if (includeGlass) {
    for (const c of GLASS_COLOR_TOKENS) emitted.add(`--smrt-color-${c}`);
  }
  emitted.add('--smrt-color-scheme');
  emitted.add('--smrt-theme-id');
  emitted.add('--smrt-theme-name');
  emitted.add('--smrt-font-family');
  if (includeGlass) {
    for (const token of GLASS_EFFECT_TOKENS) emitted.add(token);
  }
  for (const k of SCALE_KEYS.spacing) emitted.add(`--smrt-spacing-${k}`);
  for (const k of SCALE_KEYS.radius) emitted.add(`--smrt-radius-${k}`);
  for (const k of SCALE_KEYS.duration) emitted.add(`--smrt-duration-${k}`);
  for (const k of SCALE_KEYS.easing) emitted.add(`--smrt-easing-${k}`);
  for (const k of SCALE_KEYS.elevation) emitted.add(`--smrt-elevation-${k}`);
  for (const v of TYPOGRAPHY_VARIANTS) {
    for (const s of TYPOGRAPHY_SUFFIXES) {
      emitted.add(`--smrt-typography-${v}-${s}`);
    }
  }
  emitted.add('--smrt-font-family-mono');
  for (const name of FONT_WEIGHT_TOKEN_NAMES) {
    emitted.add(`--smrt-typography-weight-${name}`);
  }
  for (const name of Z_INDEX_TOKEN_NAMES) {
    emitted.add(`--smrt-z-index-${name}`);
  }
  return emitted;
}

function collectStaticPresetMissing() {
  const stylesDir = join(SRC, 'themes', 'styles');
  const presetFiles = {
    material: 'material.css',
    glass: 'glass.css',
    studio: 'studio.css',
  };
  const missingByPreset = [];

  for (const [preset, fileName] of Object.entries(presetFiles)) {
    const defined = new Set();
    collectDefinedInCss(readFileSync(join(stylesDir, fileName), 'utf8'), defined);
    const required = collectPresetGeneratorTokens({
      includeGlass: preset === 'glass',
    });
    const missing = [...required].filter((token) => !defined.has(token)).sort();
    if (missing.length > 0) missingByPreset.push({ preset, missing });
  }

  return missingByPreset;
}

/** Collect every emitted token across all delivery paths. */
function collectEmitted() {
  const emitted = new Set();

  // Static preset CSS files.
  const stylesDir = join(SRC, 'themes', 'styles');
  if (existsSync(stylesDir)) {
    for (const file of readdirSync(stylesDir)) {
      if (!file.endsWith('.css')) continue;
      collectDefinedInCss(readFileSync(join(stylesDir, file), 'utf8'), emitted);
    }
  }

  // Workspace-shell tokens defined inline in component CSS (e.g. --smrt-ws-*).
  for (const file of listFiles(SRC, ['.svelte', '.css'])) {
    collectDefinedInCss(readFileSync(file, 'utf8'), emitted);
  }

  // JS-generated tokens.
  collectGeneratorEmitted(emitted);

  return emitted;
}

const consumed = collectConsumed();
const emitted = collectEmitted();
const staticMissingByPreset = collectStaticPresetMissing();

const undefinedTokens = [...consumed.keys()]
  .filter((t) => !emitted.has(t))
  .sort();

if (undefinedTokens.length === 0 && staticMissingByPreset.length === 0) {
  console.log(
    `✓ svelte-token-check: ${consumed.size} consumed --smrt-* tokens, all emitted`,
  );
  process.exit(0);
}

if (undefinedTokens.length > 0) {
  console.error(
    `✗ svelte-token-check: ${undefinedTokens.length} consumed --smrt-* token(s) are never emitted\n`,
  );
  for (const t of undefinedTokens) {
    console.error(`    - ${t} (consumed ${consumed.get(t)}×)`);
  }
  console.error(
    '\nThese tokens are frozen at their var(..., fallback) values and cannot be\n' +
      'themed. Either emit them (extend src/themes/css-generator.ts + the static\n' +
      'preset CSS in src/themes/styles/*.css) or change the consumers to a token\n' +
      'that is emitted. See issue #1431.',
  );
}

if (staticMissingByPreset.length > 0) {
  console.error(
    `${undefinedTokens.length > 0 ? '\n' : ''}✗ svelte-token-check: static preset CSS is missing generated token(s)\n`,
  );
  for (const { preset, missing } of staticMissingByPreset) {
    console.error(`    ${preset}:`);
    for (const token of missing) console.error(`      - ${token}`);
  }
  console.error(
    '\nStatic preset CSS should expose the same token names as the JS preset\n' +
      'generator for that preset. Add missing definitions to\n' +
      'packages/smrt-svelte/src/themes/styles/*.css.',
  );
}

process.exit(1);
