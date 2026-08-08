import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

export const PLUGIN_SCHEMA_ID =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA_ID =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const SECRET_PATTERN =
  /(?:authorization|api[-_]?key|credential|password|secret|token|cookie)/i;

export function validateAgentPlugin(packageRoot) {
  const plugin = readJson(packageRoot, 'plugin.json');
  const mcp = readJson(packageRoot, 'mcp.json');
  const pluginSchema = readJson(
    packageRoot,
    'schemas/agent-plugins-1.0.0/plugin.schema.json',
  );
  const mcpSchema = readJson(
    packageRoot,
    'schemas/agent-plugins-1.0.0/mcp.schema.json',
  );

  if (pluginSchema.$id !== PLUGIN_SCHEMA_ID || mcpSchema.$id !== MCP_SCHEMA_ID) {
    throw new Error('Pinned Agent Plugins schema identifiers do not match 1.0.0');
  }
  if (plugin.$schema !== PLUGIN_SCHEMA_ID || mcp.$schema !== MCP_SCHEMA_ID) {
    throw new Error('Plugin manifests must use the canonical Agent Plugins 1.0.0 schema identifiers');
  }

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validatePlugin = ajv.compile(pluginSchema);
  const validateMcp = ajv.compile(mcpSchema);
  assertValid(validatePlugin, plugin, 'plugin.json');
  assertValid(validateMcp, mcp, 'mcp.json');

  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    validateServer(packageRoot, name, server);
  }
  validateSkills(packageRoot);

  return { plugin, mcp };
}

function readJson(packageRoot, path) {
  return JSON.parse(readFileSync(resolve(packageRoot, path), 'utf8'));
}

function assertValid(validate, value, name) {
  if (!validate(value)) {
    throw new Error(`${name} is not valid Agent Plugins 1.0.0 JSON: ${JSON.stringify(validate.errors)}`);
  }
}

function validateServer(packageRoot, name, server) {
  if (server.type === 'stdio') {
    if (!server.command.startsWith('./') || /\s/.test(server.command)) {
      throw new Error(`mcpServers.${name}.command must be one plugin-relative executable token`);
    }
    assertContained(packageRoot, resolve(packageRoot, server.command), `mcpServers.${name}.command`);
    if (server.cwd !== undefined) {
      assertCwdContained(packageRoot, name, server.cwd);
    }
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (key.toUpperCase() === 'PLUGIN_ROOT' || key.toUpperCase() === 'PLUGIN_DATA') {
        throw new Error(`mcpServers.${name}.env must not override ${key}`);
      }
      assertNoSecret(`${name}.env.${key}`, value);
    }
  }
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    assertNoSecret(`${name}.headers.${key}`, value);
  }
}

function assertCwdContained(packageRoot, name, cwd) {
  if (cwd.startsWith('./')) {
    assertContained(packageRoot, resolve(packageRoot, cwd), `mcpServers.${name}.cwd`);
    return;
  }
  if (cwd === '${PLUGIN_ROOT}' || cwd.startsWith('${PLUGIN_ROOT}/')) {
    assertContained(
      packageRoot,
      resolve(packageRoot, cwd.slice('${PLUGIN_ROOT}'.length)),
      `mcpServers.${name}.cwd`,
    );
    return;
  }
  if (cwd === '${PLUGIN_DATA}' || cwd.startsWith('${PLUGIN_DATA}/')) {
    return;
  }
  throw new Error(`mcpServers.${name}.cwd uses an unsupported placeholder`);
}

function assertNoSecret(label, value) {
  if (SECRET_PATTERN.test(label) || SECRET_PATTERN.test(String(value))) {
    throw new Error(`${label} appears to contain a credential or secret`);
  }
}

function validateSkills(packageRoot) {
  const skillsRoot = resolve(packageRoot, 'skills');
  if (existsSync(resolve(packageRoot, 'agent-skills'))) {
    throw new Error('agent-skills must not coexist with the canonical skills tree');
  }
  const skillFiles = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(skillsRoot, entry.name, 'SKILL.md'));
  if (skillFiles.length !== 1 || !skillFiles.every(existsSync)) {
    throw new Error('Expected exactly one canonical skills/<name>/SKILL.md source');
  }
  for (const skillFile of skillFiles) {
    if (!lstatSync(skillFile).isFile()) {
      throw new Error(`Skill file must be a regular file: ${skillFile}`);
    }
    assertContained(packageRoot, realpathSync(skillFile), 'skill file');
  }
}

function assertContained(root, candidate, label) {
  const rootPath = realpathSync(root);
  const candidatePath = existsSync(candidate) ? realpathSync(candidate) : candidate;
  const pathRelative = relative(rootPath, candidatePath);
  if (pathRelative === '..' || pathRelative.startsWith(`..${sep}`) || pathRelative === '') {
    if (pathRelative === '') return;
    throw new Error(`${label} escapes the plugin root`);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  validateAgentPlugin(resolve(process.argv[2] ?? '.'));
  console.log('Agent Plugins 1.0.0 configuration validated offline');
}
