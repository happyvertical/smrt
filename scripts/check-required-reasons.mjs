#!/usr/bin/env node
/**
 * Rule 1 check (happyvertical/smrt#4923, policy #4920): a smrt package makes a
 * field required only when its own code would be wrong or unsafe without it,
 * and the field says why with `requiredFor`.
 *
 *   @field({ required: true, requiredFor: 'identity' })
 *
 * Values: identity, tenant-scope, idempotency, workflow-state, system-table,
 * integrity, authentication.
 * The option is carried into the manifest (`_meta.requiredFor`).
 *
 * Which fields it covers (#4935, P11): the ones a caller must supply. At save
 * time `required` means the instance value must not be null, undefined or an
 * empty string, so a class initializer that holds a real value (`= 0`,
 * `= false`, `= 'active'`) already satisfies it and the caller supplies
 * nothing. A decorator `default` option does NOT put a value on the instance,
 * so it does not count. `required` is written (`required: true`) or inferred
 * from the TypeScript declaration (no initializer, not `?`), as the scanner
 * does (`manifest-adapter.ts` `inferFieldType`). A required `@tenantId()` is
 * explained by itself (tenant-scope).
 *
 * What this script does:
 *   - Reads every `packages/<pkg>/src/**\/*.ts` (tests, fixtures and `dist`
 *     excluded) and finds each decorated property that is required, written
 *     or inferred.
 *   - Fails when a field the caller must supply has no valid `requiredFor`
 *     and is not in the baseline, and names the file, class and field.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fileAtRef,
  matchBracket,
  maskComments,
  regexAllowed,
  skipRegex,
  skipString,
  skipTemplate,
  walk,
} from './lib/source-scan.mjs';

export { maskComments, matchBracket };

export const REQUIRED_FOR_VALUES = [
  'identity',
  'tenant-scope',
  'idempotency',
  'workflow-state',
  'system-table',
  'integrity',
  'authentication',
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

const FIELD_DECORATORS = new Set(['field', 'foreignKey', 'crossPackageRef', 'meta', 'tenantId']);
const EMPTY_INITIALIZERS = new Set(["''", '""', '``', 'null', 'undefined']);

/**
 * What follows a property name: `?` / `!` marker and the initializer text.
 * Returns { optional, initializer } (initializer is null when there is none).
 */
function readDeclarationTail(src, pos) {
  let optional = false;
  if (src[pos] === '?') {
    optional = true;
    pos++;
  } else if (src[pos] === '!') pos++;
  let depth = 0;
  let i = pos;
  let init = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"') i = skipString(src, i) - 1;
    else if (c === '`') i = skipTemplate(src, i) - 1;
    else if (c === '(' || c === '[' || c === '{') {
      const close = matchBracket(src, i);
      if (close === -1) break;
      i = close;
    } else if (c === '<') depth++;
    else if (c === '>' && src[i - 1] !== '=') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ';') break;
    else if (depth === 0 && c === '=' && src[i + 1] !== '>' && src[i + 1] !== '=') {
      // Initializer runs to the next top-level `;` or a newline that ends it.
      let j = i + 1;
      for (; j < src.length; j++) {
        const d = src[j];
        if (d === "'" || d === '"') j = skipString(src, j) - 1;
        else if (d === '`') j = skipTemplate(src, j) - 1;
        else if (d === '(' || d === '[' || d === '{') {
          const close = matchBracket(src, j);
          if (close === -1) break;
          j = close;
        } else if (d === ';') break;
        else if (d === '\n') {
          const rest = src.slice(j + 1).trimStart();
          const prev = src.slice(i + 1, j).trimEnd().slice(-1);
          if (!/^[.?:+\-*/%&|<>=]/.test(rest) && !/[.?:+\-*/%&|<>=,(]$/.test(prev)) break;
        }
      }
      init = src.slice(i + 1, j).trim();
      break;
    } else if (depth === 0 && c === '\n') {
      const rest = src.slice(i + 1).trimStart();
      if (!/^[|&]/.test(rest) && !/[|&:]$/.test(src.slice(pos, i).trimEnd())) break;
    }
  }
  return { optional, initializer: init };
}

/**
 * Every decorated property in `source` that is required (written or
 * inferred) or states a `requiredFor`. Each entry: class, field,
 * requiredFor (the literal, or `null` when absent, or `undefined` when
 * present but not a plain string), line, required (the field is required),
 * demanded (a caller must supply it: required and the class initializer does
 * not hold a real value), implicit (a required `@tenantId()`, explained by
 * itself).
 */
export function findRequiredFields(source) {
  const src = maskComments(source);
  const found = [];
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  const classes = [];
  for (let m = classRe.exec(src); m; m = classRe.exec(src)) {
    classes.push({ name: m[1], at: m.index });
  }
  const decoRe = /@([A-Za-z_$][\w$.]*)\s*(\(|(?=\s))/g;
  const records = new Map();
  for (let m = decoRe.exec(src); m; m = decoRe.exec(src)) {
    const decoName = m[1].split('.').pop();
    let props = [];
    let close = m.index + m[0].length - 1;
    if (m[2] === '(') {
      const open = m.index + m[0].length - 1;
      close = matchBracket(src, open);
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
      if (objStart !== -1) {
        const objEnd = matchBracket(args, objStart);
        if (objEnd === -1) continue;
        props = topLevelProperties(args.slice(objStart + 1, objEnd));
      }
    } else if (!FIELD_DECORATORS.has(decoName)) continue;
    const isFieldDecorator = FIELD_DECORATORS.has(decoName);
    const statesIt = props.some((p) => p.key === 'requiredFor') ||
      props.find((p) => p.key === 'required')?.value === 'true';
    if (!isFieldDecorator && !statesIt) continue;

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
    // A property is a name followed by `?`, `!`, `:`, `=`, `;` or a line end.
    // Anything else (`get x()`, `fields` in prose inside a template string)
    // is not a field.
    if (!/^[ \t]*(?:[?!:=;]|\r?\n|\}|$)/.test(src.slice(pos + name[0].length, pos + name[0].length + 40))) continue;
    // A property stacked under several decorators is visited once per
    // decorator; their options are read together.
    let rec = records.get(pos);
    if (!rec) {
      rec = { pos, name: name[0], at: m.index, decorators: [], props: [] };
      records.set(pos, rec);
    }
    rec.decorators.push(decoName);
    rec.props.push(...props);
    rec.at = Math.min(rec.at, m.index);
  }
  for (const rec of records.values()) {
    const { props, decorators } = rec;
    const required = props.find((p) => p.key === 'required');
    const reason = props.find((p) => p.key === 'requiredFor');
    const decoName = decorators.includes('tenantId')
      ? 'tenantId'
      : (decorators.find((d) => FIELD_DECORATORS.has(d)) ?? decorators[0]);
    const isFieldDecorator = FIELD_DECORATORS.has(decoName);
    const tail = readDeclarationTail(src, rec.pos + rec.name.length);
    const hasInitializer = tail.initializer !== null;
    const initializerHoldsValue =
      hasInitializer && !EMPTY_INITIALIZERS.has(tail.initializer);
    const nullable = props.find((p) => p.key === 'nullable')?.value === 'true';
    const hasDefaultOption = props.some((p) => p.key === 'default');
    let isRequired;
    if (required?.value === 'true') isRequired = true;
    else if (required?.value === 'false') isRequired = false;
    else if (decoName === 'tenantId') isRequired = !nullable;
    else if (isFieldDecorator) {
      isRequired = !nullable && !tail.optional && !hasInitializer && !hasDefaultOption;
    } else isRequired = false;
    if (!isRequired && !reason) continue;

    let owner = '<unknown>';
    for (const c of classes) if (c.at < rec.at) owner = c.name;
    const line = source.slice(0, rec.at).split('\n').length;
    found.push({
      class: owner,
      field: rec.name,
      line,
      required: isRequired,
      demanded: isRequired && !initializerHoldsValue,
      implicit: decoName === 'tenantId' && isRequired && !reason,
      requiredFor: reason ? (stringLiteral(reason.value) ?? undefined) : null,
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

/** Scan all packages. Returns { entries: [{key, file, class, field, line, status}] }. */
export function scanPackages(root) {
  const packagesDir = join(root, 'packages');
  const entries = [];
  const problems = [];
  for (const pkg of readdirSync(packagesDir).sort()) {
    const srcDir = join(packagesDir, pkg, 'src');
    if (!existsSync(srcDir)) continue;
    for (const file of [...walk(srcDir)].sort()) {
      const rel = relative(root, file).split(sep).join('/');
      if (!isSourceFile(rel.slice(`packages/${pkg}/`.length))) continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes('@')) continue;
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
        // Not demanded of the caller (a real class initializer satisfies it):
        // out of scope unless it states a reason.
        if (!f.demanded && f.requiredFor === null) continue;
        entries.push({
          key,
          file: rel,
          line: f.line,
          class: f.class,
          field: f.field,
          explained: f.requiredFor !== null || f.implicit,
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
  const previousText = against ? fileAtRef(root, against, BASELINE_PATH) : null;
  const previous = previousText ? (JSON.parse(previousText).unexplained ?? []) : undefined;
  const result = evaluate(scan, baseline, previous);

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
