#!/usr/bin/env node
/**
 * Codex instruction-chain size guardrail (happyvertical/smrt#2106).
 *
 * An agent reading `packages/<pkg>` is handed every `AGENTS.md` from the repo
 * root down to that package directory. The org-wide `hv-agent audit` caps that
 * concatenated chain at 32 KB and fails the `lifecycle` check when any package
 * breaches it — and because the root `AGENTS.md` is in *every* chain, one
 * oversized package doc fails lifecycle on every agent PR in the repo, not just
 * PRs that touch that package.
 *
 * This mirrors hv-agent's computation so the breach surfaces here, on the PR
 * that grew the doc, instead of as an opaque lifecycle failure on someone
 * else's unrelated PR. Growing the root file is the expensive move: it is taxed
 * once per package.
 *
 * Fix a failure by trimming redundancy — `AGENTS.md` files are canonical expert
 * documentation, so cut what repeats elsewhere in the chain rather than
 * deleting load-bearing architectural facts.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CHAIN_MAX = 32 * 1024;

// Mirrors hv-agent's INSTRUCTION_SCAN_IGNORES.
const IGNORES = new Set([
  '.git', '.hg', '.svn', '.pnpm', '.venv', '.yarn',
  'build', 'coverage', 'dist', 'node_modules', 'venv',
]);

/** Every AGENTS.md in the repo, as paths relative to ROOT. */
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
    `✗ agents-chain: Codex instruction chain exceeds ${CHAIN_MAX} bytes (#2106).\n`,
  );
  for (const { file, bytes } of over) {
    console.error(`  ${file}: ${bytes} bytes — over by ${bytes - CHAIN_MAX}`);
  }
  console.error(
    '\nThe chain is the root AGENTS.md plus every AGENTS.md down to the package.\n' +
      'Trim redundancy in the package file, or in the root file to buy headroom\n' +
      'for all packages at once. Leaving this unfixed fails the `lifecycle` check\n' +
      'on every agent PR in the repo, not just PRs touching this package.',
  );
  process.exit(1);
}

const worst = rows[0];
console.log(
  `✓ agents-chain: ${rows.length} chains under ${CHAIN_MAX} bytes ` +
    `(largest ${worst.file} at ${worst.bytes}, ${CHAIN_MAX - worst.bytes} headroom).`,
);
