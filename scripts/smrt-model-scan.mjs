/**
 * Shared enumerator of `@smrt`-decorated classes (happyvertical/smrt#5076).
 *
 * Used by `surface-ledger-lib.mjs` (the new-surface gate) and
 * `check-direct-model-construction.mjs`, so the repository has one definition
 * of "a decorated model". Source-only: no build, no node_modules. Handles
 * comments, strings and template text (blanked), aliased and namespace imports
 * of `smrt`, multi-line decorator arguments and stacked decorators.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Directories never scanned for models (tests, fixtures, build output). */
export const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.svelte-kit',
  '.smrt',
  '__tests__',
  '__fixtures__',
  'fixtures',
  'test-support',
  'tests',
  'test',
  'e2e',
]);
export const TEST_FILE = /\.(test|spec|e2e)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

/** Every non-test TypeScript source file under `dir`. */
export function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* sourceFiles(join(dir, entry.name));
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

/**
 * Blank comments, string literals and template-literal text (keeping newlines
 * and length) so a decorator mentioned in prose or generated-code text is never
 * mistaken for a real one.
 */
export function blankNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let prev = ''; // last significant (non-space) code character
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      prev = c;
    } else if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (depth === 0 && src[j] === '`') break;
        else if (src[j] === '$' && src[j + 1] === '{') {
          depth++;
          j += 2;
        } else if (depth > 0 && src[j] === '}') {
          depth--;
          j++;
        } else j++;
      }
      blank(i + 1, j);
      i = j + 1;
      prev = '`';
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
      // Regex literal: blank so quotes inside do not open a string.
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '[') {
          inClass = true;
          j++;
        } else if (src[j] === ']') {
          inClass = false;
          j++;
        } else if (src[j] === '/' && !inClass) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
      prev = '/';
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out.join('');
}

/**
 * Decorator spellings `smrt` is reachable under: `smrt`, any
 * `import { smrt as x }` alias, and `ns.smrt` for each `import * as ns`.
 * Returned as regex source fragments.
 */
function decoratorNames(code) {
  const esc = (v) => v.replace(/\$/g, '\\$');
  const names = new Set(['smrt']);
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const am = part.trim().match(/^smrt\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (am) names.add(esc(am[1]));
    }
  }
  for (const m of code.matchAll(/import\s+(?:[\w$]+\s*,\s*)?\*\s*as\s+([A-Za-z_$][\w$]*)\s+from/g)) {
    names.add(`${esc(m[1])}\\s*\\.\\s*smrt`);
  }
  return [...names];
}

/** Index just past the `)` closing the `(` at `open` (code is blanked). */
function skipParens(code, open) {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '(') depth++;
    else if (code[k] === ')' && --depth === 0) return k + 1;
  }
  return -1;
}

/** Class names carrying an `@smrt` decorator in one source file. */
export function modelsInSource(src) {
  const code = blankNonCode(src);
  const alt = decoratorNames(code).join('|');
  const found = [];
  const re = new RegExp(`@\\s*(?:${alt})(?![\\w$])(?!\\s*\\.)`, 'g');
  for (const m of code.matchAll(re)) {
    let k = m.index + m[0].length;
    const skipWs = () => {
      while (k < code.length && /\s/.test(code[k])) k++;
    };
    skipWs();
    if (code[k] === '(') {
      k = skipParens(code, k);
      if (k === -1) continue;
    }
    // Further stacked decorators, then modifiers, then the class name.
    for (;;) {
      skipWs();
      const dm = /^@[A-Za-z_$][\w$.]*/.exec(code.slice(k, k + 200));
      if (!dm) break;
      k += dm[0].length;
      skipWs();
      if (code[k] === '(') {
        k = skipParens(code, k);
        if (k === -1) break;
      }
    }
    if (k === -1) continue;
    const cm = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(
      code.slice(k, k + 300),
    );
    if (cm) found.push(cm[1]);
    else
      throw new Error(
        `@smrt decorator at offset ${m.index} is not followed by a class declaration`,
      );
  }
  return found;
}

