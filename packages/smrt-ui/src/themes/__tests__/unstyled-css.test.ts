/**
 * Styleless mode contract (#3825): `styles/unstyled.css` reverts the look of
 * smrt components back to the structure layer and keeps their layout.
 *
 * jsdom does not evaluate `@layer` or `revert-layer` in computed style, so
 * this test asserts the declared contract: a layered component's compiled CSS,
 * the revert rule's target and declarations, and its specificity boost. The
 * computed-value reversal itself is asserted in Chromium by
 * `e2e/styleless.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { afterEach, describe, expect, it } from 'vitest';

const UNSTYLED_CSS = readFileSync(
  resolve(process.cwd(), 'src/styles/unstyled.css'),
  'utf8',
);
const BUTTON_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/components/ui/Button.svelte'),
  'utf8',
);

// CSSOM exposes an empty `cssRules` on style rules too, so keep each rule and
// recurse into whatever it carries (layer blocks, media rules, and so on).
function flatten(list: CSSRuleList | undefined): CSSRule[] {
  return Array.from(list ?? []).flatMap((rule) => [
    rule,
    ...flatten((rule as Partial<CSSGroupingRule>).cssRules),
  ]);
}

function insertCss(id: string, css: string): CSSRule[] {
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
  return flatten(style.sheet?.cssRules);
}

function styleRules(rules: CSSRule[]): CSSStyleRule[] {
  return rules.filter((rule): rule is CSSStyleRule => 'selectorText' in rule);
}

// The one rule that reverts the look: its selector carries the `#\#` boost.
function findRevertRule(rules: CSSRule[]): CSSStyleRule {
  const rule = styleRules(rules).find((candidate) =>
    candidate.selectorText.includes('not(#\\#)'),
  );
  if (!rule) throw new Error('unstyled.css revert rule not found');
  return rule;
}

const REVERTED = [
  'background',
  'border',
  'border-radius',
  'box-shadow',
  'color',
  'font',
  'outline',
  'filter',
];
const KEPT = [
  'display',
  'gap',
  'padding',
  'position',
  'width',
  'grid-template-columns',
];

describe('smrt styleless mode (unstyled.css)', () => {
  afterEach(() => {
    document.querySelectorAll('style[id^="unstyled-test-"]').forEach((node) => {
      node.remove();
    });
  });

  it('a pilot component compiles both structure and theme layers', () => {
    const out = compile(BUTTON_SOURCE, {
      filename: resolve(process.cwd(), 'src/components/ui/Button.svelte'),
      generate: 'client',
      css: 'external',
    });
    const rules = insertCss('unstyled-test-button', out.css?.code ?? '');
    const themed = styleRules(rules);
    expect(themed.length).toBeGreaterThan(0);
    expect(out.css?.code).toMatch(/@layer smrt\.structure\s*\{/);
    expect(out.css?.code).toMatch(/@layer smrt\.theme\s*\{/);
    // Both layout and look survive compilation; Chromium asserts reversal.
    const declared = themed.flatMap((rule) =>
      Array.from({ length: rule.style.length }, (_, i) => rule.style.item(i)),
    );
    expect(declared).toEqual(expect.arrayContaining(['display', 'background']));
  });

  it('the revert rule targets themed properties, not layout', () => {
    const rule = findRevertRule(
      insertCss('unstyled-test-revert', UNSTYLED_CSS),
    );

    for (const property of REVERTED) {
      expect(rule.style.getPropertyValue(property)).toBe('revert-layer');
    }
    for (const property of KEPT) {
      expect(rule.style.getPropertyValue(property)).toBe('');
    }
  });

  it('the revert rule sits in smrt.theme and carries the specificity boost', () => {
    // CSSOM's layer-block modelling varies, so assert the source placement:
    // the revert declarations must live inside the `smrt.theme` block.
    const themeBlock = UNSTYLED_CSS.slice(
      UNSTYLED_CSS.indexOf('@layer smrt.theme {'),
    );
    expect(themeBlock).toContain('revert-layer');
    expect(themeBlock.indexOf('revert-layer')).toBeGreaterThan(0);

    const rules = insertCss('unstyled-test-layers', UNSTYLED_CSS);
    const selector = findRevertRule(rules).selectorText;
    expect((selector.match(/:not\(#\\#\)/g) ?? []).length).toBe(3);
  });

  it('the reset keeps the UA form-control chrome out of component trees', () => {
    const rules = insertCss('unstyled-test-reset', UNSTYLED_CSS);
    const reset = styleRules(rules).find((rule) =>
      rule.selectorText.includes('button'),
    );
    expect(reset).toBeDefined();
    // CSSOM may normalise the zero length to `0px`.
    expect(reset?.style.getPropertyValue('border')).toMatch(/^0(px)?$/);
    expect(reset?.style.getPropertyValue('background')).toBe('transparent');
  });

  it('matches component roots and their descendants only', () => {
    const rules = insertCss('unstyled-test-match', UNSTYLED_CSS);
    const rule = findRevertRule(rules);
    const root = document.createElement('div');
    root.setAttribute('data-smrt-component', 'Card');
    const child = document.createElement('span');
    root.appendChild(child);
    const outside = document.createElement('div');
    document.body.append(root, outside);

    expect(root.matches(rule.selectorText)).toBe(true);
    expect(child.matches(rule.selectorText)).toBe(true);
    expect(outside.matches(rule.selectorText)).toBe(false);
    root.remove();
    outside.remove();
  });
});
