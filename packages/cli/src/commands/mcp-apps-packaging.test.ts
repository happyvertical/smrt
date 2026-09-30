import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
