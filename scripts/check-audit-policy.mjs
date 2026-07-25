#!/usr/bin/env node
/**
 * Dependency-advisory policy gate (issue #2028).
 *
 * `pnpm audit` tells us WHAT is vulnerable. It cannot tell us whether an
 * accepted risk was ever justified, or whether that justification has gone
 * stale. This script covers that gap.
 *
 * Background — the two failure modes this exists to prevent:
 *
 *   1. SILENT PERMANENT SUPPRESSION. `auditConfig.ignoreGhsas` in
 *      pnpm-workspace.yaml suppresses an advisory for the entire tree, forever,
 *      including dependency paths that do not exist yet. Before #2028 that list
 *      held six protobufjs GHSAs — one of them a critical RCE — with no comment
 *      saying who accepted them, why, or when to look again. They turned out to
 *      be fixable all along.
 *
 *   2. STALE PINS. An override like `'fast-uri@>=3.0.0 <3.1.2': 3.1.3` protects
 *      the tree only until the advisory range grows to include the pinned
 *      target. When that happened, the selector silently stopped matching and
 *      the override kept the tree on a version that was, by then, vulnerable.
 *      `pnpm audit` does catch this — the gate went red — so the guard needed
 *      here is the policy half, not re-detection.
 *
 * Enforced rules:
 *
 *   - Every GHSA in `auditConfig.ignoreGhsas` MUST have a record in
 *     audit-policy.json with `suppressed: true`. No silent suppression.
 *   - Every record MUST carry a non-empty `exploitability` and `decision`, so
 *     "we accepted this" always comes with "here is why".
 *   - Every record MUST carry a `recheckBy` date, and that date MUST NOT be in
 *     the past. An accepted risk expires; it does not become permanent.
 *   - A record marked `suppressed: true` MUST still appear in `ignoreGhsas`,
 *     so removing a suppression also retires its justification.
 *   - GHSA ids must be well-formed and unique.
 *
 * With `--audit` it additionally shells out to `pnpm audit --json` and reports
 * drift in both directions: advisories in the tree with no policy record, and
 * policy records for advisories that are no longer present (safe to delete).
 * That mode needs a registry round-trip, so it is opt-in rather than the
 * default used by the pre-push/CI gate.
 *
 * Exit codes: 0 = clean, 1 = policy violation.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_FILE = join(ROOT, 'pnpm-workspace.yaml');
const POLICY_FILE = join(ROOT, 'audit-policy.json');

const REQUIRED_TEXT_FIELDS = ['package', 'severity', 'exploitability', 'decision'];
const GHSA_PATTERN = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warnings = [];

/**
 * Extracts `auditConfig.ignoreGhsas` without a YAML dependency.
 *
 * The block is a flat list of scalars, so a scoped scan is sufficient and keeps
 * this script dependency-free like its siblings in scripts/. Supports both the
 * inline empty form (`ignoreGhsas: []`) and a block sequence, and tolerates
 * comments and blank lines inside the block.
 */
function readIgnoredGhsas(yamlText) {
  const lines = yamlText.split('\n');
  const start = lines.findIndex((line) => /^\s*ignoreGhsas\s*:/.test(line));
  if (start === -1) return [];

  const declaration = lines[start];
  const inline = declaration.slice(declaration.indexOf(':') + 1).trim();
  if (inline === '[]') return [];
  if (inline.startsWith('[')) {
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  if (inline !== '') {
    errors.push(
      `pnpm-workspace.yaml: unsupported inline value for ignoreGhsas (${inline}). ` +
        'Use `[]` or a block list so this gate can read it.',
    );
    return [];
  }

  const found = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s*['"]?([^'"\s#]+)['"]?/);
    if (item) {
      found.push(item[1]);
      continue;
    }
    // First non-comment, non-item line ends the block.
    break;
  }
  return found;
}

function today() {
  // Date-only comparison in UTC; recheckBy is a calendar date, not an instant.
  return new Date().toISOString().slice(0, 10);
}

function loadPolicy() {
  let raw;
  try {
    raw = readFileSync(POLICY_FILE, 'utf8');
  } catch {
    errors.push(
      'audit-policy.json is missing. It is the record of every accepted advisory; ' +
        'recreate it rather than deleting the gate.',
    );
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    errors.push(`audit-policy.json is not valid JSON: ${error.message}`);
    return null;
  }
}

function validateRecords(policy, ignored) {
  const accepted = Array.isArray(policy.accepted) ? policy.accepted : null;
  if (!accepted) {
    errors.push('audit-policy.json: `accepted` must be an array.');
    return new Map();
  }

  const now = today();
  const byGhsa = new Map();

  for (const [index, record] of accepted.entries()) {
    const label = record?.ghsa ?? `accepted[${index}]`;

    if (!record?.ghsa || !GHSA_PATTERN.test(record.ghsa)) {
      errors.push(`${label}: missing or malformed \`ghsa\` (expected GHSA-xxxx-xxxx-xxxx).`);
      continue;
    }
    if (byGhsa.has(record.ghsa)) {
      errors.push(`${record.ghsa}: duplicate record — merge the two entries.`);
      continue;
    }
    byGhsa.set(record.ghsa, record);

    for (const field of REQUIRED_TEXT_FIELDS) {
      if (typeof record[field] !== 'string' || record[field].trim() === '') {
        errors.push(`${record.ghsa}: \`${field}\` is required and must be a non-empty string.`);
      }
    }

    if (!ISO_DATE_PATTERN.test(record.recheckBy ?? '')) {
      errors.push(`${record.ghsa}: \`recheckBy\` is required as an ISO date (YYYY-MM-DD).`);
    } else if (record.recheckBy < now) {
      errors.push(
        `${record.ghsa}: recheck date ${record.recheckBy} has passed. Re-assess the advisory, ` +
          'then either remediate it or renew the record with a fresh date and rationale.',
      );
    }

    const suppressed = record.suppressed === true;
    if (suppressed && !ignored.includes(record.ghsa)) {
      errors.push(
        `${record.ghsa}: marked \`suppressed: true\` but absent from auditConfig.ignoreGhsas. ` +
          'Drop the flag or restore the suppression.',
      );
    }
    if (!suppressed && ignored.includes(record.ghsa)) {
      errors.push(
        `${record.ghsa}: suppressed in auditConfig.ignoreGhsas but the record says ` +
          '`suppressed: false`. The record must state that the advisory is being hidden.',
      );
    }
  }

  for (const ghsa of ignored) {
    if (!byGhsa.has(ghsa)) {
      errors.push(
        `${ghsa}: suppressed in pnpm-workspace.yaml auditConfig.ignoreGhsas with no record in ` +
          'audit-policy.json. Every suppression needs an exploitability assessment and a ' +
          'recheck date.',
      );
    }
  }

  return byGhsa;
}

/** Opt-in drift check against the live advisory set. */
function checkDrift(byGhsa) {
  let payload;
  try {
    // `pnpm audit` exits non-zero whenever advisories exist, so a thrown error
    // here is the normal path — the JSON we want is still on stdout.
    payload = execFileSync('pnpm', ['audit', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    payload = error.stdout;
  }

  if (!payload) {
    warnings.push('--audit: could not read `pnpm audit --json` output; skipped drift check.');
    return;
  }

  let advisories;
  try {
    advisories = Object.values(JSON.parse(payload).advisories ?? {});
  } catch {
    warnings.push('--audit: could not parse `pnpm audit --json` output; skipped drift check.');
    return;
  }

  const live = new Set(advisories.map((advisory) => advisory.github_advisory_id));

  for (const advisory of advisories) {
    if (!byGhsa.has(advisory.github_advisory_id)) {
      warnings.push(
        `${advisory.github_advisory_id} (${advisory.severity}, ${advisory.module_name}) is present ` +
          'in the tree with no record in audit-policy.json.',
      );
    }
  }

  for (const [ghsa, record] of byGhsa) {
    // Suppressed advisories are filtered out of the audit payload, so their
    // absence proves nothing.
    if (!live.has(ghsa) && record.suppressed !== true) {
      warnings.push(`${ghsa} (${record.package}) is no longer in the tree — its record can be removed.`);
    }
  }
}

const wantsDrift = process.argv.includes('--audit');
const policy = loadPolicy();
let ignored = [];

try {
  ignored = readIgnoredGhsas(readFileSync(WORKSPACE_FILE, 'utf8'));
} catch (error) {
  errors.push(`Could not read pnpm-workspace.yaml: ${error.message}`);
}

if (policy) {
  const byGhsa = validateRecords(policy, ignored);
  if (wantsDrift) checkDrift(byGhsa);
}

for (const warning of warnings) console.warn(`  warn  ${warning}`);

if (errors.length > 0) {
  console.error(`\n✗ Dependency-advisory policy: ${errors.length} problem(s)\n`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error('\nSee audit-policy.json and scripts/check-audit-policy.mjs for the rules.\n');
  process.exit(1);
}

const suppressedCount = ignored.length;
console.log(
  `✓ Dependency-advisory policy: ${policy?.accepted?.length ?? 0} accepted record(s), ` +
    `${suppressedCount} suppression(s), none past recheck.`,
);
