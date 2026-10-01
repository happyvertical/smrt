import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('release sync covers optional MCP Apps pins, future releases, check and idempotence', () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-release-optional-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'packages/core'), { recursive: true });
    mkdirSync(join(root, 'packages/template-sveltekit/template'), { recursive: true });
    mkdirSync(join(root, 'packages/template-sveltekit/mcp-apps-template'));
    const script = join(root, 'scripts/sync-template-versions.mjs');
    cpSync(new URL('./sync-template-versions.mjs', import.meta.url), script);
    const version = JSON.parse(readFileSync(new URL('../packages/core/package.json', import.meta.url), 'utf8')).version;
    writeFileSync(join(root, 'packages/core/package.json'), JSON.stringify({ version }));
    const base = join(root, 'packages/template-sveltekit/template/package.json');
    const optional = join(root, 'packages/template-sveltekit/mcp-apps-template/package.dependencies.json');
    writeFileSync(base, JSON.stringify({ dependencies: { '@happyvertical/smrt-core': `^${version}` } }));
    writeFileSync(optional, JSON.stringify({ '@happyvertical/smrt-app-mcp': '^0.0.1', '@happyvertical/smrt-mcp-openai': '^0.0.1' }));
    assert.equal(spawnSync(process.execPath, [script, '--check']).status, 1);
    for (const next of [version, '999.1.2']) {
      execFileSync(process.execPath, [script, next]);
      assert.deepEqual(JSON.parse(readFileSync(optional, 'utf8')), { '@happyvertical/smrt-app-mcp': `^${next}`, '@happyvertical/smrt-mcp-openai': `^${next}` });
      const bytes = readFileSync(optional, 'utf8');
      execFileSync(process.execPath, [script, next, '--check']);
      execFileSync(process.execPath, [script, next]);
      assert.equal(readFileSync(optional, 'utf8'), bytes);
      assert.equal(JSON.parse(readFileSync(base, 'utf8')).dependencies['@happyvertical/smrt-core'], `^${next}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
