#!/usr/bin/env node
/**
 * Agent instruction-chain size guardrail (happyvertical/smrt#2106, #2108).
 *
 * An agent reading `packages/<pkg>` is handed every `AGENTS.md` from the repo
 * root down to that package directory — the chain is ADDITIVE, so the root file
 * is taxed once per package and a nested `AGENTS.md` only ever makes a path
 * bigger. The org-wide `hv-agent audit` caps that concatenated chain at 32 KB
 * and reports an error above it.
 *
 * This check fails above the cap and runs in repository CI and pre-push.
 * The 80% threshold is advisory. It measures AGENTS ancestry only, not
 * shared skills, harness rules, or expanded module-document tool results.
 *
 * This mirrors hv-agent's computation so a doc addition that would breach the
 * org gate surfaces here, on the PR that grew the doc. The WARN threshold
 * (80% of the cap) exists so the next package approaching the gate is visible
 * before it breaches.
 *
 * Remove stale or redundant prose first. Keep orientation, cross-module
 * invariants, and validation inline; place detailed current contracts in
 * linked `packages/<pkg>/agents/<module>.md` references. Preserve distinct
 * behavioral constraints when shortening or moving documentation.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CHAIN_MAX = 32 * 1024;
const WARN_RATIO = 0.8;
const CHAIN_WARN = Math.floor(CHAIN_MAX * WARN_RATIO);

// Mirrors hv-agent's INSTRUCTION_SCAN_IGNORES.
const IGNORES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.pnpm',
  '.venv',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'venv',
]);

/** Every AGENTS.md in the repo, as absolute paths. */
function findAgentsFiles(dir = ROOT, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORES.has(entry.name)) continue;
      findAgentsFiles(join(dir, entry.name), found);
    } else if (entry.name === 'AGENTS.md') {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const sizes = new Map();
function sizeOf(path) {
  if (!sizes.has(path)) {
    try {
      sizes.set(path, statSync(path).size);
    } catch {
      sizes.set(path, 0);
    }
  }
  return sizes.get(path);
}

/** Sum of every AGENTS.md from ROOT down to the file's own directory. */
function chainFor(agentsFile) {
  const chain = [];
  let current = dirname(agentsFile);
  while (current === ROOT || current.startsWith(ROOT + sep)) {
    const candidate = join(current, 'AGENTS.md');
    if (sizeOf(candidate) > 0) chain.push(candidate);
    if (current === ROOT) break;
    current = dirname(current);
  }
  return chain;
}

const rows = findAgentsFiles()
  .map((file) => {
    const chain = chainFor(file);
    return {
      file: relative(ROOT, file),
      bytes: chain.reduce((sum, path) => sum + sizeOf(path), 0),
    };
  })
  .sort((a, b) => b.bytes - a.bytes);

const over = rows.filter((row) => row.bytes > CHAIN_MAX);

if (over.length > 0) {
  console.error(
    `✗ agents-chain: instruction chain exceeds ${CHAIN_MAX} bytes (#2106).\n`,
  );
  for (const { file, bytes } of over) {
    console.error(`  ${file}: ${bytes} bytes — over by ${bytes - CHAIN_MAX}`);
  }
  console.error(
    '\nThe chain is the root AGENTS.md plus every AGENTS.md down to the package.\n' +
      'Split per-module semantics into packages/<pkg>/agents/<module>.md and link\n' +
      'them from a Modules table — keep orientation, cross-module invariants, and\n' +
      'the Gotchas inline. Trimming the root file buys headroom for every package\n' +
      'at once. Never add nested AGENTS.md files: chains are additive.',
  );
  process.exit(1);
}

const warn = rows.filter((row) => row.bytes > CHAIN_WARN);
if (warn.length > 0) {
  console.warn(
    `⚠ agents-chain: ${warn.length} chain(s) above ${WARN_RATIO * 100}% of the ${CHAIN_MAX}-byte cap (#2108).\n` +
      '  Not a failure — split per-module semantics into agents/<module>.md before it becomes one.',
  );
  for (const { file, bytes } of warn) {
    console.warn(
      `  ${file}: ${bytes} bytes — ${CHAIN_MAX - bytes} headroom left`,
    );
  }
  console.warn('');
}

const worst = rows[0];
console.log(
  `✓ agents-chain: ${rows.length} chains under ${CHAIN_MAX} bytes ` +
    `(largest ${worst.file} at ${worst.bytes}, ${CHAIN_MAX - worst.bytes} headroom).`,
);
