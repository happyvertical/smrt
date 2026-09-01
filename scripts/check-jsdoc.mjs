#!/usr/bin/env node
/**
 * JSDoc ratchet for exported Svelte component props (issue #2583).
 *
 * Why this exists
 * ---------------
 * `svelte-package` preserves JSDoc written on a prop into the published
 * `.d.ts`, so one comment next to the prop reaches consumer editors, the
 * knowledge tooling, agent context, and the public component reference on
 * s-m-r-t.dev — which reads exactly these comments to fill its prop tables
 * (happyvertical/s-m-r-t.dev#224). A prop with no JSDoc is published as a name
 * and a type with nothing that says what it means.
 *
 * Roughly half the exported props in this repository already carry JSDoc, very
 * unevenly: some packages are complete, others are near zero. Gating all of it
 * at once would block unrelated work and get switched off, so this is a ratchet,
 * not a wall.
 *
 * How a package opts in
 * ---------------------
 * A package is REPORT-ONLY until it declares, in ITS OWN package.json:
 *
 *   "smrtJsdoc": "strict"
 *
 * Strict packages fail this check when an exported component's props are
 * undocumented. Everything else is listed and does not fail. Keeping the flag in
 * each package.json — rather than an allowlist in this file — means the backfill
 * (#2584) flips one package per pull request and concurrent PRs never conflict
 * on a shared line, the same arrangement `check-raw-primitives.mjs` uses.
 *
 * What counts
 * -----------
 * Only components a package actually exports through its `exports` map, and only
 * the members of their own exported `Props` interface. Props inherited from
 * `svelte/elements` are the framework's to document, not ours. `$$` internals,
 * index signatures, and `children` are skipped: a snippet slot named `children`
 * needs no sentence.
 *
 * Usage:
 *   node scripts/check-jsdoc.mjs              report every package
 *   node scripts/check-jsdoc.mjs --package X  report one package
 *   node scripts/check-jsdoc.mjs --strict-only  list only packages that gate
 *   node scripts/check-jsdoc.mjs --root DIR    scan a different repository root
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The check-standards CI job does not install workspace dependencies; it
// side-loads TypeScript and names it here, exactly as check-readmes.mjs expects.
const typescriptPath = process.env.SMRT_TYPESCRIPT_PATH;
const typescriptModule = typescriptPath
  ? await import(pathToFileURL(typescriptPath).href)
  : await import('typescript');
const ts = typescriptModule.default;

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
// `--root` lets the test drive a throwaway package tree; everything else
// resolves the repository from this file's own location as the sibling
// checkers do, so the command works from any directory.
const ROOT = rootFlag === -1 ? dirname(dirname(fileURLToPath(import.meta.url))) : argv[rootFlag + 1];
const PACKAGES = join(ROOT, 'packages');
const SKIPPED_PROPS = new Set(['children']);

/** Every string target in an exports value, however deeply the conditions nest. */
function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  return [];
}

/**
 * Components a package exports, as `[name, svelteFile]`.
 *
 * Barrels are read with the TypeScript parser rather than regexes: every valid
 * import and export spelling has to resolve, because a form this misses is a
 * component a strict package could leave undocumented and still pass.
 */
function exportedComponents(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  // Keyed by resolved path, not name: a package may export two different files
  // that share a basename through separate subpaths, and keying by name would
  // drop one of them from the gate entirely.
  const found = new Map();
  const seen = new Set();

  const asSvelte = (fromFile, specifier) =>
    resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));

  const followModule = (fromFile, specifier) => {
    const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) return visit(candidate);
    }
  };

  const visit = (file) => {
    if (!file || seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imported = new Map();

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!/\.svelte(\.js)?$/.test(specifier)) continue;
      const target = asSvelte(file, specifier);
      const clause = statement.importClause;
      if (!clause) continue;
      // `import Widget from ...` and `import Widget, { other } from ...`
      if (clause.name) imported.set(clause.name.text, target);
      // `import { default as Widget } from ...`
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if ((element.propertyName ?? element.name).text === 'default') {
            imported.set(element.name.text, target);
          }
        }
      }
    }

    for (const statement of source.statements) {
      // `import Widget from './Widget.svelte'; export default Widget;`
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const name = ts.isIdentifier(statement.expression) ? statement.expression.text : null;
        if (name && imported.has(name)) found.set(imported.get(name), imported.get(name));
        continue;
      }
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;

      if (!statement.exportClause) {
        if (specifier?.startsWith('.')) followModule(file, specifier);
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;

      const fromSvelte = specifier ? /\.svelte(\.js)?$/.test(specifier) : false;
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        if (fromSvelte) {
          // `export { default as Widget }` and bare `export { default }`
          if (local === 'default') {
            const target = asSvelte(file, specifier);
            found.set(target, target);
          }
          continue;
        }
        if (!specifier && imported.has(local)) {
          found.set(imported.get(local), imported.get(local));
        }
      }
      if (specifier && !fromSvelte && specifier.startsWith('.')) followModule(file, specifier);
    }
  };

  for (const value of exportTargets(manifest.exports ?? {})) {
    // `./dist/x/Button.svelte` and `./dist/x/Button.svelte.js` name the same
    // component; barrels already accept both spellings, so entry points must too.
    if (/\.svelte(\.js)?$/.test(value)) {
      const component = join(
        packageDir,
        value.replace(/^\.\/dist\//, './src/').replace(/\.svelte\.js$/, '.svelte')
      );
      if (existsSync(component)) found.set(component, component);
      continue;
    }
    if (!/\.(js|d\.ts)$/.test(value)) continue;
    let entry = join(
      packageDir,
      value.replace(/^\.\/dist\//, './src/').replace(/\.d\.ts$/, '.ts').replace(/\.js$/, '.ts')
    );
    if (!existsSync(entry)) entry = entry.replace(/\.ts$/, '/index.ts');
    visit(entry);
  }
  return found;
}

/** Undocumented members of a component's own exported Props interface. */
function undocumentedProps(sveltePath) {
  if (!existsSync(sveltePath)) return null;
  const source = readFileSync(sveltePath, 'utf8');

  // Every typed script block, not just the first: a component may put
  // `<script module lang="ts">` ahead of its instance script, and matching only
  // the first would find no Props interface and skip the component entirely.
  const all = [...source.matchAll(/<script([^>]*)\blang=["']ts["']([^>]*)>([\s\S]*?)<\/script>/g)];
  if (!all.length) return null;

  // Only the instance script declares component props. A module script may
  // declare its own `*Props` type for module-only helpers, and letting that win
  // would report the component clean while its real props go unchecked.
  const isModule = (match) => /\bmodule\b|context\s*=\s*["']module["']/.test(match[1] + match[2]);
  const blocks = [...all.filter((match) => !isModule(match)), ...all.filter(isModule)];

  // Svelte accepts either shape, and both are published:
  //   export interface Props { ... }
  //   export type Props = { ... }
  // A declaration named exactly `Props` wins, so an unrelated `FooProps`
  // declared earlier in the same block cannot shadow the real one.
  const membersOf = (statement) => {
    if (ts.isInterfaceDeclaration(statement)) return statement.members;
    if (ts.isTypeAliasDeclaration(statement)) {
      if (ts.isTypeLiteralNode(statement.type)) return statement.type.members;
      // `type Props = Base & { ... }`: the literal half is this component's own.
      if (ts.isIntersectionTypeNode(statement.type)) {
        return statement.type.types.filter(ts.isTypeLiteralNode).flatMap((node) => [...node.members]);
      }
    }
    return null;
  };

  let file = null;
  let members = null;
  for (const block of blocks) {
    const parsed = ts.createSourceFile(sveltePath, block[3], ts.ScriptTarget.Latest, true);
    // Svelte reads the props type whether or not it is exported, and 83
    // components in this repository declare a bare `interface Props`. Requiring
    // the modifier made those invisible, so a strict package would have gated
    // nothing at all.
    const candidates = parsed.statements.filter(
      (statement) =>
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
        /Props$/.test(statement.name.text)
    );
    const chosen =
      candidates.find((statement) => statement.name.text === 'Props') ?? candidates[0];
    const found = chosen ? membersOf(chosen) : null;
    if (found) {
      file = parsed;
      members = found;
      break;
    }
  }
  if (!members) return null;

  const missing = [];
  let total = 0;
  for (const member of members) {
    if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
    const name = member.name?.getText(file).replace(/^['"]|['"]$/g, '');
    if (!name || name.startsWith('$$') || SKIPPED_PROPS.has(name)) continue;
    total += 1;
    const documented = ts
      .getJSDocCommentsAndTags(member)
      .some((doc) => ts.isJSDoc(doc) && ts.getTextOfJSDocComment(doc.comment));
    if (!documented) missing.push(name);
  }
  return { total, missing };
}

const onlyPackage = argv.includes('--package') ? argv[argv.indexOf('--package') + 1] : null;
const strictOnly = argv.includes('--strict-only');

const rows = [];
for (const name of readdirSync(PACKAGES).sort()) {
  if (onlyPackage && name !== onlyPackage) continue;
  const packageDir = join(PACKAGES, name);
  if (!existsSync(join(packageDir, 'package.json'))) continue;
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  // This flag is the enforcement boundary, so a typo must not quietly turn a
  // gated package back into a reporting one.
  if ('smrtJsdoc' in manifest && manifest.smrtJsdoc !== 'strict') {
    console.error(
      `${name}: unrecognized "smrtJsdoc" value ${JSON.stringify(manifest.smrtJsdoc)}; ` +
        'the only supported mode is "strict".'
    );
    process.exit(1);
  }
  const strict = manifest.smrtJsdoc === 'strict';
  if (strictOnly && !strict) continue;

  const components = exportedComponents(packageDir);
  if (!components.size) continue;

  let props = 0;
  const offenders = [];
  for (const [, sveltePath] of [...components].sort()) {
    const result = undocumentedProps(sveltePath);
    if (!result) continue;
    props += result.total;
    if (result.missing.length) {
      offenders.push({
        file: relative(ROOT, sveltePath),
        missing: result.missing
      });
    }
  }
  if (!props) continue;
  const undocumented = offenders.reduce((sum, entry) => sum + entry.missing.length, 0);
  rows.push({ name, strict, components: components.size, props, undocumented, offenders });
}

let failed = false;
for (const row of rows) {
  const documented = row.props - row.undocumented;
  const percent = row.props ? Math.round((documented / row.props) * 100) : 100;
  const mode = row.strict ? 'strict' : 'report';
  console.log(
    `${row.name.padEnd(22)} ${String(documented).padStart(4)}/${String(row.props).padEnd(4)} ` +
      `${String(percent).padStart(3)}%  ${row.components} exported  [${mode}]`
  );
  if (!row.strict || !row.offenders.length) continue;
  failed = true;
  for (const offender of row.offenders) {
    console.error(`  ${offender.file}`);
    console.error(`    undocumented: ${offender.missing.join(', ')}`);
  }
}

const totals = rows.reduce(
  (sum, row) => ({ props: sum.props + row.props, undocumented: sum.undocumented + row.undocumented }),
  { props: 0, undocumented: 0 }
);
const documented = totals.props - totals.undocumented;
console.log(
  `\n${documented}/${totals.props} exported component props documented ` +
    `(${Math.round((documented / totals.props) * 100)}%) across ${rows.length} packages.`
);

if (failed) {
  console.error(
    '\nA package marked "smrtJsdoc": "strict" has undocumented exported props.\n' +
      'Write one sentence per prop saying what it means, not what its type already says.'
  );
  process.exit(1);
}
