import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrapperDir = resolve(packageDir, 'wrapper');

/**
 * Tauri v2 loads every file under `capabilities/**` (nested directories, and
 * `.json`, `.json5` and `.toml` alike), so the guard walks the whole tree and
 * accepts exactly one file, `default.json`.
 */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

/**
 * True when the text declares a `remote` key in any of the capability
 * formats: `"remote":`, `remote:` (json5), `remote =`, `remote.urls =` or a
 * `[remote]` table. Prose such as "is remote content" does not match.
 */
function declaresRemote(text: string): boolean {
  return /(^|[^A-Za-z0-9_-])["']?remote["']?\s*[:=.\]]/m.test(text);
}

function capabilityViolations(dir: string): string[] {
  const violations: string[] = [];
  const files = walk(dir);
  if (!files.includes('default.json')) {
    violations.push('default.json is missing');
  }
  for (const name of files) {
    if (name !== 'default.json') {
      violations.push(
        `${name}: only capabilities/default.json may exist; Tauri loads capabilities/** in every format`,
      );
    }
    const text = readFileSync(resolve(dir, name), 'utf8');
    if (declaresRemote(text)) violations.push(`${name}: declares remote`);
    if (name === 'default.json') {
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        violations.push('default.json: not valid JSON');
      }
      if (parsed && 'remote' in parsed) {
        violations.push('default.json: declares remote');
      }
      if (
        parsed &&
        !(Array.isArray(parsed.permissions) && parsed.permissions.length === 0)
      ) {
        violations.push('default.json: grants permissions');
      }
    }
  }
  return violations;
}

function sourceViolations(dir: string): string[] {
  const violations: string[] = [];
  for (const name of walk(dir).filter((file) => file.endsWith('.rs'))) {
    const text = readFileSync(resolve(dir, name), 'utf8');
    // When these appear, the preconditions in the README must appear in the
    // same change; replace this guard with tests for them.
    if (/invoke_handler|generate_handler/.test(text)) {
      violations.push(`${name}: registers a command handler`);
    }
    if (/CapabilityBuilder|add_capability/.test(text)) {
      violations.push(`${name}: adds a capability at runtime`);
    }
  }
  return violations;
}

/**
 * The sidecar origin is remote content, so no remote capability may exist
 * until a command allowlist, a navigation pin and a per-command origin check
 * land with it. The Rust twin of this test is `wrapper/tests/capabilities.rs`;
 * either alone is enough to notice a lone `remote` block, and this one runs
 * wherever `smrt test` does.
 */
describe('the wrapper grants the sidecar origin no IPC', () => {
  it('has no capability with a remote block, and the default one grants nothing', () => {
    expect(capabilityViolations(resolve(wrapperDir, 'capabilities'))).toEqual(
      [],
    );
  });

  it('declares no inline remote capability in tauri.conf.json', () => {
    const conf = JSON.parse(
      readFileSync(resolve(wrapperDir, 'tauri.conf.json'), 'utf8'),
    ) as { app?: { security?: { capabilities?: unknown[] } } };
    for (const inline of conf.app?.security?.capabilities ?? []) {
      expect(inline).not.toHaveProperty('remote');
    }
  });

  it('registers no command handler and no remote origin in the wrapper sources yet', () => {
    expect(sourceViolations(resolve(wrapperDir, 'src'))).toEqual([]);
  });
});

describe('the guard catches what Tauri would load', () => {
  const okDefault = JSON.stringify({
    identifier: 'default',
    description: 'Splash only. The sidecar origin is remote content.',
    permissions: [],
  });

  function fixture(files: Record<string, string>): string {
    const dir = mkdtempSync(resolve(tmpdir(), 'caps-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(resolve(dir, name)), { recursive: true });
      writeFileSync(resolve(dir, name), text);
    }
    return dir;
  }

  it('accepts the lone default capability, prose about remote content included', () => {
    expect(
      capabilityViolations(fixture({ 'default.json': okDefault })),
    ).toEqual([]);
  });

  it('catches a nested capability file', () => {
    const found = capabilityViolations(
      fixture({
        'default.json': okDefault,
        'x/y.json': '{"identifier":"y","windows":["main"],"permissions":[]}',
      }),
    );
    expect(found.join('\n')).toMatch(/x\/y\.json: only capabilities\/default/);
  });

  it('catches a toml capability with a remote table', () => {
    const found = capabilityViolations(
      fixture({
        'default.json': okDefault,
        'sidecar.toml':
          'identifier = "sidecar"\n[remote]\nurls = ["http://127.0.0.1:*"]\n',
      }),
    );
    expect(found.join('\n')).toContain('sidecar.toml: only');
    expect(found.join('\n')).toContain('sidecar.toml: declares remote');
  });

  it('catches a json5 capability with an unquoted remote key', () => {
    const found = capabilityViolations(
      fixture({
        'default.json': okDefault,
        'nested/deep/side.json5':
          "{ identifier: 'side', remote: { urls: ['http://127.0.0.1:*'] } }",
      }),
    );
    expect(found.join('\n')).toContain(
      'nested/deep/side.json5: declares remote',
    );
  });

  it('catches a remote block, or a permission, in default.json itself', () => {
    expect(
      capabilityViolations(
        fixture({
          'default.json': JSON.stringify({
            identifier: 'default',
            permissions: [],
            remote: { urls: ['http://127.0.0.1:*'] },
          }),
        }),
      ).join('\n'),
    ).toContain('default.json: declares remote');
    expect(
      capabilityViolations(
        fixture({
          'default.json': JSON.stringify({
            identifier: 'default',
            permissions: ['core:default'],
          }),
        }),
      ).join('\n'),
    ).toContain('grants permissions');
  });

  it('catches a handler or capability registered in a nested source file', () => {
    const found = sourceViolations(
      fixture({
        'lib.rs': 'fn main() {}',
        'a/b/mod.rs': 'builder.invoke_handler(h); app.add_capability(c);',
      }),
    );
    expect(found).toEqual([
      'a/b/mod.rs: registers a command handler',
      'a/b/mod.rs: adds a capability at runtime',
    ]);
  });
});
