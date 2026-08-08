import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const pluginSchemaId =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const mcpSchemaId = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(packageRoot, '..', path), 'utf8'));
}

describe('Agent Plugins 1.0.0 package layout', () => {
  it('validates the root manifests offline against pinned canonical schemas', () => {
    const plugin = readJson('plugin.json');
    const mcp = readJson('mcp.json');
    const pluginSchema = readJson(
      'schemas/agent-plugins-1.0.0/plugin.schema.json',
    );
    const mcpSchema = readJson('schemas/agent-plugins-1.0.0/mcp.schema.json');
    const ajv = new Ajv2020({ allErrors: true, strict: true });

    expect(plugin.$schema).toBe(pluginSchemaId);
    expect(mcp.$schema).toBe(mcpSchemaId);
    expect(pluginSchema.$id).toBe(pluginSchemaId);
    expect(mcpSchema.$id).toBe(mcpSchemaId);
    expect(ajv.compile(pluginSchema)(plugin)).toBe(true);
    expect(ajv.compile(mcpSchema)(mcp)).toBe(true);
  });

  it('keeps top-level schemas closed and MCP transports exclusive', () => {
    const pluginSchema = readJson(
      'schemas/agent-plugins-1.0.0/plugin.schema.json',
    );
    const mcpSchema = readJson('schemas/agent-plugins-1.0.0/mcp.schema.json');
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validatePlugin = ajv.compile(pluginSchema);
    const validateMcp = ajv.compile(mcpSchema);

    expect(
      validatePlugin({
        $schema: pluginSchemaId,
        name: 'smrt-dev-mcp',
        extra: true,
      }),
    ).toBe(false);
    expect(
      validateMcp({
        $schema: mcpSchemaId,
        mcpServers: {
          invalid: {
            type: 'stdio',
            command: './dist/index.js',
            url: 'https://example.com/mcp',
          },
        },
      }),
    ).toBe(false);
  });

  it('uses one contained, credential-free stdio server and skill source', () => {
    const mcp = readJson('mcp.json') as {
      mcpServers: Record<
        string,
        {
          type: string;
          command?: string;
          env?: Record<string, string>;
          headers?: Record<string, string>;
        }
      >;
    };
    const server = mcp.mcpServers['smrt-dev-mcp'];
    const skillsRoot = join(packageRoot, '..', 'skills');
    const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(server).toEqual({ type: 'stdio', command: './dist/index.js' });
    expect(server.command).toMatch(/^\.\/[^\s]+$/);
    expect(server.env).toBeUndefined();
    expect(server.headers).toBeUndefined();
    expect(existsSync(join(packageRoot, '..', 'agent-skills'))).toBe(false);
    expect(skillDirectories).toEqual(['smrt-code-review']);
    expect(existsSync(join(skillsRoot, 'smrt-code-review', 'SKILL.md'))).toBe(
      true,
    );
  });
});
