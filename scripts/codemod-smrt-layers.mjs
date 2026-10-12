#!/usr/bin/env node
/**
 * Wrap every unlayered component `<style>` body in `@layer smrt.theme { … }`
 * (#3823). Idempotent: a body that is already layered is left byte-identical,
 * so a second run is a no-op.
 *
 * Usage:
 *   node scripts/codemod-smrt-layers.mjs            # rewrite packages/*\/src
 *   node scripts/codemod-smrt-layers.mjs --check    # report only, exit 1 if any change is pending
 *
 * Exits 1 on refused blocks (top-level @import/@charset, mixed layered and
 * unlayered rules, unsupported <style> attributes). Those need a hand fix.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyStyleBody,
  extractStyleBlocks,
  hasLayerIncompatibleItem,
  wrapInThemeLayer,
} from './cascade-layers-lib.mjs';
import { wrapCssInLayer } from './cascade-layers-css.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Global preset and base stylesheets shipped from smrt-ui. Rules in them
 * compete with component styles, so they need an smrt layer too.
 *
 * @param {string} packagesDir
 * @returns {string[]}
 */
export function listCssStylesheets(packagesDir) {
  const out = [];
  for (const pkg of readdirSync(packagesDir)) {
    const dir = join(packagesDir, pkg, 'src', 'themes', 'styles');
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith('.css')) out.push(join(dir, entry));
      }
    } catch {
      // package without a themes/styles directory
    }
  }
  return out.sort();
}

/** @param {string} dir @returns {string[]} */
export function listSvelteSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listSvelteSources(full));
    else if (entry.endsWith('.svelte')) out.push(full);
  }
  return out.sort();
}

/**
 * Rewrite one `.svelte` source. Returns the new source plus per-file problems.
 * Pure function so the tests can exercise it without touching the disk.
 *
 * @param {string} source
 * @returns {{ source: string, changed: boolean, problems: string[] }}
 */
export function codemodSource(source) {
  const blocks = extractStyleBlocks(source);
  const problems = [];
  let out = '';
  let cursor = 0;
  let changed = false;

  for (const block of blocks) {
    const { status, items } = classifyStyleBody(block.body);
    out += source.slice(cursor, block.bodyStart);
    cursor = block.bodyEnd;

    if (status === 'unlayered') {
      if (hasLayerIncompatibleItem(items)) {
        problems.push('top-level @import/@charset cannot be wrapped; move it out of the <style> block by hand');
        out += block.body;
      } else {
        out += wrapInThemeLayer(block.body);
        changed = true;
      }
    } else if (status === 'mixed') {
      problems.push('mixed top-level smrt layer and unlayered rules; split by hand');
      out += block.body;
    } else {
      out += block.body;
    }
  }

  out += source.slice(cursor);
  return { source: changed ? out : source, changed, problems };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const packagesDir = join(ROOT, 'packages');
  const files = [];
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) files.push(...listSvelteSources(src));
    } catch {
      // package without a src directory
    }
  }

  let rewritten = 0;
  let failures = 0;
  for (const file of listCssStylesheets(packagesDir)) {
    const original = readFileSync(file, 'utf8');
    const layer = basename(file) === 'base.css' ? 'reset' : 'theme';
    const next = wrapCssInLayer(original, layer);
    if (next !== original) {
      rewritten++;
      if (!checkOnly) writeFileSync(file, next);
    }
  }
  for (const file of files) {
    const original = readFileSync(file, 'utf8');
    let result;
    const rel = relative(ROOT, file);
    try {
      result = codemodSource(original);
    } catch (error) {
      failures++;
      console.error(`${rel}: ${error.message}`);
      continue;
    }
    for (const problem of result.problems) {
      failures++;
      console.error(`${rel}: ${problem}`);
    }
    if (result.changed) {
      rewritten++;
      if (!checkOnly) writeFileSync(file, result.source);
    }
  }

  const verb = checkOnly ? 'would wrap' : 'wrapped';
  console.log(`cascade-layers codemod: ${verb} ${rewritten} file(s); ${failures} refused`);
  if (failures > 0 || (checkOnly && rewritten > 0)) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
