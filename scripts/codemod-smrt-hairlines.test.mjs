import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codemodSource } from './codemod-smrt-hairlines.mjs';

const component = (css) => `<div></div><style>@layer smrt.theme { .edge { ${css} } }</style>`;

test('maps physical/logical solid edges and outline colors to quiet/strong tokens', () => {
  for (const property of ['border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-block', 'border-inline-start', 'border-block-end', 'outline']) {
    for (const [color, suffix] of [['outline-variant', ''], ['outline', '-strong']]) {
      const before = component(`${property}: 1px solid var(--smrt-color-${color}); ${property}-color: var(--smrt-color-${color});`);
      const result = codemodSource(before);
      assert.equal(result.source, component(`${property}: var(--smrt-hairline${suffix}); ${property}-color: var(--smrt-hairline${suffix}-color);`));
      assert.deepEqual(result.counts, { edges: 1, colors: 1, rings: 0 });
      assert.deepEqual(result.remaining, []);
      assert.equal(codemodSource(result.source).source, result.source);
    }
  }
});

test('removes obsolete theme fallbacks while retaining nested private overrides', () => {
  const result = codemodSource(component('border: var(--smrt-card-border, 1px solid var(--smrt-color-outline-variant, rgba(15, 23, 34, 0.08))); outline: 1px solid var(--smrt-color-outline, var(--smrt-color-primary));'));
  assert.equal(result.source, component('border: var(--smrt-card-border, var(--smrt-hairline)); outline: var(--smrt-hairline-strong);'));
});

test('converts only matching rings and preserves shadow list composition', () => {
  const result = codemodSource(component('box-shadow: inset 0 0 0 1px var(--smrt-color-outline-variant), 0 0 0 1px var(--smrt-color-outline), 0 0 0 1px var(--smrt-color-primary), var(--smrt-elevation-2);'));
  assert.equal(result.source, component('box-shadow: var(--smrt-inset-highlight), var(--smrt-inset-highlight), 0 0 0 1px var(--smrt-color-primary), var(--smrt-elevation-2);'));
  assert.equal(result.remaining.length, 1);
  assert.equal(codemodSource(result.source).changed, false);
});

test('keeps unsupported shapes, colors, comments and non-style content byte-identical', () => {
  const css = `border: 1px dashed var(--smrt-color-outline);
    border-top: 1px solid color-mix(in srgb, var(--smrt-color-outline) 50%, transparent);
    border-left: 1px solid var(--smrt-color-outline-custom);
    border-right: 1px solid var(--smrt-color-outline) red;
    outline: 2px solid var(--smrt-color-outline);
    width: 1px; height: 0px; background: var(--smrt-color-outline);
    content: 'border: 1px solid var(--smrt-color-outline)';
    /* border: 1px solid var(--smrt-color-outline); */`;
  const source = `<script>const example = 'border: 1px solid var(--smrt-color-outline)';</script><div style="border: 1px solid var(--smrt-color-outline)"></div>` + component(css);
  const result = codemodSource(source);
  assert.equal(result.source, source);
  assert.equal(result.changed, false);
  assert.equal(result.remaining.length, 7);
  assert.ok(result.remaining.every((item) => item.line >= 1));
});

test('accepts multiline edges without semicolons and leaves nested unrelated CSS alone', () => {
  const source = '<div/><style>@layer smrt.theme { @media (min-width: 1px) { .a { border:\n1px solid\nvar(--smrt-color-outline) } } }</style>';
  const result = codemodSource(source);
  assert.equal(result.source, source.replace('1px solid\nvar(--smrt-color-outline)', 'var(--smrt-hairline-strong)'));
  assert.equal(codemodSource(result.source).changed, false);
});
