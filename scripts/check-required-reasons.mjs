#!/usr/bin/env node
/**
 * Rule 1 check (happyvertical/smrt#4923, policy #4920): a smrt package makes a
 * field required only when its own code would be wrong or unsafe without it,
 * and the field says why with `requiredFor`.
 *
 *   @field({ required: true, requiredFor: 'identity' })
 *
 * Values: identity, tenant-scope, idempotency, workflow-state, system-table.
 * The option is carried into the manifest (`_meta.requiredFor`).
 *
 * What this script does:
 *   - Reads every `packages/<pkg>/src/**\/*.ts` (tests, fixtures and `dist`
 *     excluded) and finds each property decorator whose options literal sets
 *     `required: true`.
 *   - Fails when that field has no valid `requiredFor` and is not in the
 *     baseline, and names the file, class and field.
 *   - Fails when `requiredFor` is not one of the allowed values, or is set on
 *     a field that is not required.
 *   - The baseline (`scripts/required-reasons-baseline.json`) lists today's
 *     unexplained fields. It may only shrink. An entry whose field now has a
 *     reason (or no longer exists) is stale and fails until it is removed:
 *     `--prune` removes stale entries. Nothing here ever adds an entry.
 *   - `--against <git ref>` also fails when the baseline holds an entry the
 *     ref's baseline does not (the baseline grew).
 *
 * It does not judge whether a stated reason is true. Review does that.
 *
 * Usage: node scripts/check-required-reasons.mjs [--prune | --init] [--against <ref>]
 *        [--root <repo root>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_FOR_VALUES = [
  'identity',
  'tenant-scope',
  'idempotency',
  'workflow-state',
  'system-table',
];

const BASELINE_PATH = 'scripts/required-reasons-baseline.json';
const MODIFIERS = new Set([
  'declare',
  'override',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'accessor',
  'abstract',
]);
const IDENT = /[A-Za-z_$][\w$]*/y;

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

function prevSignificant(src, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  return k >= 0 ? src[k] : '';
}

function regexAllowed(src, i) {
  const prev = prevSignificant(src, i);
  if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)) return true;
  // `return /x/`, `typeof /x/` and similar keywords.
  const before = src.slice(Math.max(0, i - 8), i).trimEnd();
  return /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw)$/.test(before);
}

function skipString(src, i) {
  const quote = src[i];
  let k = i + 1;
  while (k < src.length && src[k] !== quote) {
    if (src[k] === '\\') k++;
    if (src[k] === '\n') break;
    k++;
  }
  return k + 1;
}

function skipTemplate(src, i) {
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

function skipRegex(src, i) {
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

/** Top-level `key: value` pairs of an object literal's inner text. */
export function topLevelProperties(inner) {
  const props = [];
  let depthStart = 0;
  let i = 0;
  const push = (end) => {
    const part = inner.slice(depthStart, end).trim();
    if (!part) return;
    const m = /^(?:\.\.\.|(['"]?)([\w$-]+)\1\s*(:|,|$))/.exec(part);
    if (part.startsWith('...')) {
      props.push({ key: '...', value: part.slice(3).trim() });
    } else if (m) {
      const colon = part.indexOf(':');
      props.push(
        colon === -1
          ? { key: m[2], value: m[2] }
          : { key: m[2], value: part.slice(colon + 1).trim() },
      );
    }
  };
  while (i < inner.length) {
    const c = inner[i];
    if (c === "'" || c === '"') i = skipString(inner, i);
    else if (c === '`') i = skipTemplate(inner, i);
    else if (c === '/' && regexAllowed(inner, i)) i = skipRegex(inner, i);
    else if (c === '(' || c === '[' || c === '{') {
      const close = matchBracket(inner, i);
      i = close === -1 ? inner.length : close + 1;
    } else if (c === ',') {
      push(i);
      depthStart = i + 1;
      i++;
    } else i++;
  }
  push(inner.length);
  return props;
}

function stringLiteral(value) {
  const m = /^(['"`])([^'"`\\]*)\1$/.exec(value.trim());
  return m ? m[2] : undefined;
}

/**
 * Every decorated property in `source` whose decorator options literal states
 * `required: true`. Each entry: class, field, requiredFor (the literal, or
 * `null` when absent, or `undefined` when present but not a plain string),
 * line.
 */
export function findRequiredFields(source) {
  const src = maskComments(source);
  const found = [];
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  const classes = [];
  for (let m = classRe.exec(src); m; m = classRe.exec(src)) {
    classes.push({ name: m[1], at: m.index });
  }
  const decoRe = /@([A-Za-z_$][\w$.]*)\s*\(/g;
  for (let m = decoRe.exec(src); m; m = decoRe.exec(src)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src, open);
    if (close === -1) continue;
    const args = src.slice(open + 1, close);
    // The options object is the last object-literal argument.
    let objStart = -1;
    for (let k = 0; k < args.length; k++) {
      const c = args[k];
      if (c === "'" || c === '"') k = skipString(args, k) - 1;
      else if (c === '`') k = skipTemplate(args, k) - 1;
      else if (c === '{') {
        objStart = k;
        const end = matchBracket(args, k);
        if (end === -1) break;
        k = end;
      } else if (c === '(' || c === '[') {
        const end = matchBracket(args, k);
        if (end === -1) break;
        k = end;
      }
    }
    if (objStart === -1) continue;
    const objEnd = matchBracket(args, objStart);
    if (objEnd === -1) continue;
    const props = topLevelProperties(args.slice(objStart + 1, objEnd));
    const required = props.find((p) => p.key === 'required');
    const reason = props.find((p) => p.key === 'requiredFor');
    const requiredTrue = required?.value === 'true';
    if (!requiredTrue && !reason) continue;

    // The decorated property: skip further decorators and modifiers.
    let pos = close + 1;
    for (;;) {
      while (pos < src.length && /\s/.test(src[pos])) pos++;
      if (src[pos] === '@') {
        const nm = /@[A-Za-z_$][\w$.]*\s*/y;
        nm.lastIndex = pos;
        const hit = nm.exec(src);
        if (!hit) break;
        pos += hit[0].length;
        if (src[pos] === '(') {
          const end = matchBracket(src, pos);
          if (end === -1) break;
          pos = end + 1;
        }
        continue;
      }
      IDENT.lastIndex = pos;
      const word = IDENT.exec(src);
      if (word && MODIFIERS.has(word[0])) {
        pos += word[0].length;
        continue;
      }
      break;
    }
    IDENT.lastIndex = pos;
    const name = IDENT.exec(src);
    if (!name) continue;
    let owner = '<unknown>';
    for (const c of classes) if (c.at < m.index) owner = c.name;
    const line = source.slice(0, m.index).split('\n').length;
    found.push({
      class: owner,
      field: name[0],
      line,
      required: requiredTrue,
      requiredFor: reason
        ? (stringLiteral(reason.value) ?? undefined)
        : null,
    });
  }
  return found;
}

function isSourceFile(rel) {
  if (!rel.endsWith('.ts') || rel.endsWith('.d.ts')) return false;
  return !/(?:^|\/)(?:node_modules|dist|__tests__|__mocks__|__test-[^/]*|fixtures|test-fixtures)\//.test(rel) &&
    !/\.(?:test|spec|optional\.test)\.ts$/.test(rel) &&
    !/\.(?:test|spec)\.[a-z]+\.ts$/.test(rel);
}

function* walk(dir, base) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else if (entry.isFile()) yield full;
  }
}

/** Scan all packages. Returns { entries: [{key, file, class, field, line, status}] }. */
export function scanPackages(root) {
  const packagesDir = join(root, 'packages');
  const entries = [];
  const problems = [];
  for (const pkg of readdirSync(packagesDir).sort()) {
    const srcDir = join(packagesDir, pkg, 'src');
    if (!existsSync(srcDir)) continue;
    for (const file of [...walk(srcDir, root)].sort()) {
      const rel = relative(root, file).split(sep).join('/');
      if (!isSourceFile(rel.slice(`packages/${pkg}/`.length))) continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes('required')) continue;
      for (const f of findRequiredFields(text)) {
        const key = `${rel}#${f.class}.${f.field}`;
        const where = `${rel}:${f.line} ${f.class}.${f.field}`;
        if (f.requiredFor !== null && !f.required) {
          problems.push(`${where}: requiredFor is set on a field that is not required: true.`);
          continue;
        }
        if (f.requiredFor === undefined) {
          problems.push(`${where}: requiredFor must be a string literal, one of ${REQUIRED_FOR_VALUES.join(', ')}.`);
          continue;
        }
        if (f.requiredFor !== null && !REQUIRED_FOR_VALUES.includes(f.requiredFor)) {
          problems.push(`${where}: requiredFor '${f.requiredFor}' is not one of ${REQUIRED_FOR_VALUES.join(', ')}.`);
          continue;
        }
        entries.push({
          key,
          file: rel,
          line: f.line,
          class: f.class,
          field: f.field,
          explained: f.requiredFor !== null,
        });
      }
    }
  }
  return { entries, problems };
}

function readBaseline(root) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return [];
  const json = JSON.parse(readFileSync(path, 'utf8'));
  return json.unexplained ?? [];
}

function writeBaseline(root, keys) {
  const body = {
    comment:
      'Required fields in smrt packages with no requiredFor reason (#4923). This list may only shrink: ' +
      'give a field a reason or relax it, then run `node scripts/check-required-reasons.mjs --prune`.',
    unexplained: [...keys].sort(),
  };
  mkdirSync(dirname(join(root, BASELINE_PATH)), { recursive: true });
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`);
}

/** Evaluate scan results against a baseline. Pure. */
export function evaluate({ entries, problems }, baseline, previousBaseline) {
  const errors = [...problems];
  const unexplained = entries.filter((e) => !e.explained);
  const unexplainedKeys = new Set(unexplained.map((e) => e.key));
  const baselineSet = new Set(baseline);
  for (const e of unexplained) {
    if (!baselineSet.has(e.key)) {
      errors.push(
        `${e.file}:${e.line} ${e.class}.${e.field} is required with no reason. ` +
          `Add requiredFor (${REQUIRED_FOR_VALUES.join(' | ')}) if smrt's own code needs it, or make it optional.`,
      );
    }
  }
  const stale = baseline.filter((k) => !unexplainedKeys.has(k));
  for (const k of stale) {
    errors.push(
      `Stale baseline entry ${k}: the field now has a reason or is gone. Remove it (node scripts/check-required-reasons.mjs --prune).`,
    );
  }
  if (previousBaseline) {
    const before = new Set(previousBaseline);
    for (const k of baseline) {
      if (!before.has(k)) {
        errors.push(`Baseline grew: ${k} is not in the base baseline. The baseline may only shrink.`);
      }
    }
  }
  return { errors, stale, unexplainedCount: unexplained.length };
}

function baselineAt(root, ref) {
  try {
    const text = execFileSync('git', ['show', `${ref}:${BASELINE_PATH}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(text).unexplained ?? [];
  } catch {
    return null;
  }
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const [, value] = args.splice(i, 2);
    return value;
  };
  const against = take('--against');
  const rootArg = take('--root');
  const prune = args.includes('--prune');
  const root = resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

  const scan = scanPackages(root);
  if (args.includes('--init')) {
    // One time: records today's unexplained fields. Refused once a baseline
    // exists, so it cannot be used to grow one.
    if (existsSync(join(root, BASELINE_PATH))) {
      console.error('check-required-reasons: a baseline already exists; it may only shrink (--prune).');
      process.exit(1);
    }
    if (scan.problems.length > 0) {
      for (const p of scan.problems) console.error(`  ${p}`);
      process.exit(1);
    }
    writeBaseline(root, scan.entries.filter((e) => !e.explained).map((e) => e.key));
    console.log('check-required-reasons: wrote the initial baseline.');
    return;
  }
  const baseline = readBaseline(root);
  const previous = against ? baselineAt(root, against) : undefined;
  const result = evaluate(scan, baseline, previous ?? undefined);

  if (prune) {
    const keep = baseline.filter((k) => !result.stale.includes(k));
    writeBaseline(root, keep);
    console.log(`check-required-reasons: pruned ${result.stale.length} stale baseline entr${result.stale.length === 1 ? 'y' : 'ies'}.`);
    result.errors = result.errors.filter((e) => !e.startsWith('Stale baseline entry'));
  }
  if (result.errors.length > 0) {
    console.error(`check-required-reasons: ${result.errors.length} problem(s) (#4923).`);
    for (const e of result.errors.slice(0, 40)) console.error(`  ${e}`);
    if (result.errors.length > 40) console.error(`  ... and ${result.errors.length - 40} more`);
    process.exit(1);
  }
  const explained = scan.entries.length - result.unexplainedCount;
  console.log(
    `check-required-reasons: ${explained} required field(s) state a reason; ${result.unexplainedCount} unexplained, all in the baseline.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

export { writeBaseline, readBaseline };
