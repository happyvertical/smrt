import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wrapCssInLayer, unlayeredCssItems } from './cascade-layers-css.mjs';

const sample = `/* header */
@import "x.css";
[data-theme="a"][data-color-scheme="light"] {
  --smrt-color-primary: #123;
}
*, body { margin: 0; }
button { font: inherit; }
@font-face { font-family: f; src: url(x); }
[data-theme="a"] :focus-visible { outline: 2px solid red; }
`;

describe('CSS layer helpers (#3823)', () => {
  it('leaves imports, font-face and token-only blocks unlayered', () => {
    const items = unlayeredCssItems(sample).map((item) => item.text.trim());
    assert.equal(items.length, 3);
    assert.match(items[0], /^\*, body/);
    assert.match(items[1], /^button/);
    assert.match(items[2], /:focus-visible/);
  });

  it('wraps rule runs in smrt.theme and keeps exempt items outside', () => {
    const out = wrapCssInLayer(sample, 'theme');
    assert.match(out, /@layer smrt\.theme \{\n\*, body \{ margin: 0; \}\nbutton \{ font: inherit; \}\n\}/);
    assert.match(out, /\[data-theme="a"\] \{?/); // token block untouched
    assert.ok(out.includes('[data-theme="a"][data-color-scheme="light"] {\n  --smrt-color-primary: #123;\n}'));
    assert.ok(out.includes('@font-face { font-family: f; src: url(x); }'));
    assert.deepEqual(unlayeredCssItems(out), []);
  });

  it('is idempotent', () => {
    const once = wrapCssInLayer(sample, 'reset');
    assert.equal(wrapCssInLayer(once, 'reset'), once);
  });

  it('places base reset rules in smrt.reset when asked', () => {
    assert.match(wrapCssInLayer('body { margin: 0; }\n', 'reset'), /@layer smrt\.reset \{/);
  });
});
