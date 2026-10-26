import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureUbuntuAptMirrors, rewriteUbuntuMirrorList } from './configure-ubuntu-apt-mirrors.mjs';

test('routes official Ubuntu mirror lists through canonical HTTPS without changing metadata', () => {
  const original = '# runner mirrors\r\n http://azure.archive.ubuntu.com/ubuntu/ priority:1\r\nhttp://archive.ubuntu.com/ubuntu priority:2\r\n';
  assert.equal(rewriteUbuntuMirrorList(original), '# runner mirrors\r\n https://archive.ubuntu.com/ubuntu/ priority:1\r\nhttps://archive.ubuntu.com/ubuntu priority:2\r\n');
  assert.equal(rewriteUbuntuMirrorList('https://azure.archive.ubuntu.com/ubuntu/\n', true), 'https://security.ubuntu.com/ubuntu/\n');
  assert.equal(rewriteUbuntuMirrorList('http://security.ubuntu.com/ubuntu/\n'), 'https://security.ubuntu.com/ubuntu/\n');
});

test('preserves custom endpoints, comments and unsupported URI forms byte-exact', () => {
  const original = [
    '# http://azure.archive.ubuntu.com/ubuntu/',
    'http://mirror.example/ubuntu/',
    'http://azure.archive.ubuntu.com.example/ubuntu/',
    'http://azure.archive.ubuntu.com/ubuntu-ports/',
    'http://azure.archive.ubuntu.com/ubuntuevil/',
    'http://user:fixture@azure.archive.ubuntu.com/ubuntu/',
    'http://azure.archive.ubuntu.com:8080/ubuntu/',
    'http://azure.archive.ubuntu.com:80/ubuntu/',
    'https://azure.archive.ubuntu.com:443/ubuntu/',
    'http://azure.archive.ubuntu.com/custom/../ubuntu/',
    'http://azure.archive.ubuntu.com/ubuntu/.',
    'http://azure.archive.ubuntu.com/custom/%2e%2e/ubuntu/',
    'http://%61zure.archive.ubuntu.com/ubuntu/',
    'http://azure.archive.ubuntu.com/ubuntu/?custom=yes',
    'http://azure.archive.ubuntu.com/ubuntu/#custom',
    'http://[invalid',
    'file:/custom/mirrors',
    'https://archive.ubuntu.com/ubuntu/',
    '',
  ].join('\r\n');
  assert.equal(rewriteUbuntuMirrorList(original), original);
});

test('updates only the two hosted mirror files and preserves permissions and source signing configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'smrt-apt-mirrors-'));
  try {
    const archive = join(directory, 'apt-mirrors.txt');
    const security = join(directory, 'apt-security-mirrors.txt');
    const sources = join(directory, 'ubuntu.sources');
    writeFileSync(archive, 'http://azure.archive.ubuntu.com/ubuntu/\n', { mode: 0o640 });
    writeFileSync(security, 'http://azure.archive.ubuntu.com/ubuntu/\n');
    const signing = 'Suites: resolute resolute-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
    writeFileSync(sources, signing);
    configureUbuntuAptMirrors(directory);
    assert.equal(readFileSync(archive, 'utf8'), 'https://archive.ubuntu.com/ubuntu/\n');
    assert.equal(readFileSync(security, 'utf8'), 'https://security.ubuntu.com/ubuntu/\n');
    assert.equal(statSync(archive).mode & 0o777, 0o640);
    assert.equal(readFileSync(sources, 'utf8'), signing);
    const mtime = statSync(archive).mtimeMs;
    configureUbuntuAptMirrors(directory);
    assert.equal(statSync(archive).mtimeMs, mtime, 'repeat execution does not rewrite unchanged files');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('allows runners without mirror-list files but propagates unexpected filesystem failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'smrt-apt-mirrors-'));
  try {
    assert.doesNotThrow(() => configureUbuntuAptMirrors(directory));
    mkdirSync(join(directory, 'apt-mirrors.txt'));
    assert.throws(() => configureUbuntuAptMirrors(directory), { code: 'EISDIR' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the actual setup action configures mirrors before bounded apt and preserves its safety gates', () => {
  const action = readFileSync(new URL('../.github/actions/setup-environment/action.yml', import.meta.url), 'utf8');
  const section = action.slice(action.indexOf('    - name: Install system dependencies for ONNX Runtime'), action.indexOf('    - name: Install project dependencies'));
  const configure = section.indexOf('scripts/configure-ubuntu-apt-mirrors.mjs');
  assert.ok(configure > section.indexOf('CI_ONNX_DEPS_READY:-}'));
  assert.ok(configure > section.indexOf('command -v apt-get'));
  assert.ok(configure < section.indexOf("--stage 'apt-get update'"));
  assert.match(section, /sudo "\$node_path" "\$GITHUB_WORKSPACE\/scripts\/configure-ubuntu-apt-mirrors\.mjs"/);
  assert.match(section, /APT::Update::Error-Mode=any &&/);
  assert.match(section, /--timeout-seconds 120/);
  assert.match(section, /--timeout-seconds 600/);
});
