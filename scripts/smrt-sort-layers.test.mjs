import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareRatchet, inspectFiles } from './check-smrt-sort-layers.mjs';
import { codemodSource } from './codemod-smrt-sort-layers.mjs';
import { comparePilot, normalizeRecord } from './compare-smrt-sort-pilot.mjs';
import { declarationRecords, internalClasses, layerViolations, parseComponent, ROOT } from './smrt-sort-layers-lib.mjs';

const source = (css) => `<div class="thing"/><style>@layer smrt.reset, smrt.structure, smrt.theme;${css}</style>`;
const unsorted = (css) => source(`@layer smrt.theme {${css}}`);
const sorted = (structure, theme) => source(`@layer smrt.structure {${structure}} @layer smrt.theme {${theme}}`);
const paths = ['ui/Button', 'ui/Badge', 'ui/Chip', 'ui/Card', 'feedback/Alert',
  'forms/Input', 'forms/Select', 'forms/Checkbox', 'forms/Switch', 'nav/Tabs'];

for (const path of paths) test(`hand-sorted pilot ${path} passes without edits`, () => {
  const original = readFileSync(join(ROOT, `packages/smrt-ui/src/components/${path}.svelte`), 'utf8');
  assert.deepEqual(layerViolations(original), []);
  assert.deepEqual(inspectFiles({ pilot: original }).snapshot.files, {});
  assert.equal(codemodSource(original).source, original);
});

test('layout in theme and paint in structure fail through nested conditions', () => {
  assert.match(layerViolations(sorted('', '@media (width > 2px) { @supports (display:grid) {.thing {display:flex}}}'))[0], /display belongs in smrt.structure/);
  for (const prop of ['color', 'border-width', 'background-size', 'font-size', 'animation', 'outline-offset']) {
    assert.match(layerViolations(sorted(`.thing {${prop}:initial}`, ''))[0], /belongs in smrt.theme/);
  }
  assert.deepEqual(layerViolations(sorted('.thing {opacity:0;transform:scale(1);visibility:hidden;content:"x"}', '.thing {opacity:.5;transform:none;visibility:visible;content:"y"}')), []);
  assert.deepEqual(layerViolations(unsorted('.thing {display:flex}')), []);
  assert.match(layerViolations(source('@layer smrt { @layer structure {} @layer theme {.thing{padding:0}} }'))[0], /padding/);
});

test('ratchet reports exact debt, stale shrink/deletion, sorted regression and growth', () => {
  const old = inspectFiles({ a: unsorted('.thing {display:flex}'), b: sorted('', '') }).snapshot;
  assert.deepEqual(compareRatchet(old, old), []);
  const shrink = { version: 1, files: {} };
  assert.match(compareRatchet(shrink, old).join('\n'), /stale/);
  assert.deepEqual(compareRatchet(shrink, old, { write: true }), []);
  for (const write of [true, false]) {
    assert.match(compareRatchet(old, shrink, { write }).join('\n'), /regressed/);
    assert.match(compareRatchet(old, shrink, { write }).join('\n'), /grew/);
  }
  assert.match(compareRatchet(old, { version: 2 }).join(), /schema/);
});

test('named, anonymous and dotted sublayers inherit structure/theme placement enforcement', () => {
  for (const child of ['overrides', '']) {
    assert.match(layerViolations(sorted('', `@layer ${child} {.thing{display:flex}}`))[0], /display belongs in smrt.structure/);
    assert.match(layerViolations(sorted(`@layer ${child} {.thing{color:red}}`, ''))[0], /color belongs in smrt.theme/);
    assert.deepEqual(layerViolations(sorted(`@layer ${child} {.thing{display:flex}}`, `@layer ${child} {.thing{color:red}}`)), []);
  }
  assert.match(layerViolations(source('@layer smrt.structure.controls {} @layer smrt.theme.colors {.thing{padding:0}}'))[0], /padding belongs in smrt.structure/);
  assert.match(layerViolations(source('@layer smrt.structure.controls {.thing{color:red}}'))[0], /color belongs in smrt.theme/);
});

test('classes count distinct local CSS/static markup/directives but not global or child props', () => {
  const ast = parseComponent(`<div class="unused smrt-thing__root" class:active={true}/><Child class="consumer"/>
    <style>.thing, .thing:hover, :global(.third-party) .local:is(.other) {color:red} :global {.external {color:red}}</style>`);
  assert.deepEqual(internalClasses(ast), ['active', 'local', 'other', 'thing', 'unused']);
  // A script string mentioning style markup is not a component style block.
  assert.deepEqual(inspectFiles({ x: '<script>const x = "<style>.x{color:red}</style>";</script><div/>' }).snapshot.files, {});
});

test('split preserves declaration values, selector order, nesting, scoping, comments, and markup', () => {
  const input = unsorted(`/* keep */ .thing:global(.external), .thing:hover { display:flex; color:red; display:grid; }
    @media (width > 2px) { @supports (display:grid) { .thing {padding:1rem;background:url("data:image/svg+xml;a:b{c}")} } }
    @media (forced-colors:active) {.thing {color:CanvasText;outline:2px solid Highlight}}
    .thing { &:hover {margin:0;color:blue} }`);
  const result = codemodSource(input);
  assert.equal(result.todos.length, 0);
  assert.match(result.source, /\/\* keep \*\//);
  assert.equal(result.source.slice(0, result.source.indexOf('<style>')), input.slice(0, input.indexOf('<style>')));
  const before = declarationRecords(input).map(({ layer, line, ...record }) => JSON.stringify(record)).sort();
  const after = declarationRecords(result.source).map(({ layer, line, ...record }) => JSON.stringify(record)).sort();
  assert.deepEqual(after, before);
  assert.deepEqual(declarationRecords(result.source).filter((r) => r.property === 'display').map((r) => r.value), ['flex', 'grid']);
  assert.deepEqual(layerViolations(result.source), []);
  assert.equal(codemodSource(result.source).source, result.source);
});

test('keyframes remain with theme animation including role and geometry declarations', () => {
  const result = codemodSource(unsorted('.thing{animation:spin 1s;display:block}@keyframes spin{to{transform:rotate(1turn);width:10px;opacity:0}}'));
  assert.deepEqual(result.todos, []);
  const records = declarationRecords(result.source);
  assert.ok(records.filter((r) => r.path.some((p) => p.startsWith('@keyframes'))).every((r) => r.layer === 'smrt.theme'));
  assert.deepEqual(layerViolations(result.source), []);
});

test('role-dependent and unknown declarations stay intact, reported, repeatable, and gate-blocking', () => {
  const input = unsorted('.thing {display:flex; opacity:.5;transform:none;visibility:hidden;content:";{}";pointer-events:none;--private:1;future-property:foo}');
  const result = codemodSource(input);
  assert.equal(result.todos.length, 7);
  assert.deepEqual(result.todos.map((t) => t.property), ['opacity', 'transform', 'visibility', 'content', 'pointer-events', '--private', 'future-property']);
  assert.deepEqual(codemodSource(result.source), { ...result, changed: false });
  assert.match(inspectFiles({ x: result.source }).errors.join(), /unresolved/);
  for (const todo of result.todos) assert.ok(todo.path.includes('.thing'));
});

test('unknown at-rules and parse errors are never silently dropped or accepted', () => {
  assert.equal(codemodSource(unsorted('.thing{font-future:foo;grid-future:bar}')).todos.length, 2);
  const input = unsorted('@future x {.thing{color:red}}');
  const result = codemodSource(input);
  assert.equal(result.todos.length, 1);
  assert.match(result.source, /@future x/);
  for (const bad of [source('.thing{color:'), '<div/><style lang="scss">$x: red;</style>']) {
    const result = codemodSource(bad);
    assert.equal(result.source, bad);
    assert.equal(result.changed, false);
    assert.equal(result.todos.length, 1);
    assert.ok(inspectFiles({ bad }).errors.length);
  }
});

test('repeated theme blocks, resets, final semicolon omission and comments survive', () => {
  const input = source('@layer smrt.theme{.thing{padding:1px;color:red /* inline */}} /* between */ @layer smrt.reset{.thing{all:unset}} @layer smrt.theme{.thing{padding:2px;color:blue}}');
  const result = codemodSource(input);
  assert.deepEqual(result.todos, []);
  assert.match(result.source, /@layer smrt.reset\{.thing\{all:unset\}\}/);
  assert.match(result.source, /between/);
  assert.match(result.source, /inline/);
  assert.deepEqual(declarationRecords(result.source).filter((r) => r.property === 'padding').map((r) => r.value), ['1px', '2px']);
});

test('CLI check/write/report are scoped, idempotent, and validate input before mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smrt-sort-test-'));
  const cli = join(ROOT, 'scripts/codemod-smrt-sort-layers.mjs');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: ROOT });
  try {
    const file = join(dir, 'Thing.svelte');
    const report = join(dir, 'report.json');
    const input = unsorted('.thing{display:flex;color:red}');
    writeFileSync(file, input);
    assert.equal(run(['--check', '--file', file, '--report', report]).status, 1);
    assert.equal(readFileSync(file, 'utf8'), input);
    assert.equal(JSON.parse(readFileSync(report)).files.length, 1);
    assert.equal(run(['--write', file, '--file', join(dir, 'Missing.svelte')]).status, 1);
    assert.equal(readFileSync(file, 'utf8'), input);
    assert.equal(run(['--write', file]).status, 0);
    const output = readFileSync(file, 'utf8');
    assert.equal(run(['--write', file]).status, 0);
    assert.equal(readFileSync(file, 'utf8'), output);
    assert.equal(run(['--check', file]).status, 0);
    for (const args of [[], ['--write'], ['--file'], ['--nope'], ['--check', '--write', file], ['--package', 'missing'], ['--write', file, '--report', file]]) assert.equal(run(args).status, 1);
    // Read-only package filter includes exactly that package, never rewrites it.
    const scoped = run(['--check', '--package', 'smrt-ui']);
    assert.equal(scoped.status, 1);
    assert.ok(JSON.parse(scoped.stdout).files.every((entry) => entry.file.startsWith('packages/smrt-ui/src/')));
    writeFileSync(file, unsorted('.thing{display:flex;opacity:0}'));
    assert.equal(run(['--write', file, '--report', report]).status, 1);
    assert.equal(JSON.parse(readFileSync(report)).files[0].todos.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checked-in repository ratchet is fresh', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts/check-smrt-sort-layers.mjs')], { cwd: ROOT });
});

test('pilot comparison accounts for exact matches, token changes, role TODOs and additions', () => {
  const result = comparePilot(unsorted('.button{display:flex;color:red;opacity:.5}'),
    sorted('.smrt-button__root{display:flex}', '.smrt-button__root{color:blue;opacity:.5;border:0}'), 'Button');
  assert.equal(result.identical.length, 1);
  assert.equal(result.differences.length, 1);
  assert.equal(result.differences[0].reason, 'value differs');
  assert.equal(result.todos.length, 1);
  assert.equal(result.handOnly.length, 1);
  assert.equal(result.sourceDeclarations, 3);
  assert.equal(normalizeRecord({ path: [], value: '"a   b"' }, 'Button').value, '"a   b"');
});
