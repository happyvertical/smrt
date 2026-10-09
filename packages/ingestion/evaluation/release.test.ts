import { expect, test } from 'vitest';
import {
  AGGREGATE_CAP,
  assertPaidRelease,
  LIVE_LEDGER,
  scheduleBound,
} from './release.mjs';

test('paid release binds exact source/build/protocol/corpus/profile and cannot raise the canonical aggregate cap', () => {
  const hashes = Object.fromEntries(
    [
      'profileSha256',
      'protocolSha256',
      'manifestSha256',
      'feedbackManifestSha256',
      'sourceTreeSha256',
      'builtTreeSha256',
    ].map((key) => [key, 'a'.repeat(64)]),
  );
  const frozen = {
    ...hashes,
    gitHead: 'b'.repeat(40),
    workingTreeClean: true,
    profileStatus: 'frozen-awaiting-release',
  };
  const release = {
    ...hashes,
    gitHead: frozen.gitHead,
    workingTreeClean: true,
    allowPaidCalls: true,
    aggregateCapNanoUSD: AGGREGATE_CAP,
    ledgerPath: LIVE_LEDGER,
    startingChargedNanoUSD: 0,
    startingCalls: 0,
  };
  expect(assertPaidRelease(release, frozen).runHash).toMatch(/^[a-f0-9]{64}$/);
  for (const changed of [
    { allowPaidCalls: false },
    { gitHead: 'c'.repeat(40) },
    { workingTreeClean: false },
    { aggregateCapNanoUSD: AGGREGATE_CAP + 1 },
    { ledgerPath: '/tmp/new-ledger' },
    { sourceTreeSha256: 'b'.repeat(64) },
    { startingCalls: 1 },
  ])
    expect(() =>
      assertPaidRelease({ ...release, ...changed }, frozen),
    ).toThrow();
  expect(() =>
    assertPaidRelease(release, { ...frozen, workingTreeClean: false }),
  ).toThrow('clean repository HEAD');
  expect(() =>
    assertPaidRelease(release, { ...frozen, gitHead: 'c'.repeat(40) }),
  ).toThrow('clean repository HEAD');
  expect(
    assertPaidRelease(
      { ...release, gitHead: 'c'.repeat(40) },
      { ...frozen, gitHead: 'c'.repeat(40) },
    ).runHash,
  ).not.toBe(assertPaidRelease(release, frozen).runHash);
  expect(() =>
    assertPaidRelease(release, {
      ...frozen,
      profileStatus: 'not-approved-for-inference',
    }),
  ).toThrow();
});
test('aggregate frozen schedule includes all media and the feedback reserve without calibration/retry allowance', () => {
  const cases = Array.from({ length: 300 }, (_, index) => ({
    partition: 'heldout',
    lane: index < 280 ? 'provider-quality' : 'deterministic-fault',
    sources: [
      {
        mediaType:
          index < 28 ? 'image/png' : index < 56 ? 'audio/wav' : 'text/plain',
      },
    ],
  }));
  const feedback = {
    cases: Array.from({ length: 11 }, () => ({
      source: { mediaType: 'text/plain' },
    })),
  };
  expect(scheduleBound({ cases }, feedback)).toMatchObject({
    heldoutMaximum: 4596774000,
    feedbackMaximum: 122496000,
    maximumWithReserve: 4996774000,
  });
  expect(() =>
    scheduleBound({ cases: [...cases, cases[0]] }, feedback),
  ).toThrow();
  expect(() =>
    scheduleBound({ cases }, { cases: [...feedback.cases, feedback.cases[0]] }),
  ).toThrow();
});
