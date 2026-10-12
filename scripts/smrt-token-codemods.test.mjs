/**
 * Behaviour pins for the #3826 styling codemods. Run by `pnpm test:ci-scripts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convertStyleBody, convertSvelte } from './codemod-smrt-px-tokens.mjs';
import { stripFallbacks } from './codemod-smrt-fallbacks.mjs';

const REQUIRED = new Set(['--smrt-spacing-4', '--smrt-color-primary', '--smrt-radius-sm']);

describe('codemod-smrt-fallbacks', () => {
  it('strips hex and px fallbacks for theme-required tokens', () => {
    const input = 'color: var(--smrt-color-primary, #1d4ed8); padding: var(--smrt-spacing-4, 16px);';
    const { text, count, kept } = stripFallbacks(input, REQUIRED);
    assert.equal(text, 'color: var(--smrt-color-primary); padding: var(--smrt-spacing-4);');
    assert.equal(count, 2);
    assert.equal(kept, 0);
  });

  it('keeps fallbacks for component-private and unknown tokens', () => {
    const input = 'min-height: var(--smrt-control-target-min, 30px);';
    const { text, count, kept } = stripFallbacks(input, REQUIRED);
    assert.equal(text, input);
    assert.equal(count, 0);
    assert.equal(kept, 1);
  });

  it('is idempotent', () => {
    const once = stripFallbacks('a: var(--smrt-radius-sm, 4px);', REQUIRED).text;
    assert.equal(stripFallbacks(once, REQUIRED).count, 0);
  });
});

describe('codemod-smrt-px-tokens', () => {
  it('maps spacing steps for padding, margin and gap, token by token', () => {
    const { css, count } = convertStyleBody('.a { padding: 8px 12px; gap: 16px; margin: 4px; }');
    assert.equal(
      css,
      '.a { padding: var(--smrt-spacing-2) var(--smrt-spacing-3); gap: var(--smrt-spacing-4); margin: var(--smrt-spacing-1); }',
    );
    assert.equal(count, 4);
  });

  it('maps only 4px and 9999px radii; other radius steps stay px', () => {
    const { css, count } = convertStyleBody('.a { border-radius: 4px; border-radius: 8px; border-radius: 9999px; }');
    assert.equal(
      css,
      '.a { border-radius: var(--smrt-radius-sm); border-radius: 8px; border-radius: var(--smrt-radius-full); }',
    );
    assert.equal(count, 2);
  });

  it('leaves non-spacing properties, negatives, hairlines and function values alone', () => {
    const input = '.a { width: 16px; border: 1px solid; margin: -4px; padding: calc(8px * 2); box-shadow: 0 4px 8px red; }';
    const { css, count } = convertStyleBody(input);
    assert.equal(css, input);
    assert.equal(count, 0);
  });

  it('only rewrites <style> blocks in .svelte sources', () => {
    const source = '<p style="padding: 8px">x</p>\n<style>\n  .a { padding: 8px; }\n</style>';
    const { text, count } = convertSvelte(source);
    assert.equal(text, '<p style="padding: 8px">x</p>\n<style>\n  .a { padding: var(--smrt-spacing-2); }\n</style>');
    assert.equal(count, 1);
  });

  it('is idempotent', () => {
    const once = convertStyleBody('.a { padding: 8px; }').css;
    assert.equal(convertStyleBody(once).count, 0);
  });
});
