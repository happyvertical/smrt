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
 *   3. calls a model method (`chat`, `message`, `complete`, `stream`) on a
 *      client that did not come from the tracked path. Each receiver's origin
 *      is read from the file: the initializers and declared types of the
 *      variable (and of a variable it was copied or destructured from). A
 *      tracked factory makes it tracked; `getAI`, an `AIClient` /
 *      `AIInterface` type, or a model-client name (`ai`, `llm`, `*Ai`) with
 *      no tracked origin makes it a provider client; anything else (a job's
 *      `complete`, a store's `stream`) is not a model client. Or
 *   4. makes a tracked call that carries no prompt key: a model call with no
 *      options at all, or with a literal that names neither `promptKey` nor
 *      `usageTags` and spreads nothing; a `.client()` call on a tracked
 *      client whose prompt names no `promptKey`.
 *
 * The files below are the only exceptions, each with its reason. A stale entry
 * (a file that no longer needs the exception) fails too, so the list only
 * shrinks. Comments, string bodies and regular expression literals are
 * ignored (a template literal's `${...}` expressions are code); test files
 * are not scanned.
 *
 * Known limits (a text scan, not a type checker):
 *   - Origins are matched by name across the whole file, not by scope: a
 *     tracked `ai` in one function also covers an `ai: AIClient` parameter
 *     of another (a false negative). Give a provider client its own name.
 *   - `.client(` makes a tracked client unless its receiver is a provider
 *     client (a model-client name with no tracked origin counts as one); on
 *     any other receiver whose origin the file does not show, it is taken
 *     as tracked.
 *   - A `/` is taken for a regular expression literal by the character or
 *     keyword before it (not after `)`, `]`, `}`, `<` or a lone `>`), and
 *     only when the literal closes on its own line; a literal after one of
 *     those (`if (x) /re/.test(s)`) is read as code.
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
  'packages/ingestion/src/extraction-providers.ts':
    'Calls the vision client of the extraction providers its host passes in; the extraction worker builds that client (below) with no database in scope.',
  'packages/ingestion/src/proposal-sdk.ts':
    "createSDKProposalGenerator is a public adapter over the SDK client its host passes in; the host builds that client, on the tracked path when it has a database.",
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

/**
 * What makes a variable a client from the tracked path: its initializer or
 * declared type names one of these, or it is made by `.client(` on a
 * receiver that is not a provider client (see `originKind`).
 */
const TRACKED_ORIGIN =
  /\b(?:prepareAiOperation|getAiClient|getOptionalAiClient|createTrackedAiClient|trackedAiClient|transcriptClient|TrackedAiClient)\b/;

/** `.client(` in an origin, with its receiver. */
const CLIENT_ORIGIN = /([A-Za-z_$][\w$]*)\s*\??\.\s*client\s*\(/g;

/** What makes a variable a provider client outside the tracked path. */
const UNTRACKED_ORIGIN = /\bgetAI\b|\bAI(?:Client|Interface)\b/;

/** A receiver named like a model client, whatever its origin. */
const AI_NAME = /^(?:ai|llm|aiClient)$|(?:Ai|AI|AiClient|Llm|LLM)$/;

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

/**
 * Characters after which a `/` starts a regular expression literal rather
 * than a division (and an arrow's `=>`). `)`, `]` and `}` are left out (a
 * division, or the end of a block, or a Svelte tag's `/>`), and so are `<`
 * and a lone `>` (Svelte markup).
 */
const REGEX_AFTER_CHAR = new Set('(,=:[!&|?{;+-*%~^'.split(''));
/** Keywords after which a `/` starts a regular expression literal. */
const REGEX_AFTER_WORD =
  /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/**
 * The end (exclusive) of a regular expression literal whose opening `/` is
 * at `start`, or -1 when this `/` is not one: by the last significant
 * character before it in `before` (a heuristic, not a parser), and only when
 * the literal closes on its own line. Svelte's `{/if}` and the like are not
 * literals.
 */
function regexEnd(source, start, before) {
  let k = before.length - 1;
  while (k >= 0 && /\s/.test(before[k])) k -= 1;
  const last = before[k];
  // A postfix `++` or `--` ends an operand: a division follows it.
  if ((last === '+' || last === '-') && before[k - 1] === last) return -1;
  if (
    last !== undefined &&
    !REGEX_AFTER_CHAR.has(last) &&
    !(last === '>' && before[k - 1] === '=') &&
    !REGEX_AFTER_WORD.test(before.slice(Math.max(0, k - 11), k + 1))
  ) {
    return -1;
  }
  if (last === '{' && /^\/(?:if|each|await|key|snippet)\b/.test(source.slice(start, start + 9))) {
    return -1;
  }
  let inClass = false;
  for (let j = start + 1; j < source.length; j += 1) {
    const c = source[j];
    if (c === '\n') return -1;
    if (c === '\\') {
      j += 1;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let end = j + 1;
      while (end < source.length && /[a-z]/i.test(source[end])) end += 1;
      return end;
    }
  }
  return -1;
}

/** A URL scheme and its colon, ending where a `//` starts. */
const URL_SCHEME = /(?:^|[^\w$])(?:https?|wss?|ftps?|file):$/i;

/**
 * Whether the `//` at `start` belongs to a URL in markup, as in
 * `<a href=https://x>`: right after a URL scheme's colon and followed by the
 * URL itself, not by a space. Anything else (`key:// note`) is a comment.
 */
function urlSlashes(source, start) {
  const after = source[start + 2];
  return (
    after !== undefined &&
    !/\s/.test(after) &&
    URL_SCHEME.test(source.slice(Math.max(0, start - 7), start))
  );
}

/**
 * Blank comments, string bodies and regular expression literals so prose
 * that names the API is not counted. A template literal keeps its `${...}`
 * expressions: code there is code. One left-to-right pass, so a quote inside
 * a template's text (or a backtick inside a string, or a quote, backtick or
 * `/*` inside a regular expression) never unbalances the other. A `/` is
 * read as a regular expression by the character or keyword before it (see
 * {@link regexEnd}).
 */
export function stripNoise(source) {
  let out = '';
  let i = 0;
  // Each open template: the brace depth of the `${` that holds the next one.
  const stack = [];
  let depth = 0;
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '/' && next === '/' && urlSlashes(source, i)) {
      out += '//';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      let stop = source.indexOf('\n', i);
      if (stop < 0) stop = source.length;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '/') {
      const end = regexEnd(source, i, out);
      if (end > 0) {
        out += `/${blank(source.slice(i + 1, end))}`;
        i = end;
        continue;
      }
    }
    if (ch === "'" || ch === '"') {
      // A string ends at its quote, or (unterminated) at the line end.
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') {
        j += source[j] === '\\' && source[j + 1] !== '\n' ? 2 : 1;
      }
      const closed = source[j] === ch;
      out += ch + blank(source.slice(i + 1, j)) + (closed ? ch : '');
      i = closed ? j + 1 : j;
      continue;
    }
    if (ch === '`' || (ch === '}' && depth === 0 && stack.length)) {
      // Template text: from a backtick, or from the `}` closing a `${`.
      if (ch === '}') depth = stack.pop();
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') {
          out += source[i + 1] === '\n' ? ' \n' : '  ';
          i += 2;
          continue;
        }
        if (c === '`') {
          out += c;
          i += 1;
          break;
        }
        if (c === '$' && source[i + 1] === '{') {
          stack.push(depth);
          depth = 0;
          out += '${';
          i += 2;
          break;
        }
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    out += ch;
    i += 1;
  }
  return out;
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

/** The text of an expression starting at `start`: to `;` or a line end at depth 0. */
function expressionAt(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return code.slice(start, i);
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || ch === ',' || ch === '\n')) {
      if (ch !== '\n' || code.slice(start, i).trim() !== '') {
        return code.slice(start, i);
      }
    }
  }
  return code.slice(start);
}

/**
 * Where a variable's value comes from in this file: the initializers and
 * declared types of every declaration, assignment, destructuring, parameter
 * or field that names it.
 */
function originsOf(code, name) {
  const id = name.replace(/\$/g, '\\$');
  const origins = [];
  const assigned = new RegExp(`(?<![\\w$])${id}\\s*(?::\\s*([^=;]+?))?\\s*=(?![=>])`, 'g');
  for (const match of code.matchAll(assigned)) {
    if (match[1]) origins.push(match[1]);
    origins.push(expressionAt(code, match.index + match[0].length));
  }
  const destructured = new RegExp(`\\{[^{}]*(?<![\\w$.])${id}\\b[^{}]*\\}\\s*=(?![=>])`, 'g');
  for (const match of code.matchAll(destructured)) {
    origins.push(expressionAt(code, match.index + match[0].length));
  }
  const typed = new RegExp(`(?<![\\w$.])${id}\\??\\s*:\\s*`, 'g');
  for (const match of code.matchAll(typed)) {
    origins.push(expressionAt(code, match.index + match[0].length));
  }
  return origins;
}

/**
 * A variable's origins, following a value copied or destructured from
 * another variable (`const { ai } = prepared`) a few steps back.
 */
function resolvedOrigins(code, name, seen = new Set()) {
  if (seen.has(name) || seen.size > 4) return [];
  seen.add(name);
  const origins = [];
  for (const origin of originsOf(code, name)) {
    origins.push(origin);
    const from = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*$/.exec(origin)?.[1];
    if (from) origins.push(...resolvedOrigins(code, from, seen));
  }
  return origins;
}

/**
 * A receiver's kind: `tracked` (a client from the tracked path), `model` (a
 * model client from anywhere else) or `other` (not a model client: a job's
 * `complete`, a store's `stream`).
 */
function receiverKind(code, name, seen = new Set()) {
  if (seen.has(name)) return 'other';
  seen.add(name);
  // Each origin follows its own path: a name seen while reading one origin
  // is not taken as settled for the next.
  const kinds = resolvedOrigins(code, name).map((origin) =>
    originKind(code, origin, new Set(seen)),
  );
  if (kinds.includes('tracked')) return 'tracked';
  if (AI_NAME.test(name) || kinds.includes('model')) return 'model';
  return 'other';
}

/**
 * What an origin makes: `tracked` (a tracked factory or type, or `.client(`
 * on receivers that are not provider clients), `model` (a provider factory
 * or type, or `.client(` on any provider client: in `x ? t.client() :
 * ai.client()` one untracked branch makes it untracked) or null. `.client(`
 * on a receiver whose origin the file does not show counts as tracked, so
 * the client it makes is held to the prompt-key rule.
 */
function originKind(code, origin, seen) {
  if (TRACKED_ORIGIN.test(origin)) return 'tracked';
  if (UNTRACKED_ORIGIN.test(origin)) return 'model';
  const receivers = [...origin.matchAll(CLIENT_ORIGIN)].map((match) => match[1]);
  if (receivers.length === 0) return null;
  const untracked = receivers.some(
    (receiver) =>
      !/^tracked/i.test(receiver) &&
      receiverKind(code, receiver, new Set(seen)) === 'model',
  );
  return untracked ? 'model' : 'tracked';
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

  const callRe = new RegExp(
    `([A-Za-z_$][\\w$]*)\\s*\\??\\.\\s*${MODEL_METHODS}\\s*\\(`,
    'g',
  );
  const kinds = new Map();
  for (const match of code.matchAll(callRe)) {
    const receiver = match[1];
    // `this.chat(` is a method of the class itself, not a client.
    if (receiver === 'this' || receiver === 'super') continue;
    if (!kinds.has(receiver)) kinds.set(receiver, receiverKind(code, receiver));
    const kind = kinds.get(receiver);
    if (kind === 'other') continue;
    const call = match[0].replace(/\s+/g, '');
    if (kind === 'model') {
      found.push({
        line: lineOf(code, match.index),
        kind: 'untracked-call',
        detail: `${call} on a client that did not come from the tracked path`,
      });
      continue;
    }
    const open = match.index + match[0].length - 1;
    const args = splitArguments(argumentsAt(code, open));
    // Message-style calls take the input first, the options second.
    if (!optionsCarryKey(args[1])) {
      found.push({
        line: lineOf(code, match.index),
        kind: 'no-prompt-key',
        detail: `${call} carries no prompt key (pass the options of a resolved prompt, or usageTags with promptKey)`,
      });
    }
  }

  // `.client(` of a tracked client makes a client for one prompt: the prompt
  // must name its key.
  const clientRe = /([A-Za-z_$][\w$]*)\s*\??\.\s*client\s*\(/g;
  for (const match of code.matchAll(clientRe)) {
    const receiver = match[1];
    if (!/^tracked/i.test(receiver)) {
      if (!kinds.has(receiver)) kinds.set(receiver, receiverKind(code, receiver));
      if (kinds.get(receiver) !== 'tracked') continue;
    }
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
