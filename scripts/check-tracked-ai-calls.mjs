#!/usr/bin/env node
/**
 * Tracked AI calls guardrail (happyvertical/smrt#5005; docs/content/ai-runs.md
 * section 3, "Staying on the tracked path").
 *
 * Every model call goes through the tracked client, and every tracked call
 * carries the key of a registered prompt. The tracked client is core's
 * `createTrackedAiClient` and the clients `SmrtClass` hands out
 * (`getAiClient`, `prepareAiOperation`, `getOptionalAiClient`): they write the
 * call's usage row, tagged with its prompt key, and take part in runs. This
 * check fails when package code
 *
 *   1. builds a provider client itself (`getAI(...)` of `@happyvertical/ai`),
 *   2. imports a provider SDK, or
 *   3. calls a model method (`ai.chat`, `ai.message`, `ai.complete`,
 *      `ai.stream`) on a client that did not come from the tracked path, or
 *   4. makes a tracked call that carries no prompt key: a model call with no
 *      options at all, or with a literal that names neither `promptKey` nor
 *      `usageTags` and spreads nothing; a `createTrackedAiClient(...).client()`
 *      call whose prompt names no `promptKey`.
 *
 * The files below are the only exceptions, each with its reason. A stale entry
 * (a file that no longer needs the exception) fails too, so the list only
 * shrinks. Comments and string bodies are ignored; test files are not scanned.
 *
 * Usage: node scripts/check-tracked-ai-calls.mjs [--root <dir>]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Files (or, with a trailing `/`, directories) that may make a model call
 * outside the tracked client, each with its reason. Image generation and
 * vision are not text calls: the tracked client covers `chat`, `message`,
 * `complete` and `stream`, so the sites that only generate or read images are
 * listed until it covers them.
 */
export const ALLOWED = {
  'packages/core/src/class.ts':
    "The tracked path itself: SmrtClass builds the provider clients (getAiClient, the decision client) that every tracked call goes through.",
  'packages/chat/src/sveltekit.ts':
    "The assistant route's default client when the host passes none; each turn wraps it in the tracked client (turn-tracking.ts), so its calls are the turn run's calls.",
  'packages/chat/src/tool-loop.ts':
    "The tool loop calls the client its caller passes; assistant turns pass the tracked client bound to the turn's run.",
  'packages/chat/src/chat-stream.ts':
    "Streams the client the host passes to createChatStreamHandler; the handler has no database of its own to track in.",
  'packages/chat/src/routes/api/':
    'Loopback-only dev workbench routes (no database, no tenant): demos of the chat components, never served to users.',
  'packages/cli/src/commands/kitchen/':
    "The local developer 'kitchen' CLI: no database or tenant, nothing to record in.",
  'packages/content/src/content-chat-handlers.ts':
    "Chat handlers take an injectable client (default getAI) and have no database in scope; to move onto the tracked client with the content chat's own turn run.",
  'packages/content/src/thumbnail-generator.ts':
    'Image generation, not a text call; the tracked client does not cover image generation yet.',
  'packages/images/src/categorizer.ts':
    "Vision categorization and the typed-decision client with no database in scope; usage reaches the configured handlers through resolveInferenceTarget's recorder.",
  'packages/images/src/deriver.ts':
    'Image generation, not a text call; the tracked client does not cover image generation yet.',
  'packages/images/src/editor.ts':
    'Image generation, not a text call; the tracked client does not cover image generation yet.',
  'packages/ingestion/src/extraction-worker.ts':
    'The vision client of the extraction worker, built from the worker configuration with no database in scope.',
  'packages/inference/src/hosted.ts':
    "Builds the hosted gateway's provider client; core's tracked path calls it through the target (clientFor).",
  'packages/inference/src/chatgpt/':
    "The ChatGPT sign-in engine: builds the chatgpt-plan client and adapts chat() for engine models; the tracked path reaches it through the target.",
  'packages/languages/src/jobs/translation-job.ts':
    "Builds an explicit-provider client from the prompt's provider, with usage recorded through withAiUsage and a prompt key (#4756); moves to getAiClient when the prompt declares a tier.",
  'packages/projects/src/models/Issue.ts':
    "Builds an explicit-provider client from the prompt's provider, with usage recorded through withAiUsage and a prompt key (#4756); moves to getAiClient when the prompt declares a tier.",
};

/** The entry of `allowed` that covers `file`, or undefined. */
export function allowedEntry(file, allowed) {
  if (Object.hasOwn(allowed, file)) return file;
  return Object.keys(allowed).find(
    (entry) => entry.endsWith('/') && file.startsWith(entry),
  );
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.svelte-kit',
  '.smrt',
  '__tests__',
  '__fixtures__',
  'fixtures',
  'test-support',
  'tests',
  'e2e',
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|svelte)$/;
const TEST_FILE = /\.(test|spec|e2e|manual\.test)\.[cm]?[jt]s$|\.d\.ts$/;

/** Provider SDKs a package must reach only through `@happyvertical/ai`. */
const PROVIDER_SDKS = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@google/generative-ai',
  '@aws-sdk/client-bedrock-runtime',
  '@mistralai/mistralai',
  'cohere-ai',
  'groq-sdk',
  'ollama',
];

/** What marks a file as holding a client from the tracked path. */
const TRACKED_ORIGIN =
  /\b(?:prepareAiOperation|getAiClient|getOptionalAiClient|createTrackedAiClient|trackedAiClient|transcriptClient|tracked\.client)\b/;

const MODEL_METHODS = '(?:chat|message|complete|stream)';

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

/** Blank comments and string bodies so prose that names the API is not counted. */
export function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
    .replace(
      /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
      (m) => m[0] + m.slice(1, -1).replace(/[^\n]/g, ' ') + m[m.length - 1],
    );
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** The text of the call's argument list starting at the `(` at `open`. */
function argumentsAt(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

/** Top-level comma split of an argument list. */
function splitArguments(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const last = text.slice(start);
  if (last.trim() !== '') parts.push(last);
  return parts.map((part) => part.trim());
}

/**
 * Whether a call's options can carry a prompt key: a non-literal expression
 * (a variable, a call, a spread) is assumed to, since the prompt helpers
 * build it; a literal must name `promptKey` or `usageTags`.
 */
function optionsCarryKey(options) {
  if (options === undefined || options === '') return false;
  if (!options.startsWith('{')) return true;
  return /\bpromptKey\b|\busageTags\b|\.\.\./.test(options);
}

/**
 * Violations in one source file, as `{ line, kind, detail }`. `raw` source is
 * needed for import specifiers, `code` for everything else.
 */
export function findViolations(source) {
  const code = stripNoise(source);
  const found = [];

  for (const match of code.matchAll(/\bgetAI\b/g)) {
    found.push({
      line: lineOf(code, match.index),
      kind: 'raw-client',
      detail: 'builds a provider client with getAI()',
    });
  }

  for (const sdk of PROVIDER_SDKS) {
    const escaped = sdk.replace(/[/@.-]/g, '\\$&');
    const re = new RegExp(
      `(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`,
      'g',
    );
    // Comments are removed from the source, but string bodies must stay.
    const noComments = source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
    for (const match of noComments.matchAll(re)) {
      found.push({
        line: lineOf(noComments, match.index),
        kind: 'provider-sdk',
        detail: `imports the provider SDK ${sdk}`,
      });
    }
  }

  const tracked = TRACKED_ORIGIN.test(code);
  const callRe = new RegExp(`\\b(?:ai|aiClient)\\s*\\.\\s*${MODEL_METHODS}\\s*\\(`, 'g');
  for (const match of code.matchAll(callRe)) {
    const open = match.index + match[0].length - 1;
    const args = splitArguments(argumentsAt(code, open));
    if (!tracked) {
      found.push({
        line: lineOf(code, match.index),
        kind: 'untracked-call',
        detail: `${match[0].replace(/\s+/g, '')} on a client that did not come from the tracked path`,
      });
      continue;
    }
    // Message-style calls take the input first, the options second.
    if (!optionsCarryKey(args[1])) {
      found.push({
        line: lineOf(code, match.index),
        kind: 'no-prompt-key',
        detail: `${match[0].replace(/\s+/g, '')} carries no prompt key (pass the options of a resolved prompt, or usageTags with promptKey)`,
      });
    }
  }

  const clientRe = /\b(?:tracked|trackedAi|trackedClient)\s*\.\s*client\s*\(/g;
  for (const match of code.matchAll(clientRe)) {
    const open = match.index + match[0].length - 1;
    const prompt = splitArguments(argumentsAt(code, open))[0];
    if (!prompt || !/\bpromptKey\b|\btrackedPromptCall\b/.test(prompt)) {
      found.push({
        line: lineOf(code, match.index),
        kind: 'no-prompt-key',
        detail: 'a tracked client is made without a prompt key (pass promptKey, or trackedPromptCall(resolvePrompt(...)))',
      });
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

const ROOTS = ['packages', 'examples'];

/** Every scanned source file's violations, relative to `root`. */
export function scanRepository(root) {
  const files = [];
  for (const top of ROOTS) {
    const topDir = join(root, top);
    let entries;
    try {
      entries = readdirSync(topDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkg = join(topDir, entry.name);
      for (const sub of ['src', 'bin', 'scripts']) {
        const dir = join(pkg, sub);
        try {
          if (statSync(dir).isDirectory()) walk(dir, files);
        } catch {
          // no such directory
        }
      }
    }
  }
  const violations = new Map();
  for (const file of files) {
    const found = findViolations(readFileSync(file, 'utf8'));
    if (found.length) {
      violations.set(relative(root, file).split(sep).join('/'), found);
    }
  }
  return violations;
}

export function evaluate(violations, allowed = ALLOWED) {
  const errors = [];
  const used = new Set();
  for (const [file, found] of violations) {
    const entry = allowedEntry(file, allowed);
    if (entry) {
      used.add(entry);
      continue;
    }
    for (const item of found) {
      errors.push(
        `${file}:${item.line} ${item.detail}. Model calls go through the tracked client (createTrackedAiClient, or a SmrtClass client from getAiClient / prepareAiOperation) and carry a prompt key from resolvePrompt; if this file is a real exception, add it to ALLOWED in scripts/check-tracked-ai-calls.mjs with its reason.`,
      );
    }
  }
  for (const [entry, reason] of Object.entries(allowed)) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      errors.push(`${entry} is allowed without a reason; give the exception its reason.`);
    }
    if (!used.has(entry)) {
      errors.push(
        `${entry} is allowed to call a model outside the tracked client but no longer does; remove it from ALLOWED.`,
      );
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 ? args[rootIndex + 1] : join(import.meta.dirname, '..');
  const violations = scanRepository(root);
  if (args.includes('--list')) {
    for (const [file, found] of violations) {
      for (const item of found) console.log(`${file}:${item.line} [${item.kind}] ${item.detail}`);
    }
    process.exit(0);
  }
  const errors = evaluate(violations);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(
    `tracked AI calls: ${Object.keys(ALLOWED).length} allowed exception(s), no other model call outside the tracked client.`,
  );
}
