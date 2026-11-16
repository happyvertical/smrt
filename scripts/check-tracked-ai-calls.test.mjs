import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED,
  allowedEntry,
  evaluate,
  findViolations,
  scanRepository,
} from './check-tracked-ai-calls.mjs';

const script = fileURLToPath(new URL('./check-tracked-ai-calls.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'tracked-ai-calls-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
/** The check on a fixture repository, with no exceptions allowed. */
const check = (root) => evaluate(scanRepository(root), {});
const kinds = (source) => findViolations(source).map((item) => item.kind);

test('passes on this repository, with every exception carrying a reason', () => {
  const out = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(evaluate(scanRepository(repoRoot)), []);
  for (const [entry, reason] of Object.entries(ALLOWED)) {
    assert.ok(reason.trim().length > 20, `${entry} needs a written reason`);
  }
});

test('fails a package that builds a provider client itself', () => {
  const root = repo({
    'packages/p/src/ask.ts': `import { getAI } from '@happyvertical/ai';
const ai = await getAI({ type: 'openai' });
`,
  });
  try {
    const errors = check(root);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /packages\/p\/src\/ask\.ts:1 builds a provider client with getAI\(\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails a provider SDK import, static, dynamic or required', () => {
  for (const line of [
    "import OpenAI from 'openai';",
    "const sdk = await import('@anthropic-ai/sdk');",
    "const { GoogleGenAI } = require('@google/genai');",
  ]) {
    assert.deepEqual(kinds(`${line}\n`), ['provider-sdk'], line);
  }
  assert.deepEqual(kinds("import x from 'openai-compatible-thing';\n"), []);
});

test('fails a model call on a client that did not come from the tracked path', () => {
  assert.deepEqual(
    kinds('async function f(ai) { return ai.chat(messages, { promptKey: "k" }); }\n'),
    ['untracked-call'],
  );
  assert.deepEqual(kinds('const x = await options.ai.stream(m, opts);\n'), ['untracked-call']);
});

test('fails a tracked call that carries no prompt key', () => {
  const origin = 'const ai = await this.getAiClient();\n';
  // No options at all, and a literal that names no key.
  assert.deepEqual(kinds(`${origin}await ai.message(prompt);\n`), ['no-prompt-key']);
  assert.deepEqual(kinds(`${origin}await ai.message(prompt, { temperature: 0 });\n`), [
    'no-prompt-key',
  ]);
  // Options built from a resolved prompt, a key in the literal, a spread: fine.
  assert.deepEqual(kinds(`${origin}await ai.message(prompt, aiOptions);\n`), []);
  assert.deepEqual(
    kinds(`${origin}await ai.message(prompt, { usageTags: { promptKey: 'a.b' } });\n`),
    [],
  );
  assert.deepEqual(kinds(`${origin}await ai.chat(m, { ...promptMessageOptions(ai), x: 1 });\n`), []);
});

test('fails a tracked client made without a prompt key', () => {
  const origin = "const tracked = createTrackedAiClient({ db });\n";
  assert.deepEqual(kinds(`${origin}await tracked.client({ tier: 'good' });\n`), [
    'no-prompt-key',
  ]);
  assert.deepEqual(kinds(`${origin}await tracked.client();\n`), ['no-prompt-key']);
  assert.deepEqual(kinds(`${origin}await tracked.client({ promptKey: 'a.b' });\n`), []);
  assert.deepEqual(
    kinds(`${origin}await tracked.client(trackedPromptCall(resolved), { runContext });\n`),
    [],
  );
});

test('ignores comments, strings and test files', () => {
  const root = repo({
    'packages/p/src/doc.ts': `// getAI(options) is how the SDK builds a client; ai.chat(x) calls it
/* import OpenAI from 'openai' */
const note = "getAI( ai.chat( )";
export {};
`,
    'packages/p/src/ask.test.ts': "import { getAI } from '@happyvertical/ai'; getAI({});\n",
    'packages/p/src/__tests__/ask.ts': "import { getAI } from '@happyvertical/ai'; getAI({});\n",
  });
  try {
    assert.deepEqual(check(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an exception needs its entry, and a stale or reasonless entry fails', () => {
  const violations = new Map([
    ['packages/p/src/a.ts', [{ line: 3, kind: 'raw-client', detail: 'builds a provider client with getAI()' }]],
    ['packages/dev/routes/b.ts', [{ line: 1, kind: 'raw-client', detail: 'builds a provider client with getAI()' }]],
  ]);
  const allowed = {
    'packages/p/src/a.ts': 'A real reason that is long enough to read.',
    'packages/dev/routes/': 'A directory reason that is long enough to read.',
  };
  assert.deepEqual(evaluate(violations, allowed), []);
  assert.equal(allowedEntry('packages/dev/routes/b.ts', allowed), 'packages/dev/routes/');

  const missing = evaluate(violations, { 'packages/p/src/a.ts': 'A real reason.' });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /packages\/dev\/routes\/b\.ts:1/);

  const stale = evaluate(violations, { ...allowed, 'packages/gone/src/c.ts': 'It used to call a model.' });
  assert.equal(stale.length, 1);
  assert.match(stale[0], /gone\/src\/c\.ts is allowed .* no longer does/);

  const reasonless = evaluate(violations, { ...allowed, 'packages/p/src/a.ts': ' ' });
  assert.equal(reasonless.length, 1);
  assert.match(reasonless[0], /without a reason/);
});
