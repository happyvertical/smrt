#!/usr/bin/env node
/** Reproduce the pre-#3881 experiment without modifying a working-tree component. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codemodSource } from './codemod-smrt-sort-layers.mjs';
import { declarationRecords, ROOT } from './smrt-sort-layers-lib.mjs';

export const PILOT_PATHS = ['ui/Button', 'ui/Badge', 'ui/Chip', 'ui/Card', 'feedback/Alert',
  'forms/Input', 'forms/Select', 'forms/Checkbox', 'forms/Switch', 'nav/Tabs'];
const mapping = JSON.parse(readFileSync(new URL('./smrt-sort-pilot-map.json', import.meta.url), 'utf8'));
// Preserve quoted strings (including their whitespace) while normalizing CSS trivia.
const compact = (text) => text.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)
  .map((part, index) => index % 2 ? part : part.replace(/\s+/g, ' ').replace(/\s*([,:()>+~])\s*/g, '$1')).join('').trim();

/** Class names only: fallback removals/private token changes remain visible differences. */
export function normalizeRecord(record, name, old = false) {
  return { ...record, path: record.path.map((part) => compact(old ? part.replace(/\.([a-zA-Z_][\w-]*)/g,
    (match, cls) => mapping[name][cls] ? `.smrt-${name.toLowerCase()}__${mapping[name][cls]}` : match) : part)),
    value: compact(record.value) };
}

export function comparePilot(before, hand, name) {
  const result = codemodSource(before);
  const auto = declarationRecords(result.source).map((record) => normalizeRecord(record, name, true));
  const remaining = declarationRecords(hand).map((record) => normalizeRecord(record, name));
  const sameSlot = (a, b) => a.property === b.property && JSON.stringify(a.path) === JSON.stringify(b.path);
  const sameValue = (a, b) => sameSlot(a, b) && a.value === b.value;
  const todos = [];
  const identical = [];
  const differences = [];
  for (const record of auto) {
    const todo = result.todos.find((item) => record.line === item.line + 1);
    let index = remaining.findIndex((candidate) => sameValue(record, candidate) && record.layer === candidate.layer);
    if (index === -1) index = remaining.findIndex((candidate) => sameValue(record, candidate));
    if (index === -1) index = remaining.findIndex((candidate) => sameSlot(record, candidate));
    const expected = index === -1 ? null : remaining.splice(index, 1)[0];
    if (todo) todos.push({ ...record, reason: todo.reason, hand: expected });
    else if (expected && sameValue(record, expected) && record.layer === expected.layer) identical.push(record);
    else differences.push({ auto: record, hand: expected, reason: !expected ? 'no matching hand-sorted selector/property' : record.layer !== expected.layer ? 'layer differs' : 'value differs' });
  }
  // This experiment's pilots contain declaration TODOs only; never hide a future
  // parser/wrapper TODO by counting just the declarations successfully visited.
  if (todos.length !== result.todos.length) throw new Error(`${name}: unaccounted TODO; inspect codemod report`);
  if (auto.length !== declarationRecords(before).length) throw new Error(`${name}: declaration count changed`);
  return { component: name, sourceDeclarations: auto.length, identical, differences, todos, handOnly: remaining,
    output: result.source };
}

export function pilotMarkdown(results) {
  const lines = ['| Component | Same layer | Wrong layer | TODO | Value differences | Hand-only |', '|---|---:|---:|---:|---:|---:|'];
  for (const row of results) {
    const values = row.differences.filter((item) => item.reason === 'value differs').length;
    lines.push(`| ${row.component} | ${row.identical.length + values} | ${row.differences.length - values} | ${row.todos.length} | ${values} | ${row.handOnly.length} |`);
  }
  lines.push('', 'Comparison normalizes the explicit #3881 class mapping and CSS whitespace, and ignores declaration order within each layer. Values are compared strictly: token fallback removals and private density-token changes are reported, not normalized away. TODO declarations remain in their original theme block pending human judgment. Hand-only counts expose added/changed selector rules.', '');
  const describe = (r) => `${r.path.join(' / ')} — ${r.property}: ${r.value} [${r.layer}]`;
  for (const row of results) {
    lines.push(`<details><summary>${row.component}: differences and TODOs</summary>`, '');
    if (!row.differences.length) lines.push('No automatically placed differences.', '');
    for (const difference of row.differences) lines.push(`- ${difference.reason}: \`${describe(difference.auto)}\`${difference.hand ? ` → \`${difference.hand.value}\` [${difference.hand.layer}]` : ''}`);
    for (const todo of row.todos) lines.push(`- TODO: \`${describe(todo)}\` (${todo.reason}; hand: ${todo.hand?.layer ?? 'no matching selector/property'})`);
    for (const item of row.handOnly) lines.push(`- Hand-only: \`${describe(item)}\``);
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--report') throw new Error('Usage: node scripts/compare-smrt-sort-pilot.mjs --report /tmp/pilot.json');
  const report = resolve(args[1]);
  if (report.startsWith(`${ROOT}/`)) throw new Error('Keep experiment output outside the repository');
  const fixtures = `${report}.fixtures`;
  mkdirSync(fixtures, { recursive: true });
  const results = PILOT_PATHS.map((path) => {
    const file = `packages/smrt-ui/src/components/${path}.svelte`;
    const before = execFileSync('git', ['show', `716e55114:${file}`], { cwd: ROOT, encoding: 'utf8' });
    const hand = readFileSync(join(ROOT, file), 'utf8');
    const name = basename(path);
    writeFileSync(join(fixtures, `${name}.before.svelte`), before);
    const { output, ...result } = comparePilot(before, hand, name);
    writeFileSync(join(fixtures, `${name}.sorted.svelte`), output);
    return result;
  });
  writeFileSync(report, `${JSON.stringify({ base: '716e55114', hand: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), results }, null, 2)}\n`);
  writeFileSync(`${report}.md`, pilotMarkdown(results));
  console.log(pilotMarkdown(results).split('<details>')[0]);
  console.log(`Full differences: ${report}; PR table/details: ${report}.md; fixtures: ${fixtures}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
