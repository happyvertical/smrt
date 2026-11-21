#!/usr/bin/env node
/**
 * Served-surface gate: compares what every package serves on REST, MCP and
 * CLI with the committed `served-surface/` snapshot (see
 * scripts/lib/served-surface.mjs and docs/content/standards.md).
 *
 * Usage:
 *   pnpm check:served-surface                 # turbo build, then check
 *   pnpm surface:served                       # turbo build, then rewrite
 *   node scripts/check-served-surface.mjs --no-build   # CI only (CI=true)
 *   ... --loader-parity                       # also import each built root
 *   ... --loader-parity --repin               # rewrite the pinned difference
 *                                             # of listed ids that moved
 *   node scripts/check-served-surface.mjs --against <ref>  # CI: the parity
 *                                             # list gained no id (no build);
 *                                             # re-pins print as review items
 *   ... --root DIR
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFirst,
  checkParityKnownAgainst,
  planEntry,
  runServedSurface,
} from './lib/served-surface.mjs';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const root =
  rootFlag === -1
    ? path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    : path.resolve(argv[rootFlag + 1]);

const plan = planEntry(argv, process.env);
if (plan.error) {
  console.error(`check-served-surface: ${plan.error}`);
  process.exit(1);
}
if (plan.against) {
  const result = checkParityKnownAgainst({ root, ref: plan.against });
  // A re-pin passes but must be seen: printed on every run, and as a
  // workflow annotation on GitHub Actions.
  if (result.reviewItems.length > 0) {
    console.log(
      `check-served-surface: REVIEW REQUIRED: ${result.reviewItems.length} loader-parity entr${result.reviewItems.length === 1 ? 'y was' : 'ies were'} re-pinned since ${plan.against}. A reviewer must confirm each new difference:`,
    );
    for (const item of result.reviewItems) {
      console.log(`  ${item}`);
      if (process.env.GITHUB_ACTIONS === 'true')
        console.log(
          `::warning title=Loader-parity re-pin needs review::${item.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`,
        );
    }
  }
  if (!result.ok) {
    console.error('check-served-surface: FAIL');
    for (const error of result.errors) console.error(`\n${error}`);
    process.exit(1);
  }
  console.log(
    `check-served-surface: the loader-parity list holds no id beyond ${plan.against}.`,
  );
  process.exit(0);
}
if (plan.build && !buildFirst(root)) {
  console.error('check-served-surface: turbo build failed.');
  process.exit(1);
}
const result = await runServedSurface({
  root,
  write: plan.write,
  loaderParity: plan.loaderParity,
  repin: plan.repin,
});
for (const warning of result.warnings) console.warn(`warning: ${warning}`);
if (!result.ok) {
  console.error('check-served-surface: FAIL');
  for (const error of result.errors) console.error(`\n${error}`);
  process.exit(1);
}
console.log(
  plan.write
    ? `check-served-surface: wrote ${result.wrote.length} file(s) under served-surface/.`
    : `check-served-surface: served-surface/ matches ${Object.keys(result.files).length} package(s).`,
);
