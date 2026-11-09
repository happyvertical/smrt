import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/on-pull-request.yml', import.meta.url),
  'utf8',
);
const step = workflow
  .split('      - name: Install gitleaks\n')[1]
  ?.split('\n      - name:')[0];
assert.ok(step, 'workflow must install the pinned scanner');
const version = step.match(/GITLEAKS_VERSION: (\S+)/)?.[1];
assert.ok(version);
const install = [...step.split('        run: |\n')[1].matchAll(/^ {10}(.*)$/gm)]
  .map((match) => match[1])
  .join('\n');
const prefix = 'https://github.com/gitleaks/gitleaks/releases/download';
const archive = `gitleaks_${version}_linux_x64.tar.gz`;
const checksums = `gitleaks_${version}_checksums.txt`;
const realCurl = spawnSync('which', ['curl'], { encoding: 'utf8' }).stdout.trim();
assert.ok(realCurl, 'curl must be available');

async function runInstall(t, scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-gitleaks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'gitleaks');
  writeFileSync(binary, '#!/bin/sh\nprintf "fixture-version\\n"\n', {
    mode: 0o755,
  });
  const packed = spawnSync('tar', ['-czf', archive, 'gitleaks'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(join(root, archive));
  rmSync(binary);
  rmSync(join(root, archive));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const counts = { archive: 0, checksums: 0 };
  const server = createServer((req, res) => {
    const kind = req.url === `/v${version}/${archive}` ? 'archive' : 'checksums';
    assert.equal(req.url, `/v${version}/${kind === 'archive' ? archive : checksums}`);
    counts[kind]++;
    if (
      scenario.permanent === kind ||
      (scenario.transient && counts[kind] === 1)
    ) {
      res.writeHead(504);
      res.end('temporary gateway failure');
      return;
    }
    if (kind === 'archive' && scenario.partial && counts.archive === 1) {
      res.writeHead(200, {
        'Content-Length': bytes.length,
        Connection: 'close',
      });
      res.write(bytes.subarray(0, 20));
      res.end();
      return;
    }
    res.end(
      kind === 'archive'
        ? bytes
        : (scenario.manifest ?? `${digest}  ${archive}\n`) +
            (scenario.malformedExtra ? `malformed  ${archive}\n` : ''),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  // Redirect only the fixed release origin. Retry logic and file handling use
  // the real curl; sudo is sandboxed so tests never install on the host.
  writeFileSync(
    join(root, 'curl'),
    `#!${process.execPath}\n` +
      `const {spawnSync}=require('node:child_process');\n` +
      `const args=process.argv.slice(2).map(a=>a.startsWith(${JSON.stringify(prefix)})?${JSON.stringify(`http://127.0.0.1:${server.address().port}`)}+a.slice(${prefix.length}):a);\n` +
      `const r=spawnSync(${JSON.stringify(realCurl)},args,{stdio:'inherit'});process.exit(r.status??1);\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, 'sudo'),
    '#!/bin/sh\n[ "$#" = 3 ] && [ "$1" = mv ] && [ "$3" = /usr/local/bin/gitleaks ] || exit 99\nmv "$2" "$FIXTURE_ROOT/installed"\ncp "$FIXTURE_ROOT/installed" "$FIXTURE_ROOT/gitleaks"\n',
    { mode: 0o755 },
  );
  const child = spawn('bash', ['-e', '-o', 'pipefail', '-c', install], {
    cwd: root,
    timeout: 90_000,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      FIXTURE_ROOT: root,
      GITLEAKS_VERSION: version,
      // Ensure the local fixture never traverses a configured HTTP proxy.
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
    },
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const [code] = await once(child, 'close');
  const installed = spawnSync('test', ['-f', join(root, 'installed')]).status === 0;
  return { code, counts, installed, output };
}

test('gitleaks installs after a transient 504 for both release files', async (t) => {
  const result = await runInstall(t, { transient: true });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.counts, { archive: 2, checksums: 2 });
  assert.equal(result.installed, true);
  assert.match(result.output, /fixture-version/);
});

test('gitleaks replaces partial archive output on retry', async (t) => {
  const result = await runInstall(t, { partial: true });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.counts, { archive: 2, checksums: 1 });
  assert.equal(result.installed, true);
});

for (const kind of ['archive', 'checksums']) {
  test(`gitleaks stops after bounded retries of ${kind}`, async (t) => {
    const result = await runInstall(t, { permanent: kind });
    assert.notEqual(result.code, 0);
    assert.equal(result.counts[kind], 6);
    assert.equal(result.installed, false);
  });
}

for (const manifest of [
  `${'0'.repeat(64)}  ${archive}\n`,
  `${'0'.repeat(64)}  different-archive.tar.gz\n`,
  `malformed  ${archive}\n`,
]) {
  test(`gitleaks rejects unverified archive (${manifest.split(' ')[0]})`, async (t) => {
    const result = await runInstall(t, { manifest });
    assert.notEqual(result.code, 0);
    assert.equal(result.installed, false);
  });
}

test('gitleaks rejects mixed valid and malformed target checksums', async (t) => {
  const result = await runInstall(t, { malformedExtra: true });
  assert.notEqual(result.code, 0);
  assert.equal(result.installed, false);
});
