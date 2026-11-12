/**
 * Shared helpers for the source-scanning gates under scripts/ (#4923, #4930):
 * comment masking, bracket matching that skips strings and regex literals, a
 * directory walk, and reading a file from a git ref.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Replace comments with spaces (same length), leaving strings intact. */
export function maskComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const templateDepth = [];
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
    } else if (c === "'" || c === '"') {
      i = skipString(src, i);
    } else if (c === '`') {
      i = skipTemplate(src, i);
    } else if (c === '/' && regexAllowed(src, i)) {
      i = skipRegex(src, i);
    } else {
      i++;
    }
  }
  void templateDepth;
  return out.join('');
}

export function prevSignificant(src, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  return k >= 0 ? src[k] : '';
}

export function regexAllowed(src, i) {
  const prev = prevSignificant(src, i);
  if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)) return true;
  // `return /x/`, `typeof /x/` and similar keywords.
  const before = src.slice(Math.max(0, i - 8), i).trimEnd();
  return /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw)$/.test(before);
}

export function skipString(src, i) {
  const quote = src[i];
  let k = i + 1;
  while (k < src.length && src[k] !== quote) {
    if (src[k] === '\\') k++;
    if (src[k] === '\n') break;
    k++;
  }
  return k + 1;
}

export function skipTemplate(src, i) {
  let k = i + 1;
  while (k < src.length && src[k] !== '`') {
    if (src[k] === '\\') {
      k += 2;
      continue;
    }
    if (src[k] === '$' && src[k + 1] === '{') {
      let depth = 1;
      k += 2;
      while (k < src.length && depth > 0) {
        const c = src[k];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === "'" || c === '"') {
          k = skipString(src, k);
          continue;
        } else if (c === '`') {
          k = skipTemplate(src, k);
          continue;
        }
        k++;
      }
      continue;
    }
    k++;
  }
  return k + 1;
}

export function skipRegex(src, i) {
  let k = i + 1;
  let inClass = false;
  while (k < src.length && src[k] !== '\n') {
    const c = src[k];
    if (c === '\\') k++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    k++;
  }
  return k + 1;
}

/**
 * Index of the bracket that closes the one at `open` (comments already
 * masked), skipping strings, templates and regex literals.
 */
export function matchBracket(src, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[src[open]]];
  let i = open + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === '/' && regexAllowed(src, i)) {
      i = skipRegex(src, i);
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
    i++;
  }
  return -1;
}

export function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** Text of `path` at git `ref` in `root`, or `null` when it does not exist there. */
export function fileAtRef(root, ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}
