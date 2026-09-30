import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const typescriptPath = process.env.SMRT_TYPESCRIPT_PATH || createRequire(import.meta.url).resolve('typescript');
const assertion = "expect(responses.every((response) => !response.headers.has('mcp-session-id'))).toBe(true);";
const imported = "import { expect } from 'vitest';\n";

function check(source, { filename = 'transport.test.ts', manifest = {}, isolated = false, configuredPath = typescriptPath } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'smrt-protocol-hygiene-'));
  try {
    mkdirSync(join(fixture, 'packages', 'fixture'), { recursive: true });
    writeFileSync(join(fixture, 'packages/fixture', filename), source);
    writeFileSync(join(fixture, 'packages/fixture/package.json'), JSON.stringify(manifest));
    let script = join(root, 'scripts/check-mcp-protocol-hygiene.mjs');
    if (isolated) {
      mkdirSync(join(fixture, 'scripts'));
      copyFileSync(script, join(fixture, 'scripts/check-mcp-protocol-hygiene.mjs'));
      script = join(fixture, 'scripts/check-mcp-protocol-hygiene.mjs');
      assert.equal(existsSync(join(fixture, 'node_modules')), false);
    }
    return spawnSync(process.execPath, [script, '--root', fixture], {
      encoding: 'utf8',
      env: { ...process.env, ...(isolated ? { SMRT_TYPESCRIPT_PATH: configuredPath } : {}) },
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test('gate accepts only the asserted synchronous session-header absence form', () => {
  const result = check(imported + assertion);
  assert.equal(result.status, 0, result.stderr);
});

test('gate retains positive, mixed, unasserted and misleading lookalike denials', () => {
  for (const source of [
    assertion.replace('!response', 'response'),
    assertion.replace('toBe(true)', 'toBe(false)'),
    assertion.replace('!response.headers.has', '!!response.headers.has'),
    assertion.replace('(response) =>', 'async (response) =>'),
    assertion.replace('!response.headers.has', '!other.headers.has'),
    assertion.replace('!response.headers.has', '!response?.headers.has'),
    assertion.replace("!response.headers.has('mcp-session-id')", "!response.headers.has('mcp-session-id') || true"),
    "responses.every((response) => !response.headers.has('mcp-session-id'));",
    `const documented = ${JSON.stringify(assertion)};`,
    `// ${assertion}`,
    `${assertion} response.headers.set('mcp-session-id', 'active');`,
    `${assertion} client.ping();`,
    `${assertion} const old = 'sampling/createMessage';`,
    `function sample(expect) { ${assertion} }`,
    `function sample() { const expect = fake; ${assertion} }`,
    `const fake = function expect() { ${assertion} };`,
    `expect = fake; ${assertion}`,
    `${assertion}\nconst invalid = ;`,
  ]) {
    const result = check(imported + source);
    assert.equal(result.status, 1, source);
    assert.match(result.stderr, /protocol hygiene failed/);
  }
  assert.equal(check(assertion).status, 1, 'unbound expect is not trusted');
  assert.equal(check(imported + assertion, { filename: 'transport.ts' }).status, 1, 'production code is not exempt');
});

test('gate retains every retired token, ping and direct SDK dependency denial', () => {
  for (const token of ['PingRequestSchema', 'logging/setLevel', 'SetLevelRequestSchema', 'notifications/roots/list_changed', 'RootsListChangedNotificationSchema', 'ListRootsRequestSchema', 'sampling/createMessage', 'CreateMessageRequestSchema', 'mcp-session-id', 'SSEServerTransport', 'SSEClientTransport']) {
    assert.equal(check(`const legacy = ${JSON.stringify(token)};`).status, 1, token);
  }
  assert.equal(check('client.ping();').status, 1);
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    assert.equal(check('', { manifest: { [section]: { '@modelcontextprotocol/sdk': '1.0.0' } } }).status, 1, section);
  }
});


test('standalone CLI uses configured TypeScript without workspace node_modules and fails closed for a bad path', () => {
  const accepted = check(imported + assertion, { isolated: true });
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const source of [assertion.replace('!response', 'response'), `${assertion} response.headers.set('mcp-session-id', 'active');`]) {
    const denied = check(imported + source, { isolated: true });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /protocol hygiene failed/);
  }
  const unavailable = check(imported + assertion, { isolated: true, configuredPath: '/nonexistent/smrt-typescript.js' });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /ERR_MODULE_NOT_FOUND/);
});

test('standalone standards workflow supplies the existing trusted compiler to the MCP gate', () => {
  const workflow = readFileSync(join(root, '.github/workflows/on-pull-request.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('  check-standards:'));
  assert.ok(job.indexOf('Install trusted README validator dependency') < job.indexOf('Checkout PR branch'));
  assert.match(job, /pnpm@11\.13\.1 typescript@5\.9\.3 @types\/node@24\.13\.2/);
  const step = job.slice(job.indexOf('      - name: Check MCP 2026-07-28 protocol hygiene')).split('\n      - name:')[0];
  assert.match(step, /SMRT_TYPESCRIPT_PATH: \$\{\{ runner\.temp \}\}\/readme-validator\/node_modules\/typescript\/lib\/typescript\.js/);
  assert.match(step, /run: node scripts\/check-mcp-protocol-hygiene\.mjs/);
});
