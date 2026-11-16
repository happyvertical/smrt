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

test('resolves each receiver from its own origin, not the file', () => {
  // Any receiver name: a provider client is untracked however it is called.
  assert.deepEqual(
    kinds("const client = await getAI({ type: 'openai' });\nawait client.message(p, { promptKey: 'k' });\n"),
    ['raw-client', 'untracked-call'],
  );
  assert.deepEqual(kinds('const x = await llm.chat(messages, opts);\n'), ['untracked-call']);
  assert.deepEqual(kinds('const reviewAi = deps.ai;\nawait reviewAi.message(p, opts);\n'), [
    'untracked-call',
  ]);
  assert.deepEqual(
    kinds('function f(model: AIClient) { return model.complete(p, opts); }\n'),
    ['untracked-call'],
  );
  // A tracked origin elsewhere in the file does not cover another client.
  assert.deepEqual(
    kinds(
      "const tracked = await this.getAiClient();\nawait tracked.message(p, opts);\nconst raw = await getAI({});\nawait raw.chat(m, opts);\n",
    ),
    ['raw-client', 'untracked-call'],
  );
  // A client destructured or copied from a tracked one is tracked.
  assert.deepEqual(
    kinds('const prepared = await this.prepareAiOperation(o);\nconst { ai } = prepared;\nawait ai.message(p, aiOptions);\n'),
    [],
  );
  assert.deepEqual(
    kinds(
      'interface Options { ai: TrackedAiClient }\nconst client = await ai.client(trackedPromptCall(r), { runContext });\nawait client.message(r.text, { ...opts });\n',
    ),
    [],
  );
  // Not model clients: a job, a stream, an approval authority.
  assert.deepEqual(
    kinds('await job.complete(result);\nwriter.stream(chunk);\nawait approvals.complete(id);\n'),
    [],
  );
});

test('reads code inside template literal expressions', () => {
  assert.deepEqual(kinds('const s = `answer: ${await ai.chat(messages)}`;\n'), ['untracked-call']);
  assert.deepEqual(kinds('const s = `ai.chat(${name})`;\n'), []);
  // Quotes in a template's text never pair up across its `${...}`.
  assert.deepEqual(kinds("const s = `it's ${await ai.chat(m)} isn't`;\n"), ['untracked-call']);
  assert.deepEqual(kinds('const q = "`";\nawait ai.chat(m);\n'), ['untracked-call']);
});

test('a client made by .client( on a provider client is not tracked', () => {
  assert.deepEqual(
    kinds("const raw = await getAI({});\nconst c = raw.client(p);\nawait c.message(x, { promptKey: 'k' });\n"),
    ['raw-client', 'untracked-call'],
  );
});

test('reads each origin of a receiver on its own, and every receiver of an origin', () => {
  // Two origins through the same provider receiver: both untracked.
  assert.deepEqual(
    kinds('let c = ai.client(a);\nc = ai.client(b);\nawait c.message(x, opts);\n'),
    ['untracked-call'],
  );
  // One untracked branch makes the client untracked.
  assert.deepEqual(
    kinds(
      "const c = x ? tracked.client({ promptKey: 'k' }) : ai.client({ promptKey: 'k' });\nawait c.message(m, opts);\n",
    ),
    ['untracked-call'],
  );
  assert.deepEqual(
    kinds(
      "const tracked = createTrackedAiClient({ db });\nconst c = x ? tracked.client({ promptKey: 'k' }) : trackedOther.client({ promptKey: 'j' });\nawait c.message(m, opts);\n",
    ),
    [],
  );
});

test('reads regular expression literals as literals, not code', () => {
  // A `/*`, a backtick or a quote inside one never blanks the code after it.
  assert.deepEqual(kinds('const re = /[/*]/;\nawait ai.chat(m);\n'), ['untracked-call']);
  assert.deepEqual(kinds('const re = /`/;\nawait ai.chat(m);\n'), ['untracked-call']);
  assert.deepEqual(kinds("if (/'/.test(s)) await ai.chat(m);\n"), ['untracked-call']);
  assert.deepEqual(kinds('const f = xs.some((s) => /[`*]/.test(s));\nawait ai.chat(m);\n'), [
    'untracked-call',
  ]);
  assert.deepEqual(kinds('const ok = x && /a\\/b/i.test(s); await ai.chat(m);\n'), [
    'untracked-call',
  ]);
  // Prose in one is not code.
  assert.deepEqual(kinds('const re = /ai.chat(m)/;\n'), []);
  assert.deepEqual(kinds('return /getAI(/.test(s);\n'), []);
  // A division is not one.
  assert.deepEqual(kinds("const r = a / b; const s = 'x/y'; await ai.chat(m);\n"), [
    'untracked-call',
  ]);
  assert.deepEqual(kinds('const r = f(a) / 2 / ai.chat(m);\n'), ['untracked-call']);
  // Svelte markup: a self-closing tag and a block closer are not one.
  assert.deepEqual(kinds('<A x={1} /><B on:click={() => ai.message(p)} />\n'), [
    'untracked-call',
  ]);
  assert.deepEqual(kinds('{#if a}<A />{/if}<B on:click={() => ai.message(p)} />\n'), [
    'untracked-call',
  ]);
});

test('a line comment right after a colon is a comment', () => {
  assert.deepEqual(kinds('const o = { key:// ai.chat(m)\n  value: 1 };\n'), []);
  assert.deepEqual(kinds('const o = { key://ai.chat(m)\n  value: 1 };\n'), []);
});

test('a URL in markup is not a comment', () => {
  assert.deepEqual(kinds('<a href=https://x>{ai.chat(p)}</a>\n'), ['untracked-call']);
  assert.deepEqual(kinds('<p>see http://x.org/a/b then {ai.chat(p)}</p>\n'), [
    'untracked-call',
  ]);
});

test('a division after a postfix increment or decrement is not a regular expression', () => {
  assert.deepEqual(kinds('i++ / 2; await ai.chat(p); q / 3;\n'), ['untracked-call']);
  assert.deepEqual(kinds('i-- / 2; await ai.chat(p); q / 3;\n'), ['untracked-call']);
  // An operator before a literal still opens one.
  assert.deepEqual(kinds('const r = a + /ai.chat(m)/.source;\n'), []);
});

test('known limit: origins are matched by name across the file, not by scope', () => {
  // A tracked `ai` in one function covers a provider `ai` in another.
  assert.deepEqual(
    kinds(
      'async function a() { const ai = await this.getAiClient(); }\nfunction b(ai: AIClient) { return ai.chat(m, opts); }\n',
    ),
    [],
  );
});

test('checks the prompt of every .client( call on a tracked client', () => {
  const typed = 'interface Options { ai: TrackedAiClient }\n';
  assert.deepEqual(kinds(`${typed}await ai.client({ tier: 'good' });\n`), ['no-prompt-key']);
  assert.deepEqual(kinds(`${typed}await ai.client(trackedPromptCall(resolved));\n`), []);
  // A method named client on something else is not a tracked client.
  assert.deepEqual(kinds('const run = await openTurn();\nawait run.client(selection);\n'), []);
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
