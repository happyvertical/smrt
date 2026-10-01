import {
  chmodSync,
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
      '@happyvertical/smrt-app-mcp': `^${JSON.parse(readFileSync(join(process.cwd(), '../core/package.json'), 'utf8')).version}`,
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

describe('portable MCP Apps validator isolated security regressions', () => {
  const roots: string[] = [];
  function root() {
    const value = mkdtempSync(join(tmpdir(), 'smrt-mcp-apps-isolated-'));
    roots.push(value);
    return value;
  }
  function valid(value: string) {
    scaffoldMcpAppsPackage(value, 'example');
  }
  function codes(value: string) {
    return validateMcpAppsPackage(value).findings.map(
      (finding) => finding.code,
    );
  }
  afterEach(() => {
    roots.splice(0).forEach((value) => {
      rmSync(value, { recursive: true, force: true });
    });
  });

  it('does not echo a malformed JSON secret marker', () => {
    const value = root();
    valid(value);
    writeFileSync(join(value, 'plugin.json'), '{"secret":SYNSECRET}');
    const messages = validateMcpAppsPackage(value).findings.map(
      (finding) => finding.message,
    );
    expect(messages.join('\n')).not.toContain('SYNSECRET');
  });

  it.each([
    ['.env', 'TOKEN=not-logged'],
    ['.env.production', 'TOKEN=not-logged'],
    ['id_rsa', 'not-a-key'],
    ['private.key', 'not-a-key'],
    ['server.pem', '-----BEGIN PRIVATE KEY-----\nnot-a-key'],
  ])('rejects credential carrier %s', (file, content) => {
    const value = root();
    valid(value);
    writeFileSync(join(value, file), content);
    expect(codes(value)).toContain('secret-artifact');
  });

  it('fails closed when a regular artifact cannot be read', () => {
    const value = root();
    valid(value);
    const artifact = join(value, 'server.pem');
    const marker = 'SYNUNREADABLESECRET';
    writeFileSync(artifact, `-----BEGIN PRIVATE KEY-----\n${marker}`);
    chmodSync(artifact, 0o000);
    const findings = validateMcpAppsPackage(value).findings;
    expect(findings.map((finding) => finding.code)).toContain(
      'artifact-unreadable',
    );
    expect(findings.map((finding) => finding.message).join('\n')).not.toContain(
      marker,
    );
    expect(findings.map((finding) => finding.message).join('\n')).not.toContain(
      'EACCES',
    );
  });

  it('allows a public certificate without other unsafe content', () => {
    const value = root();
    valid(value);
    writeFileSync(
      join(value, 'public.pem'),
      '-----BEGIN CERTIFICATE-----\npublic',
    );
    expect(validateMcpAppsPackage(value)).toEqual({
      findings: [],
      valid: true,
    });
  });

  it('rejects URL userinfo', () => {
    const value = root();
    valid(value);
    const mcp = JSON.parse(readFileSync(join(value, 'mcp.json'), 'utf8'));
    mcp.mcpServers.smrt.url = 'https://user:password@example.test/mcp';
    writeFileSync(join(value, 'mcp.json'), JSON.stringify(mcp));
    expect(codes(value)).toContain('server-url');
  });

  it('accepts an existing in-root screenshot', () => {
    const value = root();
    valid(value);
    writeFileSync(join(value, 'screenshot.png'), 'png');
    const plugin = JSON.parse(readFileSync(join(value, 'plugin.json'), 'utf8'));
    plugin.extensions['com.openai'].interface.screenshots = [
      './screenshot.png',
    ];
    writeFileSync(join(value, 'plugin.json'), JSON.stringify(plugin));
    expect(validateMcpAppsPackage(value)).toEqual({
      findings: [],
      valid: true,
    });
  });

  it.each([
    ['outside', '../outside.png', 'unsafe-path'],
    ['absolute', '/absolute.png', 'unsafe-path'],
    ['missing', './missing.png', 'missing-resource'],
  ])('rejects %s screenshot paths', (_name, screenshot, expectedCode) => {
    const value = root();
    valid(value);
    const plugin = JSON.parse(readFileSync(join(value, 'plugin.json'), 'utf8'));
    plugin.extensions['com.openai'].interface.screenshots = [screenshot];
    writeFileSync(join(value, 'plugin.json'), JSON.stringify(plugin));
    expect(codes(value)).toContain(expectedCode);
  });

  it('rejects a symlink screenshot as an invalid resource', () => {
    const value = root();
    valid(value);
    writeFileSync(join(value, 'asset.png'), 'png');
    symlinkSync('asset.png', join(value, 'screenshot.png'));
    const plugin = JSON.parse(readFileSync(join(value, 'plugin.json'), 'utf8'));
    plugin.extensions['com.openai'].interface.screenshots = [
      './screenshot.png',
    ];
    writeFileSync(join(value, 'plugin.json'), JSON.stringify(plugin));
    expect(codes(value)).toContain('invalid-resource');
  });
});
