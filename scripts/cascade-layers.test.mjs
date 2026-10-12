import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SMRT_CASCADE_LAYERS_DECLARATION,
  classifyStyleBody,
  extractStyleBlocks,
} from './cascade-layers-lib.mjs';
import { codemodSource } from './codemod-smrt-layers.mjs';
import { findViolations } from './check-smrt-cascade-layers.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const svelteRequire = createRequire(join(ROOT, 'packages/smrt-ui/package.json'));

const unlayered = (css) => `<div class="x"><span class="y">hi</span></div>\n<style>\n${css}\n</style>\n`;

describe('classifyStyleBody', () => {
  it('classifies empty, layered, unlayered and mixed bodies', () => {
    assert.equal(classifyStyleBody('').status, 'empty');
    assert.equal(classifyStyleBody('/* only a comment */').status, 'empty');
    assert.equal(classifyStyleBody('@layer smrt.theme { .a { color: red; } }').status, 'layered');
    assert.equal(classifyStyleBody('@layer smrt.reset, smrt.structure;').status, 'layered');
    assert.equal(classifyStyleBody('.a { color: red; }').status, 'unlayered');
    assert.equal(
      classifyStyleBody('@layer smrt.theme { .a { color: red; } } .b { color: blue; }').status,
      'mixed',
    );
  });

  it('ignores braces and semicolons inside strings and comments', () => {
    const css = '/* } ; */ .a::after { content: "}; {"; } ';
    assert.equal(classifyStyleBody(css).status, 'unlayered');
  });

  it('throws on an unclosed block', () => {
    assert.throws(() => classifyStyleBody('.a { color: red;'), /unclosed/);
  });

  it('treats a non-smrt @layer as unlayered', () => {
    assert.equal(classifyStyleBody('@layer vendor { .a { color: red; } }').status, 'unlayered');
  });
});

describe('codemodSource', () => {
  it('wraps an unlayered body in @layer smrt.theme', () => {
    const result = codemodSource(unlayered('.x { color: red; }'));
    assert.equal(result.changed, true);
    assert.deepEqual(result.problems, []);
    assert.match(result.source, /<style>\n@layer smrt\.theme \{\n\.x \{ color: red; \}\n\}\n<\/style>/);
  });

  it('is idempotent: a second run leaves the output byte-identical', () => {
    const first = codemodSource(unlayered('.x { color: red; }\n@media (min-width: 1px) { .x { margin: 0; } }'));
    const second = codemodSource(first.source);
    assert.equal(second.changed, false);
    assert.equal(second.source, first.source);
    assert.equal((first.source.match(/@layer smrt\.theme/g) ?? []).length, 1);
  });

  it('leaves files without a style block untouched', () => {
    const source = '<p>no style here</p>\n';
    const result = codemodSource(source);
    assert.equal(result.changed, false);
    assert.equal(result.source, source);
  });

  it('refuses a body with top-level @import and leaves it unchanged', () => {
    const source = unlayered('@import url("x.css");\n.x { color: red; }');
    const result = codemodSource(source);
    assert.equal(result.changed, false);
    assert.equal(result.source, source);
    assert.equal(result.problems.length, 1);
  });

  it('refuses a mixed body rather than nesting layers', () => {
    const source = unlayered('@layer smrt.theme { .a { color: red; } }\n.b { color: blue; }');
    const result = codemodSource(source);
    assert.equal(result.changed, false);
    assert.equal(result.problems.length, 1);
  });

  it('throws on an unclosed <style> block', () => {
    assert.throws(() => codemodSource('<p>x</p>\n<style>\n.a { color: red; }\n'), /unclosed <style>/);
  });

  it('rejects <style> attributes it cannot safely wrap', () => {
    assert.throws(() => extractStyleBlocks('<style lang="scss">.a{}</style>'), /attributes are not supported/);
  });
});

describe('findViolations (lint gate)', () => {
  it('passes a layered component', () => {
    const files = { 'a.svelte': codemodSource(unlayered('.x { color: red; }')).source };
    assert.deepEqual(findViolations(files), []);
  });

  it('fails an unlayered component', () => {
    const violations = findViolations({ 'a.svelte': unlayered('.x { color: red; }') });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /not inside @layer smrt/);
  });

  it('fails a mixed component', () => {
    const violations = findViolations({
      'b.svelte': unlayered('@layer smrt.theme { .a { color: red; } }\n.b { color: blue; }'),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /mixes/);
  });

  it('ignores svelte files without a style block', () => {
    assert.deepEqual(findViolations({ 'c.svelte': '<p>plain</p>\n' }), []);
  });
});

describe('layer declaration parity', () => {
  it('layers.css and layers.ts declare the same order', () => {
    const css = readFileSync(join(ROOT, 'packages/smrt-ui/src/styles/layers.css'), 'utf8');
    const tsSource = readFileSync(join(ROOT, 'packages/smrt-ui/src/styles/layers.ts'), 'utf8');
    assert.ok(css.includes(SMRT_CASCADE_LAYERS_DECLARATION));
    assert.ok(tsSource.includes(SMRT_CASCADE_LAYERS_DECLARATION));
  });
});

describe('svelte 5 compile of a wrapped component', () => {
  it('emits @layer smrt.theme with scoped selectors', () => {
    const { compile } = svelteRequire('svelte/compiler');
    const source = codemodSource(
      '<div class="x"><span class="y">hi</span></div>\n<style>\n.x { color: red; }\n.y { color: blue; }\n@media (min-width: 10px) { .x { margin: 0; } }\n:global(body) { margin: 0; }\n</style>\n',
    ).source;
    const out = compile(source, { filename: 'Probe.svelte', generate: 'client', css: 'external' });
    assert.match(out.css.code, /@layer smrt\.theme \{/);
    assert.match(out.css.code, /\.x\.svelte-[a-z0-9]+ \{ color: red; \}/);
    assert.match(out.css.code, /body \{ margin: 0; \}/);
  });
});
