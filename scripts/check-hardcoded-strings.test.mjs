import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findViolations } from './check-hardcoded-strings.mjs';

for (const expression of [
  '{#each [{ key: "first" }, { key: "second", nested: { value: 1 } }] as field}',
  '{render({ nested: [{ label: "internal words" }] })}',
  '{#if value === "}" && other === "{ internal words"}',
  "{value === 'escaped \\' } internal words'}",
  '{`outer ${JSON.stringify({ label: `nested ${value}` })} internal words`}',
  '{render(/* } internal words */ { value: 1 })}',
  '{render(// } internal words\n { value: 1 })}',
  '{/}/.test(value) ? "internal words" : ""}',
  '{@const value = { label: "internal words" }}',
  '{:else if value === "} internal words"}',
  '{/each}',
  '{"<!-- } internal words -->"}',
]) {
  test(`ignores complete expression ${expression}`, () => {
    assert.deepEqual(
      findViolations(
        `<div>${expression}</div><p>Real nearby prose</p><input title="Actual title">`,
      ),
      [
        {
          line: expression.split('\n').length,
          kind: 'text',
          text: 'Real nearby prose',
        },
        {
          line: expression.split('\n').length,
          kind: 'title',
          text: 'Actual title',
        },
      ],
    );
  });
}

test('preserves lines around multiline expressions, comments, script and style', () => {
  const source =
    '<script>const x = "ignored words";</script>\n<style>/* ignored words */</style>\n<!-- ignored words { -->\n{#each [\n {key: "first"},\n {key: "second"}\n] as field}\n<p>Actual prose here</p>\n<input\n aria-label="Actual label"\n placeholder="Enter name"\n alt="Picture">';
  assert.deepEqual(findViolations(source), [
    { line: 8, kind: 'text', text: 'Actual prose here' },
    { line: 11, kind: 'placeholder', text: 'Enter name' },
    { line: 12, kind: 'alt', text: 'Picture' },
    { line: 10, kind: 'aria-label', text: 'Actual label' },
  ]);
});

test('retains real prose after malformed expressions', () => {
  for (const expression of ['{value', '{"unterminated']) {
    assert.ok(
      findViolations(`${expression}<p>Visible actual prose</p>`).some(
        (v) => v.text === 'Visible actual prose',
      ),
    );
  }
});

test('QuoteEditor nested field arrays are not prose', () => {
  const source = readFileSync(
    new URL(
      '../packages/commerce/src/svelte/components/QuoteEditor.svelte',
      import.meta.url,
    ),
    'utf8',
  );
  assert.deepEqual(findViolations(source), []);
});

test('CLI retains strict enforcement for genuine shipped prose', () => {
  const root = mkdtempSync(
    join(process.env.CI_TEST_TMPDIR ?? tmpdir(), 'scanner-'),
  );
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'packages/commerce/src'), { recursive: true });
    copyFileSync(
      new URL('./check-hardcoded-strings.mjs', import.meta.url),
      join(root, 'scripts/check-hardcoded-strings.mjs'),
    );
    symlinkSync(
      new URL('../node_modules', import.meta.url).pathname,
      join(root, 'node_modules'),
      'dir',
    );
    const fixture = join(root, 'packages/commerce/src/Fixture.svelte');
    const expression =
      '{#each [{key: "a"}, {key: "b"}] as field}{field.key}{/each}';
    writeFileSync(fixture, expression + '<p>Actual visible prose</p>');
    const run = () =>
      spawnSync(
        process.execPath,
        [join(root, 'scripts/check-hardcoded-strings.mjs')],
        { encoding: 'utf8' },
      );
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Actual visible prose/);
    assert.doesNotMatch(result.stderr, /as field/);
    writeFileSync(fixture, expression);
    assert.equal(run().status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
