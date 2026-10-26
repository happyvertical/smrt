import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertChartVersionAbsent } from './deployment-chart-publication.mjs';

const secret = 'credential-canary';
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
function options(manifest, authentication = () => response({ token: 'scoped-canary' })) {
  const calls = [];
  return {
    actor: 'publisher', token: secret, calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), ...init });
      return calls.length === 1 ? authentication() : manifest();
    },
  };
}

test('authenticated exact OCI version absence permits publication', async () => {
  for (const code of ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN']) {
    const config = options(() => response({ errors: [{ code }] }, 404));
    await assertChartVersionAbsent('0.1.0', config);
    assert.equal(config.calls.length, 2);
    const authentication = new URL(config.calls[0].url);
    assert.equal(authentication.origin, 'https://ghcr.io');
    assert.equal(authentication.searchParams.get('scope'), 'repository:happyvertical/charts/smrt-app:pull,push');
    assert.equal(config.calls[0].headers.Authorization, `Basic ${Buffer.from(`publisher:${secret}`).toString('base64')}`);
    assert.equal(config.calls[1].url, 'https://ghcr.io/v2/happyvertical/charts/smrt-app/manifests/0.1.0');
    assert.equal(config.calls[1].headers.Authorization, 'Bearer scoped-canary');
    for (const call of config.calls) {
      assert.equal(call.redirect, 'error');
      assert.ok(call.signal instanceof AbortSignal);
    }
  }
});

test('existing version never permits overwrite', async () => {
  await assert.rejects(assertChartVersionAbsent('0.1.0', options(() => response({}))), /already exists/);
});

test('registry HTTP errors are not absence proof', async () => {
  for (const status of [201, 204, 301, 400, 401, 403, 429, 500, 503]) {
    const config = options(() => new Response(null, { status }));
    await assert.rejects(assertChartVersionAbsent('0.1.0', config), /lookup failed/);
  }
});

test('bare, malformed and mixed-error 404 responses fail closed', async () => {
  for (const body of [null, {}, { errors: [] }, { errors: [{ code: 'DENIED' }] },
    { errors: [{ code: 'MANIFEST_UNKNOWN' }, { code: 'UNAUTHORIZED' }] }, { errors: [null] }]) {
    await assert.rejects(assertChartVersionAbsent('0.1.0', options(() => response(body, 404))), /absence is unconfirmed/);
  }
  await assert.rejects(assertChartVersionAbsent('0.1.0', options(() => new Response('not JSON', { status: 404 }))), /response is invalid/);
});

test('missing credentials or malformed versions cannot send registry requests', async () => {
  for (const version of [undefined, null, 1, '', '../main', '0.1.0/path', 'latest']) {
    const config = options(() => assert.fail('unexpected lookup'));
    await assert.rejects(assertChartVersionAbsent(version, config), /valid chart version/);
    assert.equal(config.calls.length, 0);
  }
  for (const missing of [{ actor: '' }, { token: '' }]) {
    const config = { ...options(() => assert.fail('unexpected lookup')), ...missing };
    await assert.rejects(assertChartVersionAbsent('0.1.0', config), /credentials are required/);
    assert.equal(config.calls.length, 0);
  }
});

test('authentication errors, missing token and invalid JSON block before lookup', async () => {
  for (const authentication of [
    () => response({}, 401), () => response({}, 403), () => response({}, 500),
    () => response({}), () => response({ token: ' ' }), () => response({ token: 12 }),
    () => new Response('not JSON'),
  ]) {
    const config = options(() => assert.fail('unexpected lookup'), authentication);
    await assert.rejects(assertChartVersionAbsent('0.1.0', config), /publication blocked/);
    assert.equal(config.calls.length, 1);
  }
});

test('network and body-reader failures cannot echo credentials or upstream payloads', async () => {
  for (const stage of ['authentication', 'lookup', 'body']) {
    const config = options(() => {
      if (stage === 'body') return { status: 404, json: async () => { throw Error(secret); } };
      throw Error(secret);
    }, () => {
      if (stage === 'authentication') throw Error(secret);
      return response({ token: 'scoped-canary' });
    });
    await assert.rejects(assertChartVersionAbsent('0.1.0', config), error => {
      assert.match(error.message, /publication blocked/);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes('scoped-canary'));
      return true;
    });
  }
});

test('SemVer build metadata uses Helm OCI tag mapping', async () => {
  const config = options(() => response({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, 404));
  await assertChartVersionAbsent('0.1.0-rc.1+build.2', config);
  assert.ok(config.calls[1].url.endsWith('/0.1.0-rc.1_build.2'));
});

test('CLI refuses malformed input without printing its credential', () => {
  const result = spawnSync(process.execPath, [new URL('./deployment-chart-publication.mjs', import.meta.url).pathname, '../main'], {
    encoding: 'utf8', env: { GITHUB_ACTOR: 'publisher', GHCR_TOKEN: secret },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /valid chart version/);
  assert.ok(!result.stderr.includes(secret));
});

test('protected workflow guards the same version before packaging and pushing', () => {
  const workflow = readFileSync(new URL('../.github/workflows/smrt-chart.yml', import.meta.url), 'utf8');
  const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.ok(publish.includes('environment: smrt-chart-publication'));
  assert.ok(publish.includes("github.ref == 'refs/heads/main'"));
  assert.ok(publish.includes('GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}'));
  assert.ok(!publish.includes('/orgs/happyvertical/packages'));
  const guard = publish.indexOf('node scripts/deployment-chart-publication.mjs "$version"');
  assert.ok(guard > 0);
  assert.ok(publish.indexOf('helm package') > guard);
  assert.ok(publish.indexOf('helm push') > guard);
  assert.ok(publish.includes('sha256sum "$RUNNER_TEMP/smrt-app-$version.tgz"'));
});
