#!/usr/bin/env node
/**
 * Replace outline-coloured hairlines in packages/*\/src component styles (#3882).
 * Run without arguments to write, or --check to report pending conversions.
 * Unsupported 0px/1px declarations are listed with file/line, never guessed.
 * Theme outline fallbacks are obsolete (all presets define the tokens); private
 * override fallbacks retain their wrapper. Scripts, markup and comments stay intact.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allPackageSrcDirs, listFiles, ROOT } from './smrt-token-scan-lib.mjs';

const { parse } = createRequire(join(ROOT, 'packages/smrt-ui/package.json'))('svelte/compiler');
const EDGE = /^(?:border(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?|outline)$/;
const COLOR = /^(?:border(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?|outline)-color$/;
const HAIRLINE = /(?<![\w.-])[01]px\b/;

/** Split CSS lists without splitting function arguments or quoted strings. */
function splitList(value) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  return parts;
}

/** Whole var() calls only: nested fallback parentheses must remain balanced. */
function variable(value) {
  if (!value.startsWith('var(') || !value.endsWith(')')) return null;
  let depth = 0;
  for (let i = 3; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')' && --depth === 0 && i !== value.length - 1) return null;
  }
  const [name, ...fallback] = splitList(value.slice(4, -1));
  if (!/^--smrt-[\w-]+$/.test(name.trim())) return null;
  return { name: name.trim(), fallback: fallback.length ? fallback.join(',') : null };
}

function strength(value) {
  const name = variable(value)?.name;
  if (name === '--smrt-color-outline-variant') return '';
  if (name === '--smrt-color-outline') return '-strong';
  return null;
}

function rewriteValue(property, value) {
  // Retain comments and strings verbatim, including misleading CSS examples.
  if (/\/\*|["']/.test(value)) return value;
  if (COLOR.test(property)) {
    const suffix = strength(value);
    if (suffix !== null) return `var(--smrt-hairline${suffix}-color)`;
  }
  if (EDGE.test(property)) {
    const match = /^1px\s+solid\s+(.+)$/.exec(value);
    const suffix = match ? strength(match[1]) : null;
    if (suffix !== null) return `var(--smrt-hairline${suffix})`;
  }
  if (property === 'box-shadow') {
    return splitList(value).map((part) => {
      const ring = /^(?:inset\s+)?0\s+0\s+0\s+1px\s+(.+?)(?:\s+inset)?$/.exec(part.trim());
      if (!ring || strength(ring[1]) === null) return part;
      return part.replace(part.trim(), 'var(--smrt-inset-highlight)');
    }).join(',');
  }
  // An optional component override may hold a convertible default edge.
  const call = variable(value);
  if ((EDGE.test(property) || COLOR.test(property)) && call?.fallback !== null && call?.fallback !== undefined) {
    const fallback = call.fallback.trim();
    const next = rewriteValue(property, fallback);
    if (next !== fallback) return `var(${call.name}, ${next})`;
  }
  return value;
}

/** Pure, offset-based rewrite: no reformatting or changes outside declarations. */
export function codemodSource(source) {
  const css = parse(source, { modern: true }).css;
  const edits = [];
  const remaining = [];
  const counts = { edges: 0, colors: 0, rings: 0 };
  function visit(node) {
    if (node.type === 'Declaration') {
      const start = source.indexOf(':', node.start) + 1;
      const original = source.slice(start, node.end);
      const value = original.trim();
      const next = rewriteValue(node.property, value);
      if (next !== value) {
        edits.push({ start, end: node.end, text: original.replace(value, next) });
        counts[node.property === 'box-shadow' ? 'rings' : COLOR.test(node.property) ? 'colors' : 'edges']++;
      }
      if (HAIRLINE.test(next.replace(/\/\*[\s\S]*?\*\//g, ''))) {
        remaining.push({ line: source.slice(0, node.start).split('\n').length, declaration: `${node.property}: ${next}` });
      }
    }
    for (const child of node.children ?? []) visit(child);
    if (node.block) visit(node.block);
  }
  if (css) visit(css);
  let text = source;
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { source: text, changed: text !== source, counts, remaining };
}

function main() {
  const check = process.argv.includes('--check');
  const counts = { edges: 0, colors: 0, rings: 0 };
  let files = 0;
  let remaining = 0;
  for (const { dir } of allPackageSrcDirs()) {
    for (const file of listFiles(dir, ['.svelte']).sort()) {
      if (/(^|\/)(__tests__|__typecheck__)\/|\.(test|spec)\./.test(file)) continue;
      const result = codemodSource(readFileSync(file, 'utf8'));
      if (result.changed) {
        files++;
        if (!check) writeFileSync(file, result.source);
      }
      for (const key of Object.keys(counts)) counts[key] += result.counts[key];
      for (const item of result.remaining) {
        remaining++;
        console.log(`${relative(ROOT, file)}:${item.line}: unconverted: ${item.declaration}`);
      }
    }
  }
  console.log(`hairlines: ${check ? 'would rewrite' : 'rewrote'} ${files} files; ${counts.edges} edges, ${counts.colors} colors, ${counts.rings} rings; ${remaining} unconverted declarations`);
  if (check && files) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
