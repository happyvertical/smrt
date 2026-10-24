import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createValidationReceipt,
  validationReceiptSha256,
  verifyValidationReceipt,
} from './validation-receipt.mjs';

const sha = (character) => character.repeat(64);
const git = (character) => character.repeat(40);

function fixture() {
  const identity = {
    source: { repository: 'happyvertical/smrt', commit: git('a'), tree: git('b') },
    lockSha256: sha('c'),
    toolchain: { node: '26.12.1', pnpm: '11.25.0', platform: 'linux-x64' },
    inputs: { workflowSha256: sha('d'), validatorSha256: sha('e') },
    comparisonBase: git('f'),
    selectedSuites: ['packed-http-vite7', 'packed-http-vite8'],
    artifacts: [{ name: 'smrt-ui.tgz', sha256: sha('1') }],
    externalInputs: [],
  };
  const producer = { workflow: '.github/workflows/on-pull-request.yml', runId: 40099394984, runAttempt: 1 };
  const receipt = createValidationReceipt({ identity, producer });
  return {
    receipt,
    options: {
      expectedIdentity: structuredClone(identity),
      expectedProducer: structuredClone(producer),
      authenticatedProducer: {
        ...producer,
        authenticated: true,
        repository: identity.source.repository,
        headSha: identity.source.commit,
        receiptSha256: validationReceiptSha256(receipt),
        status: 'completed',
        conclusion: 'success',
        event: 'merge_group',
        ref: 'refs/heads/gh-readonly-queue/main/pr-4303-example',
        trustedRef: true,
        completedAt: '2026-10-24T13:00:00Z',
      },
    },
  };
}

function reject(receipt, options, reason) {
  const result = verifyValidationReceipt(receipt, options);
  assert.equal(result.reuse, false);
  assert.ok(result.reasons.length > 0);
  if (reason) assert.match(result.reasons.join('; '), reason);
}

test('exact independently authenticated identity permits merge-group or trusted push reuse', () => {
  const { receipt, options } = fixture();
  assert.deepEqual(verifyValidationReceipt(receipt, options), { reuse: true, reasons: [] });
  options.authenticatedProducer.event = 'push';
  options.authenticatedProducer.ref = 'refs/heads/main';
  assert.equal(verifyValidationReceipt(receipt, options).reuse, true);
});

test('creation is deterministic, detached and inventory-order independent', () => {
  const { receipt } = fixture();
  const identity = structuredClone(receipt.identity);
  identity.selectedSuites.reverse();
  identity.artifacts.push({ name: 'smrt-core.tgz', sha256: sha('2') });
  const first = createValidationReceipt({ identity, producer: receipt.producer });
  identity.artifacts.reverse();
  const second = createValidationReceipt({ producer: receipt.producer, identity });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(validationReceiptSha256(first), validationReceiptSha256(second));
  identity.source.commit = git('0');
  assert.equal(first.identity.source.commit, git('a'));
});

const changedIdentity = [
  ['repository', (i) => { i.source.repository = 'other/smrt'; }],
  ['commit', (i) => { i.source.commit = git('0'); }],
  ['tree', (i) => { i.source.tree = git('0'); }],
  ['lock', (i) => { i.lockSha256 = sha('0'); }],
  ['node', (i) => { i.toolchain.node = '26.12.2'; }],
  ['pnpm', (i) => { i.toolchain.pnpm = '11.25.1'; }],
  ['platform', (i) => { i.toolchain.platform = 'linux-arm64'; }],
  ['workflow inputs', (i) => { i.inputs.workflowSha256 = sha('0'); }],
  ['validator inputs', (i) => { i.inputs.validatorSha256 = sha('0'); }],
  ['comparison base', (i) => { i.comparisonBase = git('0'); }],
  ['missing suite', (i) => { i.selectedSuites.pop(); }],
  ['extra suite', (i) => { i.selectedSuites.push('postgres'); }],
  ['artifact bytes', (i) => { i.artifacts[0].sha256 = sha('0'); }],
  ['artifact inventory', (i) => { i.artifacts.push({ name: 'other.tgz', sha256: sha('0') }); }],
  ['external inputs', (i) => { i.externalInputs.push({ name: 'catalog-snapshot', sha256: sha('0') }); }],
];
for (const [name, change] of changedIdentity) {
  test(`rejects changed ${name} even for a successful authenticated run`, () => {
    const { receipt, options } = fixture();
    change(options.expectedIdentity);
    reject(receipt, options, /mismatch|coverage/);
  });
}

test('content-addressed external inputs may reuse only with exact known coverage', () => {
  const { receipt, options } = fixture();
  receipt.identity.externalInputs = [{ name: 'immutable-catalog', sha256: sha('3') }];
  options.expectedIdentity.externalInputs = structuredClone(receipt.identity.externalInputs);
  options.authenticatedProducer.receiptSha256 = validationReceiptSha256(receipt);
  assert.equal(verifyValidationReceipt(receipt, options).reuse, true);
  options.expectedIdentity.externalInputs[0].sha256 = null;
  reject(receipt, options, /unknown or invalid sha256/);
});

test('receipt JSON and matching run metadata without authenticated content binding are insufficient', () => {
  const { receipt, options } = fixture();
  reject(receipt);
  reject(receipt, { ...options, authenticatedProducer: undefined }, /authenticated evidence/);
  delete options.authenticatedProducer.receiptSha256;
  reject(receipt, options, /authenticated receipt digest/);
});

test('forging a receipt to match candidate bytes fails the authenticated digest binding', () => {
  const { receipt, options } = fixture();
  receipt.identity.artifacts[0].sha256 = sha('0');
  options.expectedIdentity.artifacts[0].sha256 = sha('0');
  reject(receipt, options, /authenticated receipt digest/);
});

const invalidFacts = [
  ['authentication', 'authenticated', false],
  ['repository', 'repository', 'fork/smrt'],
  ['workflow', 'workflow', '.github/workflows/other.yml'],
  ['run', 'runId', 1],
  ['attempt', 'runAttempt', 2],
  ['source commit', 'headSha', git('0')],
  ['queued run', 'status', 'queued'],
  ['failed run', 'conclusion', 'failure'],
  ['cancelled run', 'conclusion', 'cancelled'],
  ['skipped run', 'conclusion', 'skipped'],
  ['PR producer', 'event', 'pull_request'],
  ['trusted-base PR producer', 'event', 'pull_request_target'],
  ['manual producer', 'event', 'workflow_dispatch'],
  ['untrusted ref', 'trustedRef', false],
  ['missing ref', 'ref', ''],
];
for (const [name, field, value] of invalidFacts) {
  test(`rejects ${name}`, () => {
    const { receipt, options } = fixture();
    options.authenticatedProducer[field] = value;
    reject(receipt, options);
  });
}

test('separately expected producer cannot be substituted by receipt provenance', () => {
  for (const field of ['workflow', 'runId', 'runAttempt']) {
    const { receipt, options } = fixture();
    receipt.producer[field] = field === 'workflow' ? 'forged.yml' : 2;
    options.authenticatedProducer.receiptSha256 = validationReceiptSha256(receipt);
    reject(receipt, options, /producer.*mismatch/);
  }
});

test('caller expiry policy rejects stale or future producer times', () => {
  const { receipt, options } = fixture();
  options.policy = { maxAgeMs: 60_000, nowMs: Date.parse('2026-10-24T13:01:00Z') };
  assert.equal(verifyValidationReceipt(receipt, options).reuse, true);
  options.policy.nowMs += 1;
  reject(receipt, options, /stale/);
  options.policy.nowMs = Date.parse('2026-10-24T12:59:00Z');
  reject(receipt, options, /future/);
  options.policy = { maxAgeMs: -1, nowMs: 0 };
  reject(receipt, options, /policy/);
  options.policy = { nowMs: 0 };
  reject(receipt, options, /policy/);
  options.policy = { maxAgeMs: 60_000, nowMs: Date.parse('2026-10-24T13:01:00Z') };
  delete options.authenticatedProducer.completedAt;
  reject(receipt, options, /completion time/);
});

test('malformed and missing identities fail closed without a success fallback', () => {
  const malformed = [null, [], {}, { schemaVersion: 1 }, 'receipt'];
  for (const receipt of malformed) reject(receipt, fixture().options);
  for (const field of Object.keys(fixture().receipt.identity)) {
    const { receipt, options } = fixture();
    delete receipt.identity[field];
    reject(receipt, options);
  }
  const mutations = [
    (r) => { r.schemaVersion = 2; },
    (r) => { r.policy = { maxAgeMs: Infinity }; },
    (r) => { r.identity.artifacts = []; },
    (r) => { r.identity.selectedSuites = []; },
    (r) => { r.identity.selectedSuites.push(r.identity.selectedSuites[0]); },
    (r) => { r.identity.artifacts[0].sha256 = 'unknown'; },
    (r) => { r.identity.externalInputs = [{ name: 'live-planner' }]; },
    (r) => { r.identity.toolchain.node = '>=26'; },
    (r) => { r.producer.runAttempt = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const mutate of mutations) {
    const { receipt, options } = fixture();
    mutate(receipt);
    reject(receipt, options);
  }
  reject(fixture().receipt, null);
  assert.throws(() => createValidationReceipt(), TypeError);
});
