#!/usr/bin/env node
/**
 * Find classes that extend a class of the same simple name imported from
 * another package and add the `replaceParent` option they now have to declare
 * in `@smrt()` (#5143).
 *
 *   node scripts/codemod-same-name-subclass.mjs [dir ...]            report
 *   node scripts/codemod-same-name-subclass.mjs --write [dir ...]    add `replaceParent: true`
 *
 * With no directory it scans every package under `packages/` of this
 * repository (tests and generators included; build output is skipped). It
 * has no dependencies, so an application can run a copy against its own
 * sources. `replaceParent: true` keeps what such a class did before the rule
 * (it replaced its parent).
 *
 * It recognises class declarations and class expressions
 * (`const X = class X extends Base {}`), registered with a `@smrt()`
 * decorator or the call form `smrt({...})(X)`, under any local name the file
 * imports `smrt` as. A parent imported from a relative module counts when
 * that module re-exports it from another package (followed through further
 * relative re-exports); a relative import that ends at a class declared in
 * the scanned sources is the same package and is not reported. Options passed
 * as an expression, and a class with no registration in its own file, are
 * reported for manual review and left alone.
 *
 * Classes inside string and template literals (source text a test hands to
 * a scanner) are reported as `in-string` and never edited. A call-form
 * registration binds to the declaration in its own lexical block; two
 * registrations it cannot tell apart are reported `ambiguous` and left alone.
 *
 * The exit code is 1 while any reported class still lacks the option, in
 * report mode and after `--write` alike (`in-string` never counts). It is a text scan, not a compiler:
 * registration built dynamically (a computed class, a helper that calls
 * `smrt()` for you) is not seen, and such a class fails when it registers
 * (`CONFIG_SAME_NAME_SUBCLASS_UNDECLARED`), not necessarily at build time.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['node_modules', 'dist', 'build', '.svelte-kit', '.smrt', '.git', '.turbo', 'coverage']);
const IMPORT = /import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+))\s+from\s+['"]([^'"]+)['"]/gs;
const CLASS = /(^|\n)([ \t]*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)(?:<[^>{]*>)?\s+extends\s+([\w$.]+)/g;
const CLASS_EXPRESSION = /(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:\{\s*([\w$]+)\s*:\s*)?class(?:\s+([\w$]+))?(?:<[^>{]*>)?\s+extends\s+([\w$.]+)/g;
const EXPORT_ALIAS = /export\s*\{([^}]*)\}(?!\s*from)/g;
const RE_EXPORT = /export\s*(?:\{([^}]*)\}|\*)\s*from\s*['"]([^'"]+)['"]/g;
const EXTENSIONS = ['', '.ts', '.mts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'];

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(?:ts|mts|tsx|js|mjs|jsx)$/.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

function specifiers(list) {
  return (list ?? '')
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((part) => {
      const [original, alias] = part.split(/\s+as\s+/).map((name) => name.trim());
      return { original, alias: alias ?? original };
    });
}

/** The module a relative specifier names, if it exists on disk. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(/\.(?:m?js|jsx)$/, '');
  for (const candidate of [...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => stem + ext)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Where `name` exported by the relative module `specifier` comes from: another
 * package (`{ original, from }`), or `undefined` when it is declared in this
 * package or cannot be followed.
 */
function followRelative(fromFile, specifier, name, depth = 0) {
  if (depth > 8) return undefined;
  const file = resolveRelative(fromFile, specifier);
  if (!file) return undefined;
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(RE_EXPORT)) {
    const [, list, from] = match;
    const exported = list === undefined ? [{ original: name, alias: name }] : specifiers(list);
    for (const { original, alias } of exported) {
      if (alias !== name) continue;
      if (!from.startsWith('.')) {
        // `export * from 'pkg'` cannot answer for a name declared here.
        if (list === undefined && declaresLocally(source, name)) continue;
        return { original, from };
      }
      const next = followRelative(file, from, original, depth + 1);
      if (next) return next;
    }
  }
  // A re-export of an import (`import { X } from 'pkg'; export { X }`).
  for (const match of source.matchAll(IMPORT)) {
    for (const { original, alias } of specifiers(match[1])) {
      if (alias !== name || !new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(source)) continue;
      if (!match[3].startsWith('.')) return { original, from: match[3] };
      return followRelative(file, match[3], original, depth + 1);
    }
  }
  return undefined;
}

/**
 * The properties an options object literal passed in the call parentheses
 * `open`..`close` declares at its top level, read as code: each key (bare or
 * quoted) mapped to where its value starts. A key inside a comment, a string
 * value or a nested object does not count.
 */
function optionKeys(source, map, open, close) {
  const keys = new Map();
  let depth = 0;
  let previous = '';
  for (let i = open; i < close; i++) {
    const c = source[i];
    if (map.inText(i)) {
      // A quoted key: a string that starts a top-level property.
      if (depth === 2 && (c === "'" || c === '"') && !map.inText(i - 1) && (previous === '{' || previous === ',')) {
        let end = i + 1;
        while (end < close && map.inText(end) && source[end] !== c) end += source[end] === '\\' ? 2 : 1;
        const colon = /^\s*:/.exec(source.slice(end + 1, close));
        if (colon) keys.set(source.slice(i + 1, end), end + 1 + colon[0].length);
        previous = c;
        i = end;
      }
      continue;
    }
    if (/\s/.test(c)) continue;
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (depth === 2 && (previous === '{' || previous === ',') && /[A-Za-z_$]/.test(c)) {
      const key = /^([A-Za-z_$][\w$]*)\s*:/.exec(source.slice(i, close));
      if (key) keys.set(key[1], i + key[0].length);
      // Shorthand (`{ replaceParent }`) declares the option with a variable.
      else {
        const shorthand = /^([A-Za-z_$][\w$]*)\s*(?=[,}])/.exec(source.slice(i, close));
        if (shorthand) keys.set(shorthand[1], i + shorthand[0].length);
      }
    } else if (depth === 2 && (previous === '{' || previous === ',') && c === '.' && source.startsWith('...', i)) {
      // A spread can carry any option: the literal does not decide on its own.
      keys.dynamic = true;
      keys.lastSpread = i;
    }
    previous = c;
  }
  return keys;
}

/**
 * Whether the call parentheses `open`..`close` hold exactly one object
 * literal (or nothing): the only options expression whose keys can be read
 * from the text. A conditional, a variable or a call is not one.
 */
function isOptionsLiteral(source, map, open, close) {
  const body = source.slice(open + 1, close);
  if (body.trim() === '') return true;
  const lead = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(body)[0].length;
  const brace = open + 1 + lead;
  if (source[brace] !== '{' || map.inText(brace)) return false;
  let depth = 0;
  for (let i = brace; i < close; i++) {
    if (map.inText(i)) continue;
    if ('{[('.includes(source[i])) depth++;
    else if ('}])'.includes(source[i]) && --depth === 0) {
      const rest = source.slice(i + 1, close).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      return /^\s*,?\s*$/.test(rest);
    }
  }
  return false;
}

/** Whether a module declares `name` itself. */
function declaresLocally(source, name) {
  return new RegExp(`(?:class|function|const|let|var)\\s+${name}\\b`).test(source);
}

/**
 * Where the code is: string, template and comment ranges (never edited or
 * matched as code), and the brace blocks of the code, so a registration is
 * bound to the declaration in its own lexical scope. A template literal is
 * treated as text throughout, including its `${...}` parts.
 */
function lexicalMap(source) {
  const text = new Uint8Array(source.length);
  const blocks = [];
  const stack = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    let end = -1;
    if (c === '/' && next === '/') {
      end = source.indexOf('\n', i);
      if (end < 0) end = source.length;
    } else if (c === '/' && next === '*') {
      end = source.indexOf('*/', i + 2);
      end = end < 0 ? source.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      end = i + 1;
      while (end < source.length && source[end] !== c) {
        if (source[end] === '\\') end++;
        if (c !== '`' && source[end] === '\n') break;
        end++;
      }
      end = Math.min(end + 1, source.length);
    }
    if (end >= 0) {
      text.fill(1, i, end);
      i = end - 1;
      continue;
    }
    if (c === '{') stack.push(i);
    if (c === '}' && stack.length) blocks.push([stack.pop(), i]);
  }
  return {
    inText: (pos) => text[pos] === 1,
    /** The innermost code block containing `pos`, or the whole file. */
    blockOf: (pos) =>
      blocks
        .filter(([open, close]) => open < pos && pos < close)
        .reduce((inner, block) => (block[0] > inner[0] ? block : inner), [-1, source.length]),
  };
}

/** The balanced `(...)` starting at `open` (the index of `(`), or -1. */
function closingParen(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** The decorator `@<alias>(...)` directly above the class at `classStart`, if any. */
function decoratorBefore(source, classStart, aliases, map) {
  const head = source.slice(0, classStart);
  let best;
  for (const alias of aliases) {
    let at = head.lastIndexOf(`@${alias}(`);
    while (at >= 0 && map.inText(at)) at = head.lastIndexOf(`@${alias}(`, at - 1);
    if (at >= 0 && (!best || at > best.start)) best = { start: at, open: at + alias.length + 1 };
  }
  if (!best) return undefined;
  const end = closingParen(source, best.open);
  if (end < 0 || end > classStart) return undefined;
  // Only other decorators, comments and whitespace may follow it.
  let rest = source.slice(end + 1, classStart).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  for (let previous = ''; rest !== previous; ) {
    previous = rest;
    rest = rest.replace(/^\s*@[\w$.]+(?:\((?:[^()]|\([^()]*\))*\))?/, '');
  }
  return rest.trim() === '' ? { open: best.open, end } : undefined;
}

/**
 * The call-form registration `<alias>(...)(binding)` of the class declared at
 * `start`: a call in code, in the declaration's own block, that no nearer
 * declaration of the same name shadows. More than one is ambiguous.
 */
function callRegistration(source, binding, aliases, map, start) {
  const [scopeOpen, scopeClose] = map.blockOf(start);
  const declares = new RegExp(`(?:class|const|let|var|function)\\s+${binding.replace(/\$/g, '\\$')}\\b`);
  const found = [];
  for (const alias of aliases) {
    const pattern = new RegExp(`(?<![\\w$.@])${alias.replace(/\$/g, '\\$')}\\(`, 'g');
    for (const match of source.matchAll(pattern)) {
      if (map.inText(match.index) || match.index < scopeOpen || match.index > scopeClose) continue;
      const open = match.index + alias.length;
      const end = closingParen(source, open);
      if (end < 0) continue;
      const after = /^\s*\(\s*([\w$]+)\s*,?\s*\)/.exec(source.slice(end + 1));
      if (after?.[1] !== binding) continue;
      // A block between the call and the declaration's scope that declares
      // its own binding of this name owns the call.
      let shadowed = false;
      for (let [open2, close2] = map.blockOf(match.index); open2 > scopeOpen; [open2, close2] = map.blockOf(open2)) {
        const body = source.slice(open2, close2);
        if (declares.test(body) && !(open2 < start && start < close2)) shadowed = true;
      }
      if (!shadowed) found.push({ open, end });
    }
  }
  return found.length > 1 ? { ambiguous: true } : found[0];
}

/**
 * Same-named cross-package subclasses in one source file.
 * `choice` (`true`/`false`) also returns the source with the option added.
 * `filePath` lets a relative import be followed to the package it re-exports.
 */
export function codemodSource(source, choice, filePath) {
  const map = lexicalMap(source);
  // Imports in code bind the file's classes; those inside strings or
  // templates (fixture sources) only describe classes in those strings.
  const imports = new Map();
  const namespaces = new Map();
  const textImports = new Map();
  const textNamespaces = new Map();
  const smrtAliases = new Set(['smrt']);
  for (const match of source.matchAll(IMPORT)) {
    const inText = map.inText(match.index);
    if (match[2]) (inText ? textNamespaces : namespaces).set(match[2], match[3]);
    for (const { original, alias } of specifiers(match[1])) {
      (inText ? textImports : imports).set(alias, { original, from: match[3] });
      if (original === 'smrt' && !inText) smrtAliases.add(alias);
    }
  }
  const exported = new Map();
  for (const match of source.matchAll(EXPORT_ALIAS)) {
    if (map.inText(match.index)) continue;
    for (const { original, alias } of specifiers(match[1])) {
      if (alias !== original) exported.set(original, alias);
    }
  }
  const classes = [];
  for (const match of source.matchAll(CLASS)) {
    const [, lead, , name, parent] = match;
    classes.push({ start: match.index + lead.length, binding: name, name, parent, expression: false });
  }
  for (const match of source.matchAll(CLASS_EXPRESSION)) {
    const [, binding, property, className, parent] = match;
    classes.push({ start: match.index, binding, name: className ?? property ?? binding, parent, expression: true });
  }
  classes.sort((a, b) => a.start - b.start);

  const findings = [];
  const edits = [];
  for (const { start, binding, name, parent, expression } of classes) {
    const [scope, member] = parent.includes('.') ? parent.split('.') : [];
    if (map.inText(start)) {
      // Source text a test hands to a scanner: reported, never edited.
      const original = member ? member : textImports.get(parent)?.original;
      const from = member ? textNamespaces.get(scope) : textImports.get(parent)?.from;
      if (original === name && from && !from.startsWith('.')) {
        findings.push({
          name,
          parent: `${from}:${original}`,
          line: source.slice(0, start).split('\n').length,
          status: 'in-string',
        });
      }
      continue;
    }
    let imported = member
      ? namespaces.has(scope) && { original: member, from: namespaces.get(scope) }
      : imports.get(parent);
    if (!imported) continue;
    if (imported.from.startsWith('.')) {
      // Same package unless the module re-exports another package's class.
      imported = filePath ? followRelative(filePath, imported.from, imported.original) : undefined;
      if (!imported) continue;
    }
    const call = () => callRegistration(source, binding, smrtAliases, map, start);
    const found = expression ? call() : (decoratorBefore(source, start, smrtAliases, map) ?? call());
    const registration = found?.ambiguous ? undefined : found;
    const literal = registration ? isOptionsLiteral(source, map, registration.open, registration.end) : true;
    const keys = registration && literal ? optionKeys(source, map, registration.open, registration.end) : new Map();
    const declaredName = keys.has('name')
      ? /^\s*['"]([\w$]+)['"]/.exec(source.slice(keys.get('name'), registration.end))?.[1]
      : undefined;
    const publicName = declaredName ?? exported.get(binding) ?? name;
    if (imported.original !== publicName) continue;
    const line = source.slice(0, start).split('\n').length;
    const finding = { name: publicName, parent: `${imported.from}:${imported.original}`, line };
    if (!registration) {
      findings.push({ ...finding, status: found?.ambiguous ? 'ambiguous' : 'no-registration' });
      continue;
    }
    // Options that are not one object literal (a conditional, a variable, a
    // spread) cannot be decided from the text: reported, never edited, and
    // counted as still needing the option.
    // A spread after the key can override it; one before it cannot.
    if (!literal || (keys.dynamic && (!keys.has('replaceParent') || keys.lastSpread > keys.get('replaceParent')))) {
      findings.push({ ...finding, status: 'unsupported-options' });
      continue;
    }
    if (keys.has('replaceParent')) {
      findings.push({ ...finding, status: 'declared' });
      continue;
    }
    findings.push({ ...finding, status: 'missing' });
    if (choice === undefined) continue;
    const open = registration.open + 1;
    const body = source.slice(open, registration.end);
    const option = `replaceParent: ${choice}`;
    if (body.trim() === '' || /^\{\s*\}$/.test(body.trim())) {
      edits.push({ start: open, end: registration.end, text: `{ ${option} }` });
    } else if (body.trimStart().startsWith('{')) {
      const brace = open + body.indexOf('{') + 1;
      const multiline = /^[ \t]*\n([ \t]*)/.exec(source.slice(brace));
      edits.push({
        start: brace,
        end: brace,
        text: multiline ? `\n${multiline[1]}${option},` : ` ${option},`,
      });
    } else {
      // Options passed as an expression cannot be edited safely.
      findings[findings.length - 1].status = 'unsupported-options';
    }
  }
  let next = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }
  return { source: next, findings };
}

export function main(argv, root = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const write = argv.includes('--write');
  // Only replacement is supported for a same-named subclass (#5143).
  const choice = write ? true : undefined;
  const given = argv.filter((arg) => !arg.startsWith('--'));
  const dirs = given.length
    ? given.map((dir) => resolve(dir))
    : readdirSync(join(root, 'packages'))
        .map((name) => join(root, 'packages', name))
        .filter((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } });
  let pending = 0;
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) {
      const before = readFileSync(file, 'utf8');
      const result = codemodSource(before, choice, file);
      for (const finding of result.findings) {
        const edited = finding.status === 'missing' && write;
        // Strings are fixture sources, reported for information only.
        if (finding.status !== 'declared' && finding.status !== 'in-string' && !edited) pending++;
        console.log(
          `${relative(process.cwd(), file)}:${finding.line} ${finding.name} extends ${finding.parent}: ${
            edited ? `added replaceParent: ${choice}` : finding.status
          }`,
        );
      }
      if (write && result.source !== before) writeFileSync(file, result.source);
    }
  }
  if (pending > 0) {
    console.error(`${pending} same-named subclass(es) still need replaceParent in @smrt().`);
  }
  return pending > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
