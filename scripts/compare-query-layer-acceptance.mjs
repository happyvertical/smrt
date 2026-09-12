#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [beforePath, afterPath, expectedCandidate] = process.argv.slice(2);
assert(
  beforePath && afterPath && expectedCandidate,
  'Usage: node scripts/compare-query-layer-acceptance.mjs BEFORE.json AFTER.json EXPECTED_CANDIDATE_SHA',
);
assert.match(expectedCandidate, /^[a-f0-9]{40}$/, 'Expected full candidate SHA');
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));
assert.equal(
  before.revision,
  'cc355e952516990f82419eaed566f8c8b6855469',
  'Expected exact pre-epic baseline',
);
assert.equal(after.revision, expectedCandidate, 'Expected exact candidate revision');
assert.equal(before.fixture, after.fixture);
assert.match(
  before.harnessSha256,
  /^[a-f0-9]{64}$/,
  'Baseline must bind its harness',
);
assert.equal(
  before.harnessSha256,
  after.harnessSha256,
  'Identical harness and fixture required',
);
assert.equal(before.dialect, after.dialect);
for (const name of ['catalog', 'panels', 'warmPanels']) {
  assert.deepEqual(before[name].result, after[name].result, `${name}: result parity`);
  for (const report of [before, after]) {
    assert.equal(report[name].statementCount, report[name].statements.length);
  }
}
for (const report of [before, after]) {
  assert.equal(report.warmPanels.statementCount, 0, 'Warm panel must execute no SQL');
  assert.equal(
    report.totalRequestStatements,
    report.catalog.statementCount + report.panels.statementCount,
    'Request total must equal its components',
  );
  assert(
    report.catalog.statementCount > 0 && report.panels.statementCount > 0,
    'Cold request components must execute SQL',
  );
}
const catalogReduction = before.catalog.statementCount / after.catalog.statementCount;
const requestReduction = before.totalRequestStatements / after.totalRequestStatements;
assert(
  catalogReduction >= 10,
  `Catalog reduction ${catalogReduction.toFixed(2)}x is below 10x`,
);
assert(
  requestReduction >= 10,
  `Request reduction ${requestReduction.toFixed(2)}x is below 10x`,
);
console.log(JSON.stringify({
  dialect: after.dialect,
  baseline: before.revision,
  framework: after.revision,
  catalogReduction,
  requestReduction,
  before: before.totalRequestStatements,
  after: after.totalRequestStatements,
}, null, 2));
