#!/usr/bin/env node
/**
 * Export-snapshot gate for the root entries of `@happyvertical/smrt-core`.
 *
 * `export *` makes a barrel's whole export list part of the package root, so a
 * name can reach (or leave) the public surface without the root file changing.
 * This script asks the TypeScript checker for the full export list of each
 * entry (`src/index.ts`, `src/browser.ts`), following every star and alias,
 * and compares it with the committed snapshot in `packages/core/api/`:
 * one row per name with its kind (`value` or `type`) and declaring module.
 *
 * Guarantees, all decided before anything is written:
 * - the workspace TypeScript must be the version pinned in the root
 *   `package.json`; snapshots from two compilers are never compared;
 * - any compiler diagnostic in an entry or in a module reached through an
 *   export chain fails the run (an ambiguous star is TS2308, a missing module
 *   TS2307), as does an `export *` whose module does not resolve;
 * - workspace packages resolve to their sources through the typecheck
 *   config's source paths; a resolution into a `packages/<pkg>/dist/`
 *   declaration fails, so the result never depends on build state;
 * - a name is a `type` when any hop of its alias chain is type-only
 *   (`export type { X }`, `export type *`), even when the target is a class;
 * - every export declaration in every module reached from an entry is
 *   followed, whatever names it yields, into dependency declaration files
 *   too: an `export ... from` whose module does not resolve fails the run
 *   anywhere on the chain;
 * - `export *` lines in an entry are a ratchet: the allowlist
 *   (`api/export-star-allowlist.json`, keyed by entry and module specifier)
 *   may only shrink. `--write` drops entries for removed lines and never adds,
 *   and refuses to run when the allowlist is missing (only `--init` creates
 *   the first one). `--against <ref>` (CI, plain Node) fails when the
 *   allowlist holds a star the ref's allowlist does not;
 * - a namespace re-export (`export * as ns from`, or `import * as ns` then
 *   `export { ns }`) fails: every later export of that module would reach the
 *   root as `ns.X` without a snapshot change. List the names instead.
 *
 * Usage:
 *   node scripts/check-export-snapshot.mjs            # check (core typecheck)
 *   node scripts/check-export-snapshot.mjs --write    # pnpm api:snapshot
 *   node scripts/check-export-snapshot.mjs --write --init   # first snapshot only
 *   node scripts/check-export-snapshot.mjs --against <git ref>
 *   [--root DIR]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredFileAtRef } from './lib/source-scan.mjs';

// Loaded lazily so `--against` runs on plain Node without an install.
let defaultTs;
try {
  defaultTs = (await import('typescript')).default;
} catch {
  defaultTs = undefined;
}

const DEFAULT_PACKAGE_DIR = 'packages/core';
const DEFAULT_ENTRIES = ['src/index.ts', 'src/browser.ts'];
const DEFAULT_TSCONFIG = 'tsconfig.typecheck.json';
const ALLOWLIST_FILE = 'export-star-allowlist.json';
const WORKSPACE_DIST = /^packages\/[^/]+\/dist\//;

/** Repository-relative POSIX path of `file`, whatever the host separator. */
export function toPosixRelative(root, file) {
  const posixRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const posixFile = file.replace(/\\/g, '/');
  return posixFile.startsWith(`${posixRoot}/`)
    ? posixFile.slice(posixRoot.length + 1)
    : posixFile;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const unquoteYaml = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * The `typescript` entry of a pnpm catalog in `pnpm-workspace.yaml`: the
 * default `catalog:` block, or `catalogs: <name>:` for a named one. A small
 * line reader for the two block shapes pnpm documents, so the gate needs no
 * YAML dependency.
 */
export function readCatalogEntry(workspaceYaml, packageName, catalogName) {
  const lines = workspaceYaml.split(/\r?\n/);
  const isKey = (line, key) =>
    new RegExp(`^(['"]?)${key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\1:`).test(
      line.trim(),
    );
  const indentOf = (line) => line.length - line.trimStart().length;
  // Find the block's header line and the indentation of its entries.
  let start = -1;
  let blockIndent = 0;
  if (!catalogName) {
    start = lines.findIndex((line) => /^catalog:\s*$/.test(line));
  } else {
    const catalogs = lines.findIndex((line) => /^catalogs:\s*$/.test(line));
    if (catalogs === -1) return undefined;
    for (let i = catalogs + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      if (indentOf(line) === 0) break;
      if (isKey(line, catalogName)) {
        start = i;
        blockIndent = indentOf(line);
        break;
      }
    }
  }
  if (start === -1) return undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= blockIndent) break;
    if (isKey(line, packageName)) {
      const value = line.trim().replace(/^(['"]?)[^'":]+\1:/, '');
      return unquoteYaml(value.replace(/\s+#.*$/, ''));
    }
  }
  return undefined;
}

/**
 * The TypeScript version the repository pins: root `package.json`
 * `devDependencies.typescript`, followed into the pnpm catalog when it is
 * `catalog:` or `catalog:<name>`. Returns `{ version, from }`, or `{ error }`
 * when the pin is missing or is not one exact version.
 */
export function resolvePinnedTypeScript(root) {
  const spec = readJson(join(root, 'package.json')).devDependencies?.typescript;
  let version = spec;
  let from = 'package.json devDependencies.typescript';
  if (typeof spec === 'string' && spec.startsWith('catalog:')) {
    const catalogName = spec.slice('catalog:'.length).trim() || undefined;
    from = `pnpm-workspace.yaml ${catalogName ? `catalogs.${catalogName}` : 'catalog'}.typescript`;
    const workspaceFile = join(root, 'pnpm-workspace.yaml');
    version = existsSync(workspaceFile)
      ? readCatalogEntry(
          readFileSync(workspaceFile, 'utf8'),
          'typescript',
          catalogName,
        )
      : undefined;
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    return {
      error: `The repository must pin TypeScript to one exact version for the export snapshot; ${from} is ${JSON.stringify(version ?? null)}.`,
    };
  }
  return { version, from };
}

/** The package name for a declaration file under `node_modules`. */
function nodeModulesPackage(relative) {
  const parts = relative.split('node_modules/').pop().split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * The declaring module recorded in the snapshot: a path inside this package,
 * otherwise the package name (another workspace package or an installed one),
 * so a file move inside a dependency does not change this package's snapshot.
 */
function moduleLabel(root, packageDir, file, names) {
  const relative = toPosixRelative(root, file);
  if (relative.includes('node_modules/')) return nodeModulesPackage(relative);
  if (relative.startsWith(`${packageDir}/`)) return relative;
  const workspace = relative.match(/^packages\/([^/]+)\//);
  if (workspace) {
    const dir = workspace[1];
    if (!names.has(dir)) {
      const manifest = join(root, 'packages', dir, 'package.json');
      names.set(dir, existsSync(manifest) ? readJson(manifest).name : null);
    }
    if (names.get(dir)) return names.get(dir);
  }
  return relative;
}

function formatDiagnostic(ts, root, diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file) return `TS${diagnostic.code}: ${message}`;
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start ?? 0,
  );
  const where = toPosixRelative(root, diagnostic.file.fileName);
  return `${where}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`;
}

/** Star re-exports (`export *`, `export type *`) written in one source file. */
function starLines(ts, sourceFile) {
  const lines = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.exportClause &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      lines.push(statement.moduleSpecifier.text);
    }
  }
  return lines;
}

function serializeSnapshot(snapshot) {
  const rows = snapshot.exports.map((row) => `    ${JSON.stringify(row)}`);
  return [
    '{',
    `  "entry": ${JSON.stringify(snapshot.entry)},`,
    `  "typescript": ${JSON.stringify(snapshot.typescript)},`,
    `  "count": ${JSON.stringify(snapshot.count)},`,
    '  "exports": [',
    rows.join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

function diffSnapshots(before, after) {
  const lines = [];
  const old = new Map(before.map((row) => [row.name, row]));
  const now = new Map(after.map((row) => [row.name, row]));
  for (const [name, row] of now) {
    const prior = old.get(name);
    if (!prior) lines.push(`  added    ${name} (${row.kind}, ${row.module})`);
    else {
      if (prior.kind !== row.kind)
        lines.push(`  retyped  ${name} (${prior.kind} -> ${row.kind})`);
      if (prior.module !== row.module)
        lines.push(`  moved    ${name} (${prior.module} -> ${row.module})`);
    }
  }
  for (const [name, row] of old)
    if (!now.has(name))
      lines.push(`  removed  ${name} (${row.kind}, ${row.module})`);
  return lines;
}

/**
 * Computes, checks and (with `write`) records the export snapshot of each
 * entry. Returns `{ ok, errors, snapshots, resolvedFiles, wrote }`; expected
 * failures are reported in `errors`, never thrown.
 */
export function checkExportSnapshot({
  root,
  packageDir = DEFAULT_PACKAGE_DIR,
  entries = DEFAULT_ENTRIES,
  tsconfig = DEFAULT_TSCONFIG,
  write = false,
  init = false,
  hideWorkspaceDist = false,
  ts = defaultTs,
}) {
  const absRoot = resolve(root);
  const errors = [];
  const fail = (extra = {}) => ({
    ok: false,
    errors,
    snapshots: {},
    resolvedFiles: {},
    wrote: [],
    ...extra,
  });
  if (!ts) {
    errors.push(
      'typescript is not installed; run pnpm install --frozen-lockfile (only --against runs without it).',
    );
    return fail();
  }
  if (init && !write) {
    errors.push('--init only applies with --write.');
    return fail();
  }

  // 1. Compiler pin: the repository's own pin, never a version written here.
  const pin = resolvePinnedTypeScript(absRoot);
  if ('error' in pin) {
    errors.push(pin.error);
    return fail();
  }
  if (ts.version !== pin.version) {
    errors.push(
      `TypeScript mismatch: the checker loaded TypeScript ${ts.version}, but the repository pins ${pin.version} (${pin.from}). Refusing to compare export snapshots made by different compilers. If the pin is right, run pnpm install --frozen-lockfile so the loaded compiler matches it. If you are bumping TypeScript, update the pin and the lockfile together, then run pnpm api:snapshot and commit the snapshots.`,
    );
    return fail();
  }

  // 2. Program over the entries, with the package's typecheck options.
  const configPath = join(absRoot, packageDir, tsconfig);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) =>
        errors.push(formatDiagnostic(ts, absRoot, d)),
    },
  );
  if (!parsed) return fail();
  for (const d of parsed.errors) errors.push(formatDiagnostic(ts, absRoot, d));
  if (errors.length > 0) return fail();

  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  if (hideWorkspaceDist) {
    const hidden = (path) =>
      WORKSPACE_DIST.test(toPosixRelative(absRoot, path));
    const { fileExists, readFile, directoryExists } = host;
    host.fileExists = (path) => !hidden(path) && fileExists.call(host, path);
    host.readFile = (path) =>
      hidden(path) ? undefined : readFile.call(host, path);
    host.directoryExists = (path) =>
      !hidden(`${path}/`) && (directoryExists?.call(host, path) ?? true);
  }
  const entryFiles = entries.map((entry) => join(absRoot, packageDir, entry));
  const program = ts.createProgram({
    rootNames: entryFiles,
    options,
    host,
  });
  const checker = program.getTypeChecker();

  for (const d of program.getOptionsDiagnostics())
    errors.push(formatDiagnostic(ts, absRoot, d));
  for (const d of program.getGlobalDiagnostics())
    errors.push(formatDiagnostic(ts, absRoot, d));

  const resolvedFiles = {};
  const allFiles = program
    .getSourceFiles()
    .map((sf) => toPosixRelative(absRoot, sf.fileName));
  const distFiles = allFiles.filter((file) => WORKSPACE_DIST.test(file));
  for (const file of distFiles)
    errors.push(
      `${file}: a workspace package resolved to a built declaration under /dist/; map it to its source in tsconfig.workspace-source-paths.json.`,
    );

  // 3. Walk every entry's exports.
  const labels = new Map();
  const snapshots = {};
  const reached = new Set();
  // InternalSymbolName.ExportStar: already an escaped name, used as is.
  const exportStar = '__export';

  const declarationFiles = (symbol) =>
    (symbol.declarations ?? []).map((d) => d.getSourceFile());

  /** Module symbols named by the import declarations that bind `symbol`. */
  function importedModules(symbol) {
    const modules = [];
    for (const declaration of symbol.declarations ?? []) {
      let node = declaration;
      while (node && !ts.isImportDeclaration(node) && !ts.isSourceFile(node))
        node = node.parent;
      const specifier =
        node && ts.isImportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isImportEqualsDeclaration(declaration) &&
              ts.isExternalModuleReference(declaration.moduleReference)
            ? declaration.moduleReference.expression
            : undefined;
      if (!specifier) continue;
      const module = checker.getSymbolAtLocation(specifier);
      if (module) modules.push(module);
    }
    return modules;
  }

  /**
   * Finds `name` in a module the way the checker does (explicit exports win
   * over stars) and records whether any hop on the way is type-only.
   * Returns { target, typeOnly } or undefined.
   */
  function resolveExport(moduleSymbol, name, seen) {
    if (seen.has(moduleSymbol)) return undefined;
    seen.add(moduleSymbol);
    for (const sf of declarationFiles(moduleSymbol)) reached.add(sf);
    const explicit = moduleSymbol.exports?.get(ts.escapeLeadingUnderscores(name));
    if (explicit) {
      if (!(explicit.flags & ts.SymbolFlags.Alias))
        return { target: explicit, typeOnly: false };
      let typeOnly = Boolean(checker.getTypeOnlyAliasDeclaration(explicit));
      let hop = explicit;
      // Follow each alias hop, so every module on the chain is checked.
      for (let i = 0; i < 100 && hop.flags & ts.SymbolFlags.Alias; i++) {
        for (const sf of declarationFiles(hop)) reached.add(sf);
        // An import binding's module is reached too: the next hop already
        // lands on the leaf declaration behind any star, so the barrel the
        // name was imported from would otherwise never be walked.
        for (const module of importedModules(hop))
          for (const sf of declarationFiles(module)) reached.add(sf);
        if (checker.getTypeOnlyAliasDeclaration(hop)) typeOnly = true;
        const next = checker.getImmediateAliasedSymbol(hop);
        if (!next || next === hop) break;
        hop = next;
      }
      return { target: checker.getAliasedSymbol(explicit), typeOnly };
    }
    const stars = moduleSymbol.exports?.get(exportStar)?.declarations ?? [];
    const found = [];
    for (const star of stars) {
      if (!ts.isExportDeclaration(star) || !star.moduleSpecifier) continue;
      const target = checker.getSymbolAtLocation(star.moduleSpecifier);
      if (!target) continue; // reported by the unresolved-star check
      const hit = resolveExport(target, name, new Set(seen));
      if (hit)
        found.push({ ...hit, typeOnly: hit.typeOnly || star.isTypeOnly });
    }
    if (found.length === 0) return undefined;
    // The same declaration reached by two stars is one export; it is a value
    // when any path to it is a value path.
    return { target: found[0].target, typeOnly: found.every((f) => f.typeOnly) };
  }

  for (const [index, entry] of entries.entries()) {
    const entryRel = `${packageDir}/${entry}`;
    const sourceFile = program.getSourceFile(entryFiles[index]);
    if (!sourceFile) {
      errors.push(`${entryRel}: entry file not found.`);
      continue;
    }
    reached.add(sourceFile);
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      errors.push(`${entryRel}: not a module.`);
      continue;
    }
    const rows = [];
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const name = ts.unescapeLeadingUnderscores(exported.escapedName);
      const hit = resolveExport(moduleSymbol, name, new Set());
      const checkerTarget =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      if (!hit || hit.target !== checkerTarget) {
        errors.push(
          `${entryRel}: cannot trace export '${name}' to the declaration the checker resolves.`,
        );
        continue;
      }
      const declarations = hit.target.declarations ?? [];
      if (declarations.length === 0) {
        errors.push(`${entryRel}: export '${name}' does not resolve.`);
        continue;
      }
      // A whole module under one name: its export list is public through
      // `name.X` with no row of its own, so it can grow unreviewed.
      if (
        declarations.some(
          (d) =>
            ts.isSourceFile(d) ||
            (ts.isModuleDeclaration(d) && ts.isStringLiteral(d.name)),
        )
      ) {
        errors.push(
          `${entryRel}: '${name}' re-exports a whole module as a namespace (export * as, or import * as then export). Its later exports would become public without a snapshot change; export the names explicitly.`,
        );
        continue;
      }
      for (const sf of declarationFiles(hit.target)) reached.add(sf);
      const modules = [
        ...new Set(
          declarations.map((d) =>
            moduleLabel(absRoot, packageDir, d.getSourceFile().fileName, labels),
          ),
        ),
      ].sort();
      const isValue =
        !hit.typeOnly && Boolean(hit.target.flags & ts.SymbolFlags.Value);
      rows.push({
        name,
        kind: isValue ? 'value' : 'type',
        module: modules.join(' + '),
      });
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const values = rows.filter((row) => row.kind === 'value').length;
    snapshots[entryRel] = {
      entry: entryRel,
      typescript: ts.version,
      count: { names: rows.length, values, types: rows.length - values },
      exports: rows,
    };
  }

  // 4. Every export declaration of every reached module is followed,
  //    independently of the names it yields (a star whose names are all
  //    found elsewhere, or a module reached only for one explicit name, is
  //    still walked), dependency declaration files included. An
  //    `export ... from` that does not resolve fails anywhere on the chain.
  //    Compiler diagnostics are read for this repository's files only.
  const pending = [...reached];
  while (pending.length > 0) {
    const sf = pending.pop();
    const rel = toPosixRelative(absRoot, sf.fileName);
    for (const statement of sf.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier)
        continue;
      const target = checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (!target) {
        errors.push(
          `${rel}: export from '${statement.moduleSpecifier.getText(sf).slice(1, -1)}' does not resolve.`,
        );
        continue;
      }
      for (const next of declarationFiles(target)) {
        if (reached.has(next)) continue;
        reached.add(next);
        pending.push(next);
      }
    }
  }
  for (const sf of reached) {
    const rel = toPosixRelative(absRoot, sf.fileName);
    if (sf.isDeclarationFile && rel.includes('node_modules/')) continue;
    for (const d of program.getSyntacticDiagnostics(sf))
      errors.push(formatDiagnostic(ts, absRoot, d));
    for (const d of program.getSemanticDiagnostics(sf))
      errors.push(formatDiagnostic(ts, absRoot, d));
  }
  for (const entry of Object.keys(snapshots))
    resolvedFiles[entry] = allFiles;

  // 5. Ratchet on `export *` lines in the entries.
  const allowPath = join(absRoot, packageDir, 'api', ALLOWLIST_FILE);
  const allowRel = toPosixRelative(absRoot, allowPath);
  const allowExists = existsSync(allowPath);
  const allowlist = allowExists ? readJson(allowPath) : {};
  const nextAllowlist = {};
  // The allowlist is a ratchet: recreating it from the stars present would
  // admit every new one, so only `--init` writes a first allowlist.
  if (!allowExists && !init)
    errors.push(
      `${allowRel} is missing. It is a ratchet and is never rebuilt from the current stars: restore it from git (git checkout -- ${allowRel}). Only a package's first snapshot uses pnpm api:snapshot -- --init.`,
    );
  if (allowExists && init)
    errors.push(
      `${allowRel} already exists; --init only writes a package's first allowlist, which may then only shrink.`,
    );
  for (const [index, entry] of entries.entries()) {
    const entryRel = `${packageDir}/${entry}`;
    const sourceFile = program.getSourceFile(entryFiles[index]);
    if (!sourceFile) continue;
    const present = starLines(ts, sourceFile);
    const allowed = allowlist[entryRel] ?? [];
    if (!allowExists) {
      nextAllowlist[entryRel] = [...present];
      continue;
    }
    for (const specifier of present)
      if (!allowed.includes(specifier))
        errors.push(
          `${entryRel}: new export * from '${specifier}'. Star re-exports in this entry may only be removed; list the names explicitly instead.`,
        );
    const stale = allowed.filter((specifier) => !present.includes(specifier));
    if (!write)
      for (const specifier of stale)
        errors.push(
          `${allowRel}: '${specifier}' is no longer star-exported by ${entryRel}; remove it (pnpm api:snapshot).`,
        );
    nextAllowlist[entryRel] = allowed.filter((s) => present.includes(s));
  }

  if (errors.length > 0) return fail();

  // 6. Compare, or write the complete set.
  const wrote = [];
  const outputs = Object.values(snapshots).map((snapshot) => ({
    path: join(
      absRoot,
      packageDir,
      'api',
      `${basename(snapshot.entry).replace(/\.[^.]+$/, '')}.exports.json`,
    ),
    snapshot,
  }));
  if (write) {
    mkdirSync(join(absRoot, packageDir, 'api'), { recursive: true });
    for (const { path, snapshot } of outputs) {
      writeFileSync(path, serializeSnapshot(snapshot));
      wrote.push(toPosixRelative(absRoot, path));
    }
    writeFileSync(allowPath, `${JSON.stringify(nextAllowlist, null, 2)}\n`);
    wrote.push(allowRel);
    return { ok: true, errors, snapshots, resolvedFiles, wrote };
  }
  for (const { path, snapshot } of outputs) {
    const rel = toPosixRelative(absRoot, path);
    if (!existsSync(path)) {
      errors.push(`${rel} is missing; run pnpm api:snapshot and commit it.`);
      continue;
    }
    const expected = serializeSnapshot(snapshot);
    const actual = readFileSync(path, 'utf8');
    if (actual === expected) continue;
    let committed;
    try {
      committed = JSON.parse(actual);
    } catch {
      errors.push(`${rel} is not valid JSON; run pnpm api:snapshot.`);
      continue;
    }
    const lines = diffSnapshots(committed.exports ?? [], snapshot.exports);
    if (committed.typescript !== snapshot.typescript)
      lines.unshift(
        `  the snapshot was recorded with TypeScript ${committed.typescript} and the pinned compiler is now ${snapshot.typescript}: after a TypeScript bump, run pnpm api:snapshot, review the name changes below, and commit the snapshot`,
      );
    if (lines.length === 0) lines.push('  formatting differs');
    errors.push(
      `${snapshot.entry}: export list differs from ${rel}:\n${lines.join('\n')}\nReview the change, then run pnpm api:snapshot and commit the snapshot.`,
    );
  }
  return { ok: errors.length === 0, errors, snapshots, resolvedFiles, wrote };
}

/** Whether `ref` names a commit in the repository at `root`. */
export function gitRefResolves(root, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The star ratchet against a git ref (CI: the pull request's base). Plain
 * Node, no TypeScript: fails when the allowlist is missing, or holds a star
 * the ref's allowlist does not (an edit that grows the list together with
 * the entry). A ref without the file passes: the allowlist is new there.
 * Returns `{ ok, errors }`.
 */
export function checkStarAllowlistAgainst({
  root,
  ref,
  packageDir = DEFAULT_PACKAGE_DIR,
  readAtRef = requiredFileAtRef,
  refResolves = gitRefResolves,
}) {
  const absRoot = resolve(root);
  const allowRel = `${packageDir}/api/${ALLOWLIST_FILE}`;
  const errors = [];
  const allowPath = join(absRoot, allowRel);
  if (!existsSync(allowPath)) {
    errors.push(`${allowRel} is missing; it may only shrink.`);
    return { ok: false, errors };
  }
  if (!refResolves(absRoot, ref)) {
    errors.push(
      `cannot read git ref ${ref}; fetch it first (git fetch --no-tags --depth=1 origin <sha>).`,
    );
    return { ok: false, errors };
  }
  let previousText;
  try {
    previousText = readAtRef(absRoot, ref, allowRel);
  } catch (error) {
    errors.push(
      `cannot read ${allowRel} at ${ref}: ${String(error?.message ?? error).trim()}`,
    );
    return { ok: false, errors };
  }
  // Absent only when the ref's tree was read and lacks the file.
  if (previousText === null) return { ok: true, errors };
  const previous = JSON.parse(previousText);
  const current = readJson(allowPath);
  for (const [entry, specifiers] of Object.entries(current)) {
    const before = Array.isArray(previous[entry]) ? previous[entry] : [];
    for (const specifier of Array.isArray(specifiers) ? specifiers : [])
      if (!before.includes(specifier))
        errors.push(
          `${allowRel}: '${specifier}' for ${entry} is not in the allowlist at ${ref}. The star allowlist only shrinks; list the names explicitly instead.`,
        );
  }
  return { ok: errors.length === 0, errors };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf('--root');
  const root =
    rootFlag === -1
      ? join(dirname(fileURLToPath(import.meta.url)), '..')
      : argv[rootFlag + 1];
  const againstFlag = argv.indexOf('--against');
  if (againstFlag !== -1) {
    const ref = argv[againstFlag + 1];
    const result = ref
      ? checkStarAllowlistAgainst({ root, ref })
      : { ok: false, errors: ['--against needs a git ref.'] };
    if (!result.ok) {
      console.error('check-export-snapshot: FAIL');
      for (const error of result.errors) console.error(`\n${error}`);
      process.exit(1);
    }
    console.log(
      `check-export-snapshot: the star allowlist holds nothing beyond ${ref}.`,
    );
    process.exit(0);
  }
  const write = argv.includes('--write');
  const init = argv.includes('--init');
  const result = checkExportSnapshot({ root, write, init });
  if (!result.ok) {
    console.error('check-export-snapshot: FAIL');
    for (const error of result.errors) console.error(`\n${error}`);
    if (write) console.error('\nNothing was written.');
    process.exit(1);
  }
  const counts = Object.values(result.snapshots)
    .map((s) => `${s.entry} ${s.count.names}`)
    .join(', ');
  console.log(
    write
      ? `check-export-snapshot: wrote ${result.wrote.join(', ')} (${counts}).`
      : `check-export-snapshot: export lists match the snapshots (${counts}).`,
  );
}
