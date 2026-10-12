#!/usr/bin/env node
/**
 * Lint gate for the smrt cascade-layer contract (#3823).
 *
 * Fails when any component `<style>` block under `packages/*\/src` has a
 * top-level rule outside an `@layer smrt.*` block, or when smrt-ui's
 * `src/styles/layers.css` no longer declares the layer order. Runs inside
 * root `pnpm lint`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlayeredCssItems } from './cascade-layers-css.mjs';
import {
  SMRT_CASCADE_LAYERS_DECLARATION,
  classifyStyleBody,
  extractStyleBlocks,
  hasOrderDeclaration,
} from './cascade-layers-lib.mjs';
import { listCssStylesheets, listSvelteSources } from './codemod-smrt-layers.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LAYERS_CSS = join(ROOT, 'packages/smrt-ui/src/styles/layers.css');

/**
 * @param {Record<string, string>} files relative path -> source
 * @returns {string[]} human-readable violations
 */
export function findViolations(files) {
  const violations = [];
  for (const [rel, source] of Object.entries(files)) {
    if (rel.endsWith('.css')) {
      try {
        if (unlayeredCssItems(source).length > 0) {
          violations.push(`${rel}: stylesheet rules are not inside @layer smrt.*; run node scripts/codemod-smrt-layers.mjs`);
        } else if (/@layer smrt\./.test(source) && !hasOrderDeclaration(source)) {
          violations.push(`${rel}: stylesheet lacks the layer order declaration`);
        }
      } catch (error) {
        violations.push(`${rel}: ${error.message}`);
      }
      continue;
    }
    let blocks;
    try {
      blocks = extractStyleBlocks(source);
    } catch (error) {
      violations.push(`${rel}: ${error.message}`);
      continue;
    }
    for (const block of blocks) {
      let status;
      try {
        status = classifyStyleBody(block.body).status;
      } catch (error) {
        violations.push(`${rel}: ${error.message}`);
        continue;
      }
      if (status === 'unlayered') {
        violations.push(`${rel}: <style> body is not inside @layer smrt.*; run node scripts/codemod-smrt-layers.mjs`);
      } else if (status === 'mixed') {
        violations.push(`${rel}: <style> mixes top-level smrt layer and unlayered rules`);
      } else if (status === 'layered' && !hasOrderDeclaration(block.body)) {
        violations.push(`${rel}: <style> lacks the layer order declaration (first-appearance order would be wrong)`);
      }
    }
  }
  return violations;
}

function main() {
  const packagesDir = join(ROOT, 'packages');
  const files = {};
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of listSvelteSources(src)) {
      files[relative(ROOT, file)] = readFileSync(file, 'utf8');
    }
  }

  for (const file of listCssStylesheets(packagesDir)) {
    files[relative(ROOT, file)] = readFileSync(file, 'utf8');
  }

  const violations = findViolations(files);

  try {
    const layersCss = readFileSync(LAYERS_CSS, 'utf8');
    if (!layersCss.includes(SMRT_CASCADE_LAYERS_DECLARATION)) {
      violations.push(
        `${relative(ROOT, LAYERS_CSS)}: missing layer order declaration "${SMRT_CASCADE_LAYERS_DECLARATION}"`,
      );
    }
  } catch {
    violations.push(`${relative(ROOT, LAYERS_CSS)}: missing`);
  }

  if (violations.length > 0) {
    console.error('smrt cascade layers: violations found');
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log(`smrt cascade layers: ${Object.keys(files).length} svelte file(s) checked, all <style> blocks layered`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
