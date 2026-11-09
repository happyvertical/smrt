import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shellDir = resolve(packageDir, 'shell');
const readme = readFileSync(resolve(packageDir, 'README.md'), 'utf8');

/**
 * The credential commands are specified for the sidecar origin, but no remote
 * capability may exist until the command allowlist, the navigation pin and the
 * per-command origin check land with it. The Rust twin of this test is
 * `shell/tests/capabilities.rs`; either alone is enough to notice a lone
 * `remote` block, and this one runs wherever `smrt test` does.
 */
describe('the shell grants the sidecar origin no IPC', () => {
  const capabilities = readdirSync(resolve(shellDir, 'capabilities'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      value: JSON.parse(
        readFileSync(resolve(shellDir, 'capabilities', name), 'utf8'),
      ) as Record<string, unknown>,
    }));

  it('has no capability with a remote block, and the default one grants nothing', () => {
    expect(capabilities.length).toBeGreaterThan(0);
    for (const { name, value } of capabilities) {
      expect(value, name).not.toHaveProperty('remote');
    }
    const fallback = capabilities.find(({ name }) => name === 'default.json');
    expect(fallback?.value.permissions).toEqual([]);
  });

  it('declares no inline remote capability in tauri.conf.json', () => {
    const conf = JSON.parse(
      readFileSync(resolve(shellDir, 'tauri.conf.json'), 'utf8'),
    ) as { app?: { security?: { capabilities?: unknown[] } } };
    for (const inline of conf.app?.security?.capabilities ?? []) {
      expect(inline).not.toHaveProperty('remote');
    }
  });

  it('registers no command handler and no remote origin in the shell sources yet', () => {
    const sources = readdirSync(resolve(shellDir, 'src'))
      .filter((name) => name.endsWith('.rs'))
      .map((name) => readFileSync(resolve(shellDir, 'src', name), 'utf8'))
      .join('\n');
    // When these appear, the preconditions below must appear in the same
    // change; replace this guard with tests for them.
    expect(sources).not.toMatch(/invoke_handler|generate_handler/);
    expect(sources).not.toMatch(/CapabilityBuilder|add_capability/);
  });
});

describe('the README states the IPC preconditions and never recommends a port glob', () => {
  it('never recommends a loopback port glob for remote.urls', () => {
    expect(readme).not.toMatch(/127\.0\.0\.1:\*/);
    expect(readme).not.toMatch(/remote\.urls\s*:/);
  });

  it('requires the allowlist, the navigation pin and the origin check, together with the capability', () => {
    const start = readme.indexOf(
      '**These commands are specified, not granted.**',
    );
    expect(start).toBeGreaterThan(0);
    const section = readme.slice(start, start + 4000);
    expect(section).toContain('AppManifest');
    expect(section).toContain('on_navigation');
    expect(section).toMatch(/origin check/i);
    expect(section).toMatch(/same change as the capability/);
    expect(section).toContain('shell/tests/capabilities.rs');
  });
});
