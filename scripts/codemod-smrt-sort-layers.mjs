#!/usr/bin/env node
/** Conservative structure/theme split. Never renames a class or drops a TODO. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMRT_CASCADE_LAYERS_DECLARATION } from './cascade-layers-lib.mjs';
import { classifyProperty, componentFiles, hasStructure, parseComponent,
  relativeFile, TODO_MARKER, walkCss } from './smrt-sort-layers-lib.mjs';

/** Reports remain reproducible on a second run; unresolved CSS stays executable. */
function existingTodos(source, css) {
  const nodes = [];
  walkCss(css, (node, context) => {
    if (['Declaration', 'Atrule', 'Rule'].includes(node.type)) nodes.push({ node, context });
  });
  return css.comments.filter((comment) => source.slice(comment.start, comment.end).includes(TODO_MARKER)).map((comment) => {
    const match = nodes.filter(({ node }) => node.start >= comment.end).sort((a, b) => a.node.start - b.node.start)[0];
    const text = source.slice(comment.start, comment.end);
    return { line: source.slice(0, comment.start).split('\n').length,
      reason: text.slice(text.indexOf(TODO_MARKER) + TODO_MARKER.length).replace(/\*\/$/, '').trim(),
      declaration: match ? source.slice(match.node.start, match.node.end) : '',
      property: match?.node.property ?? null,
      path: match?.context.path.map((part) => typeof part === 'string' ? part : source.slice(part.start, part.end)) ?? [],
    };
  });
}

export function codemodSource(source) {
  let ast;
  try { ast = parseComponent(source); }
  catch (error) { return { source, changed: false, todos: [{ line: error.start?.line ?? 1, reason: `Parse/manual review: ${error.message}`, declaration: '', property: null, path: [] }] }; }
  const css = ast.css;
  if (!css || !css.children.some((node) => node.block)) return { source, changed: false, todos: [] };
  if (hasStructure(css)) return { source, changed: false, todos: existingTodos(source, css) };

  const raw = (node) => source.slice(node.start, node.end);
  const unresolved = (node, reason) => ({ structure: '', theme: `/* ${TODO_MARKER} ${reason} */\n${raw(node)}${node.type === 'Declaration' ? ';' : ''}` });
  const wrap = (node, body) => `${source.slice(node.start, node.block.start + 1)}\n${body}\n}`;

  function splitChildren(node) {
    const result = { structure: '', theme: '' };
    let cursor = node.type === 'StyleSheet' ? node.content.start : node.start + 1;
    for (const child of node.children ?? []) {
      // Comments stay attached to the next item in each applicable layer.
      const prefix = source.slice(cursor, child.start).replace(/^\s*;?/, '');
      const split = splitNode(child);
      for (const layer of ['structure', 'theme']) {
        if (split[layer]) result[layer] += `${prefix}${split[layer]}\n`;
      }
      cursor = child.end + (source[child.end] === ';' ? 1 : 0);
    }
    const end = node.type === 'StyleSheet' ? node.content.end : node.end - 1;
    const tail = source.slice(cursor, end).trim();
    if (tail) result.theme += `${tail}\n`;
    return result;
  }

  function splitNode(node) {
    if (node.type === 'Declaration') {
      const kind = classifyProperty(node.property);
      // Pointer behavior needs hit-area context; conservatively report all cases.
      if (node.property === 'pointer-events' || kind === 'role' || kind === 'unknown') {
        return unresolved(node, kind === 'unknown' ? 'unknown/custom property; classify by consumers' : 'role-dependent; judge element behavior');
      }
      return { structure: '', theme: '', [kind]: `${raw(node)};` };
    }
    if (node.type === 'Atrule' && /^(?:-webkit-)?keyframes$/.test(node.name)) {
      let unknown = false;
      walkCss(node, (child) => {
        if (child.type === 'Declaration' && classifyProperty(child.property) === 'unknown') unknown = true;
        if (child.type === 'Atrule' && child !== node) unknown = true;
      });
      return unknown ? unresolved(node, 'unsupported keyframes; review animation together') : { structure: '', theme: raw(node) };
    }
    if (node.type === 'Rule' || (node.type === 'Atrule' && ['media', 'supports', 'container', 'starting-style'].includes(node.name) && node.block)) {
      const split = splitChildren(node.block);
      return Object.fromEntries(Object.entries(split).map(([layer, body]) => [layer, body.trim() ? wrap(node, body) : '']));
    }
    if (node.type === 'Atrule' && node.name === 'layer' && node.prelude.trim() === 'smrt.theme' && node.block) {
      return splitChildren(node.block);
    }
    return unresolved(node, 'unsupported CSS node; review wrapper and contents together');
  }

  // Leave reset and the order statement verbatim. Split adjacent theme/rule runs
  // in place so repeated layer blocks and conditional cascade order are retained.
  let body = '';
  let run = { structure: '', theme: '' };
  let cursor = css.content.start;
  const flush = () => {
    if (!run.structure && !run.theme) return;
    body += `\n@layer smrt.structure {\n${run.structure}}\n@layer smrt.theme {\n${run.theme}}\n`;
    run = { structure: '', theme: '' };
  };
  let order = false;
  for (const node of css.children) {
    const prefix = source.slice(cursor, node.start);
    if (node.type === 'Atrule' && node.name === 'layer' && (!node.block || node.prelude.trim() === 'smrt.reset')) {
      flush();
      body += prefix + raw(node);
      if (!node.block && node.prelude.replace(/\s+/g, '') === 'smrt.reset,smrt.structure,smrt.theme') order = true;
    } else {
      const split = splitNode(node);
      for (const layer of ['structure', 'theme']) if (split[layer]) run[layer] += `${prefix}${split[layer]}\n`;
    }
    cursor = node.end;
  }
  flush();
  body += source.slice(cursor, css.content.end);
  if (!order) body = `\n${SMRT_CASCADE_LAYERS_DECLARATION}\n${body}`;
  const output = source.slice(0, css.content.start) + body + source.slice(css.content.end);
  // Never write syntactically invalid output, even if a future parser adds nodes.
  try {
    const next = parseComponent(output);
    return { source: output, changed: output !== source, todos: existingTodos(output, next.css) };
  } catch (error) {
    return { source, changed: false, todos: [{ line: 1, reason: `Output requires manual review: ${error.message}`, declaration: '', property: null, path: [] }] };
  }
}

export function run(args) {
  let write = false;
  let check = false;
  let report;
  const files = [];
  const packages = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--write') write = true;
    else if (arg === '--check') check = true;
    else if (['--report', '--file', '--package'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--report') report = resolve(value);
      else if (arg === '--file') files.push(resolve(value));
      else packages.push(value);
    } else if (!arg.startsWith('-')) files.push(resolve(arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (write && check) throw new Error('Choose --check or --write');
  if (!files.length && !packages.length) throw new Error('Select --file PATH or --package NAME explicitly; no implicit repository-wide rewrite');
  const packageFiles = packages.length ? componentFiles(packages) : [];
  const selected = [...new Set([...files, ...packageFiles])].sort();
  if (selected.some((file) => !file.endsWith('.svelte'))) throw new Error('Only .svelte files are supported');
  if (report && selected.includes(report)) throw new Error('Report must not overwrite an input component');
  // Read/parse all inputs before any writes: a bad path cannot partially apply a slice.
  const results = selected.map((file) => ({ file, ...codemodSource(readFileSync(file, 'utf8')) }));
  const summary = { version: 1, files: results.map(({ file, changed, todos }) => ({ file: relativeFile(file), changed, todos })) };
  for (const result of results) if (write && result.changed) writeFileSync(result.file, result.source);
  if (report) writeFileSync(report, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  return results.some((result) => result.todos.length || (!write && result.changed)) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
