import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIGenerator } from '../cli-generator.js';
import {
  addMcpAppsRuntime,
  configureMcpAppsConsumerRegistry,
  scaffoldMcpAppsPackage,
  validateMcpAppsPackage,
} from './mcp-apps-packaging.js';

describe('portable MCP Apps package validation', () => {
  const roots: string[] = [];
  function root() {
    const value = mkdtempSync(join(tmpdir(), 'smrt-mcp-apps-'));
    roots.push(value);
    return value;
  }
  afterEach(() => {
    roots.splice(0).forEach((value) => {
      rmSync(value, { recursive: true, force: true });
    });
  });

  it('scaffolds a deterministic, loopback-only portable package', () => {
    const first = root();
    const second = root();
    scaffoldMcpAppsPackage(first, 'example');
    scaffoldMcpAppsPackage(second, 'example');
    expect(validateMcpAppsPackage(first)).toEqual({
      findings: [],
      valid: true,
    });
    expect(readFileSync(join(first, 'plugin.json'), 'utf8')).toBe(
      readFileSync(join(second, 'plugin.json'), 'utf8'),
    );
    expect(readFileSync(join(first, 'mcp.json'), 'utf8')).toContain(
      '127.0.0.1',
    );
  });

  it('adds the canonical registry without credentials and preserves unrelated npmrc lines', () => {
    const app = root();
    writeFileSync(join(app, '.npmrc'), 'strict-peer-dependencies=false');

    configureMcpAppsConsumerRegistry(app);
    configureMcpAppsConsumerRegistry(app);

    expect(readFileSync(join(app, '.npmrc'), 'utf8')).toBe(
      'strict-peer-dependencies=false\n@happyvertical:registry=https://npm.happyvertical.com/\n',
    );
  });

  it('refuses to replace an explicit consumer registry route', () => {
    const app = root();
    writeFileSync(
      join(app, '.npmrc'),
      '@happyvertical:registry=https://registry.example.test/\n',
    );

    expect(() => configureMcpAppsConsumerRegistry(app)).toThrow(
      'refusing to replace',
    );
  });

  it('copies only the staged opt-in runtime and its declared dependencies', () => {
    const app = root();
    writeFileSync(
      join(app, 'package.json'),
      '{"dependencies":{"existing":"1"}}\n',
    );
    addMcpAppsRuntime(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'template-sveltekit',
      ),
      app,
    );
    const packageJson = JSON.parse(
      readFileSync(join(app, 'package.json'), 'utf8'),
    );
    expect(packageJson.dependencies).toMatchObject({
      existing: '1',
      '@happyvertical/smrt-app-mcp': '^0.51.36',
    });
    expect(
      existsSync(join(app, 'src', 'routes', 'api', 'mcp', '+server.ts')),
    ).toBe(true);
  });

  it('dispatches the space-separated scaffold command through the CLI', async () => {
    const value = root();
    const cli = new CLIGenerator({ prompt: false, colors: false });
    vi.spyOn(cli as never, 'tryLoadUserClasses').mockResolvedValue(undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await cli.generateHandler()([
        'mcp-apps',
        'scaffold',
        '--output-dir',
        value,
        '--name',
        'example',
      ]);
      expect(validateMcpAppsPackage(value).valid).toBe(true);
    } finally {
      log.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it('fails closed for unsafe paths, non-loopback HTTP, credentials, and symlinks', () => {
    const value = root();
    scaffoldMcpAppsPackage(value, 'example');
    writeFileSync(
      join(value, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'example',
        extensions: { 'com.openai': { apps: '../outside.json' } },
        apiKey: 'not-a-secret',
      }),
    );
    writeFileSync(
      join(value, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          example: { type: 'streamable-http', url: 'http://example.test/mcp' },
        },
      }),
    );
    symlinkSync('plugin.json', join(value, 'linked.json'));
    const codes = validateMcpAppsPackage(value).findings.map(
      (finding) => finding.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'unsafe-path',
        'secret-artifact',
        'server-url',
        'symlink',
      ]),
    );
  });
});

describe('portable MCP Apps validator fail-closed boundaries', () => {
  const roots: string[] = [];
  function root() {
    const value = mkdtempSync(join(tmpdir(), 'smrt-mcp-apps-boundary-'));
    roots.push(value);
    return value;
  }
  function writeValidPackage(value: string) {
    scaffoldMcpAppsPackage(value, 'example');
  }
  afterEach(() => {
    roots.splice(0).forEach((value) => {
      rmSync(value, { recursive: true, force: true });
    });
  });

  it('rejects every non-object manifest root while retaining valid ordinary metadata', () => {
    for (const invalid of [null, [], 'manifest', 1, false]) {
      const pluginRoot = root();
      writeValidPackage(pluginRoot);
      writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify(invalid));
      expect(validateMcpAppsPackage(pluginRoot).valid).toBe(false);

      const mcpRoot = root();
      writeValidPackage(mcpRoot);
      writeFileSync(join(mcpRoot, 'mcp.json'), JSON.stringify(invalid));
      expect(validateMcpAppsPackage(mcpRoot).valid).toBe(false);
    }
    const validRoot = root();
    writeValidPackage(validRoot);
    expect(validateMcpAppsPackage(validRoot)).toEqual({
      findings: [],
      valid: true,
    });
  });

  it('never includes malformed JSON content in diagnostics', () => {
    const value = root();
    writeValidPackage(value);
    const marker = 'M7_RAW_SECRET_MARKER_DO_NOT_LOG';
    writeFileSync(join(value, 'plugin.json'), `{"secret":"${marker}`);
    const findings = validateMcpAppsPackage(value).findings;
    expect(findings.map((finding) => finding.code)).toContain('json-malformed');
    expect(findings.map((finding) => finding.message).join('\n')).not.toContain(
      marker,
    );
  });

  it('rejects credential carriers and URL userinfo without rejecting a public certificate', () => {
    const value = root();
    writeValidPackage(value);
    writeFileSync(join(value, '.env.production'), 'TOKEN=not-logged');
    writeFileSync(join(value, 'id_rsa'), 'not-a-key');
    writeFileSync(
      join(value, 'server.pem'),
      '-----BEGIN PRIVATE KEY-----\nkey',
    );
    writeFileSync(
      join(value, 'public.pem'),
      '-----BEGIN CERTIFICATE-----\npublic',
    );
    const mcp = JSON.parse(readFileSync(join(value, 'mcp.json'), 'utf8'));
    mcp.mcpServers.smrt.url = 'https://user:password@example.test/mcp';
    writeFileSync(join(value, 'mcp.json'), JSON.stringify(mcp));
    const findings = validateMcpAppsPackage(value).findings;
    expect(findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['secret-artifact', 'server-url']),
    );
    expect(findings.map((finding) => finding.message).join('\n')).not.toContain(
      'not-logged',
    );
  });

  it('checks every screenshot path as a regular in-root resource', () => {
    const value = root();
    writeValidPackage(value);
    writeFileSync(join(value, 'valid.png'), 'png');
    writeFileSync(join(value, 'linked.png'), 'png');
    symlinkSync('linked.png', join(value, 'screenshot-link.png'));
    const plugin = JSON.parse(readFileSync(join(value, 'plugin.json'), 'utf8'));
    plugin.extensions['com.openai'].interface.screenshots = [
      './valid.png',
      '../outside.png',
      '/absolute.png',
      './missing.png',
      './screenshot-link.png',
    ];
    writeFileSync(join(value, 'plugin.json'), JSON.stringify(plugin));
    const codes = validateMcpAppsPackage(value).findings.map(
      (finding) => finding.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'unsafe-path',
        'missing-resource',
        'invalid-resource',
      ]),
    );
  });
});
