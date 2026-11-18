import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  buildMergedPr,
  buildPackagePublish,
  changelogFromSubjects,
  main,
  send,
  sign,
} from './send-work-release-event.mjs';

test('signature matches the receiver algorithm', () => {
  const body = Buffer.from('{"a":1}');
  const expected = `v1=${createHmac('sha256', 's3cret').update('1700000000.').update(body).digest('hex')}`;
  assert.equal(sign('s3cret', '1700000000', body), expected);
  assert.match(expected, /^v1=[a-f0-9]{64}$/u);
});

test('changelog maps squash subjects to PR links and drops release commits', () => {
  const { changelog, prUrls } = changelogFromSubjects(
    ['feat(x): thing (#12)', 'chore(release): v1 [skip ci]', 'fix: y'],
    'o/r',
  );
  assert.deepEqual(changelog, ['feat(x): thing (#12)', 'fix: y']);
  assert.deepEqual(prUrls, ['https://github.com/o/r/pull/12']);
});

test('body respects receiver limits', () => {
  const subjects = Array.from({ length: 100 }, (_, i) => `feat: ${'x'.repeat(2000)} (#${i})`);
  const body = buildPackagePublish({ pkg: 'smrt', version: '1.0.0', repo: 'o/r', releaseUrl: 'https://x.test/r', subjects });
  assert.ok(body.changelog.length <= 40);
  assert.ok(body.changelog.every((l) => l.length <= 1000));
  assert.ok(body.prUrls.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 32 * 1024);
});

test('send posts signed bytes with both headers', async () => {
  let seen;
  const status = await send({
    body: { package: 'p', version: '1' },
    secret: ' k \n',
    url: 'https://x.test/e',
    now: 1_700_000_000_000,
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { status: 200 };
    },
  });
  assert.equal(status, 200);
  assert.equal(seen.init.headers['x-hv-release-timestamp'], '1700000000');
  assert.equal(seen.init.headers['x-hv-release-signature'], sign('k', '1700000000', seen.init.body));
});

test('missing secret skips and never fails', async () => {
  assert.equal(await main(['package-publish', '--package', 'p', '--version', '1'], {}), 0);
});

test('network failure warns, exits 0 and never prints the secret', async () => {
  const logs = [];
  const original = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await main(
      ['package-publish', '--package', 'p', '--version', '1', '--release-url', 'https://x.test/r'],
      { WORK_RELEASE_EVENT_SECRET: 'topsecret', WORK_RELEASE_EVENT_URL: 'http://127.0.0.1:9/e' },
    );
    assert.equal(code, 0);
  } finally {
    console.log = original;
  }
  assert.ok(logs.some((l) => l.startsWith('::warning::')));
  assert.ok(!logs.join('\n').includes('topsecret'));
});

test('merged-pr maps a closed pull_request event and ignores unmerged ones', () => {
  const event = {
    repository: { full_name: 'o/r' },
    pull_request: {
      merged: true,
      number: 7,
      title: 'feat: x',
      html_url: 'https://github.com/o/r/pull/7',
      merged_at: '2026-11-18T10:00:00Z',
      labels: [{ name: 'enhancement' }],
    },
  };
  assert.deepEqual(buildMergedPr(event), {
    kind: 'merged-pr',
    repo: 'o/r',
    number: 7,
    title: 'feat: x',
    url: 'https://github.com/o/r/pull/7',
    mergedAt: '2026-11-18T10:00:00Z',
    labels: ['enhancement'],
  });
  assert.equal(buildMergedPr({ ...event, pull_request: { ...event.pull_request, merged: false } }), null);
});
