import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAll, exportedComponents, rootsOf } from './component-roots.mjs';

const tags = (source) => rootsOf(source).map((el) => el.name ?? 'svelte:element');

test('a single element is its own root', () => {
  assert.deepEqual(tags('<span class="x">a</span>'), ['span']);
});

test('every element in each if/else branch is a root', () => {
  assert.deepEqual(tags('{#if a}<a></a>{:else}<b></b>{/if}'), ['a', 'b']);
});

test('elements nested in another element are not roots', () => {
  assert.deepEqual(tags('<div><p></p></div>'), ['div']);
});

test('snippets are roots only when rendered from the root', () => {
  assert.deepEqual(tags('{#snippet s()}<b></b>{/snippet}<div>{@render s()}</div>'), ['div']);
  assert.deepEqual(tags('{#snippet s()}<b></b>{/snippet}{@render s()}'), ['b']);
});

test('slot content of a root-level child component is never a root', () => {
  assert.deepEqual(tags('<Wrap><button></button></Wrap>'), []);
  assert.deepEqual(tags('<Form>{#if error}<p></p>{/if}<Button /></Form>'), []);
  assert.deepEqual(tags('<svelte:component this={C}><p></p></svelte:component>'), []);
});

test('a transparent provider passes its slot content through as roots', () => {
  assert.deepEqual(tags('<FieldPolicyProvider>{#if a}<div></div>{/if}<Form><p></p></Form></FieldPolicyProvider>'), ['div']);
  assert.deepEqual(tags('<Provider><PermissionCheck><b></b></PermissionCheck></Provider>'), ['b']);
});

test('a real element root beside a child-component root is the only root', () => {
  assert.deepEqual(tags('<Wrap><button></button></Wrap><div></div>'), ['div']);
});

test('a wrapper whose only child is a component has no root element', () => {
  assert.deepEqual(tags('<Modal bind:open {title} />'), []);
});

test('distinct elements in both branches are each a root', () => {
  assert.deepEqual(tags('{#if a}<i></i>{:else}<i></i>{/if}'), ['i', 'i']);
});

// Model a fresh generator output without relying on ignored build artifacts.
test('real generated exports fail closed until their output carries the hook', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-roots-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'packages', 'fixture');
  mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ exports: { '.': './dist/index.js', './direct': './dist/Direct.svelte' } }));
  writeFileSync(join(pkg, 'src/index.ts'), `
    // export { default } from './Commented.svelte';
    /** export { default } from './Example.svelte'; */
    const example = "export { default } from './String.svelte'";
    export { default as Generated } from './Generated.svelte';
    export { store } from './product-store.svelte';
    import Aliased from './Aliased.svelte';
    export { Aliased as PublicName };
  `);
  writeFileSync(join(pkg, 'src/product-store.svelte.ts'), 'export const store = $state({});');
  writeFileSync(join(pkg, 'src/Aliased.svelte'), '<div data-smrt-component="Aliased"></div>');
  writeFileSync(join(pkg, 'src/Direct.svelte'), '<div data-smrt-component="Direct"></div>');
  assert.deepEqual([...exportedComponents(root).values()].sort(), ['Aliased', 'Direct', 'Generated']);
  assert.match(checkAll(root).find((r) => r.name === 'Generated').problems[0], /source is missing/);
  writeFileSync(join(pkg, 'src/Generated.svelte'), '{#if ready}<div></div>{:else}<p></p>{/if}');
  assert.equal(checkAll(root).find((r) => r.name === 'Generated').problems.length, 2);
  writeFileSync(join(pkg, 'src/Generated.svelte'), '{#if ready}<div data-smrt-component="Generated"></div>{:else}<p data-smrt-component="Generated"></p>{/if}');
  assert.ok(checkAll(root).every((r) => r.problems.length === 0));
});
