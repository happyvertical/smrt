import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rootsOf } from './component-roots.mjs';

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

test('slot content of a root-level child component is authored here and counts', () => {
  assert.deepEqual(tags('<Wrap><button></button></Wrap>'), ['button']);
});

test('a wrapper whose only child is a component has no root element', () => {
  assert.deepEqual(tags('<Modal bind:open {title} />'), []);
});

test('distinct elements in both branches are each a root', () => {
  assert.deepEqual(tags('{#if a}<i></i>{:else}<i></i>{/if}'), ['i', 'i']);
});
