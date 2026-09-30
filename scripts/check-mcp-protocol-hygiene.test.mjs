import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const assertion = "expect(responses.every((response) => !response.headers.has('mcp-session-id'))).toBe(true);";
const imported = "import { expect } from 'vitest';\n";

function check(source, { filename = 'transport.test.ts', manifest = {} } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'smrt-protocol-hygiene-'));
  try {
    mkdirSync(join(fixture, 'packages', 'fixture'), { recursive: true });
    writeFileSync(join(fixture, 'packages/fixture', filename), source);
    writeFileSync(join(fixture, 'packages/fixture/package.json'), JSON.stringify(manifest));
    return spawnSync(process.execPath, [join(root, 'scripts/check-mcp-protocol-hygiene.mjs'), '--root', fixture], { encoding: 'utf8' });
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
