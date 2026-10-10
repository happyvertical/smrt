import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { KITCHEN_TOOLS } from '../kitchen/mcp/tools.js';
import { kitchenCommands } from '../kitchen.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');
const pluginRoot = join(repoRoot, 'plugins/smrt-kitchen');
const schemas = join(here, '__fixtures__/agent-plugins');

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * The schemas are vendored from https://agent-plugins.org/schemas/1.0.0/
 * (plugin.schema.json, mcp.schema.json); refresh them when the plugin moves
 * to a newer schema version. The marketplace has no published schema, so its
 * documented fields are checked below (developers.openai.com/plugins/build/plugins).
 */
function validator(file: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile(readJson(join(schemas, file)));
}

describe('smrt-kitchen plugin package', () => {
  it('plugin.json matches the Agent Plugins schema', () => {
    const validate = validator('plugin.schema.json');
    const manifest = readJson(join(pluginRoot, 'plugin.json'));
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(manifest.name).toBe('smrt-kitchen');
    const ui = manifest.extensions['com.openai'].interface;
    for (const key of [
      'displayName',
      'shortDescription',
      'developerName',
      'category',
      'defaultPrompt',
      'logo',
      'composerIcon',
    ]) {
      expect(ui[key], key).toBeTruthy();
    }
    expect(ui.defaultPrompt.length).toBeGreaterThan(0);
    // Asset paths are plugin-relative, `./`-prefixed, and exist.
    for (const key of ['logo', 'composerIcon']) {
      expect(ui[key]).toMatch(/^\.\/assets\//);
      expect(() => readFileSync(join(pluginRoot, ui[key]))).not.toThrow();
    }
  });

  it('mcp.json matches the schema and names a stdio kitchen mcp server', () => {
    const validate = validator('mcp.schema.json');
    const config = readJson(join(pluginRoot, 'mcp.json'));
    expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
    const server = config.mcpServers['smrt-kitchen'];
    expect(server.type).toBe('stdio');
    expect(server.command).toBe('npx');
    const [yes, spec, ...command] = server.args;
    expect(yes).toBe('-y');
    expect(spec).toMatch(/^@happyvertical\/smrt-cli@/);
    expect(command).toEqual(['kitchen', 'mcp']);
    expect(kitchenCommands[command.join(' ')]).toBeDefined();
    // No credential travels in the configuration.
    expect(server.env).toBeUndefined();
    expect(JSON.stringify(config)).not.toMatch(/key|token|secret|password/i);
  });

  it('the Claude Code overlay agrees with plugin.json and points at mcp.json', () => {
    const overlay = readJson(join(pluginRoot, '.claude-plugin/plugin.json'));
    const manifest = readJson(join(pluginRoot, 'plugin.json'));
    for (const key of ['name', 'version', 'description', 'license']) {
      expect(overlay[key], key).toBe(manifest[key]);
    }
    expect(overlay.mcpServers).toBe('./mcp.json');
  });

  it('the repo marketplaces list the plugin as documented', () => {
    const market = readJson(join(repoRoot, '.agents/plugins/marketplace.json'));
    expect(market.name).toBeTruthy();
    expect(market.interface.displayName).toBeTruthy();
    const entry = market.plugins.find(
      (p: { name: string }) => p.name === 'smrt-kitchen',
    );
    expect(entry.source).toEqual({
      source: 'local',
      path: './plugins/smrt-kitchen',
    });
    expect(entry.policy).toEqual({
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    });
    expect(entry.category).toBeTruthy();
    // The path is relative to the marketplace root and holds the manifest.
    expect(() =>
      readFileSync(join(repoRoot, entry.source.path, 'plugin.json')),
    ).not.toThrow();

    const claude = readJson(join(repoRoot, '.claude-plugin/marketplace.json'));
    expect(claude.owner.name).toBeTruthy();
    expect(claude.plugins[0]).toMatchObject({
      name: 'smrt-kitchen',
      source: './plugins/smrt-kitchen',
    });
  });

  it('the skill names only tools the server has', () => {
    const skill = readFileSync(
      join(pluginRoot, 'skills/kitchen/SKILL.md'),
      'utf8',
    );
    const front = /^---\nname: (\S+)\ndescription: (.+)\n---\n/.exec(skill);
    expect(front?.[1]).toBe('kitchen');
    const names = new Set(KITCHEN_TOOLS.map((t) => t.name));
    const mentioned = new Set(
      [...skill.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]),
    );
    const tools = [...mentioned].filter((name) =>
      [
        'list_cookbooks',
        'search_recipes',
        'start_plan',
        'run_commands',
        'get_plan',
        'validate_plan',
        'export_plan',
        'apply_plan',
      ].includes(name),
    );
    for (const name of [
      'list_cookbooks',
      'search_recipes',
      'start_plan',
      'run_commands',
      'validate_plan',
      'apply_plan',
    ]) {
      expect(tools, name).toContain(name);
    }
    for (const name of tools) expect(names.has(name), name).toBe(true);
  });
});
