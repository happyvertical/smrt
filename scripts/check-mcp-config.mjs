#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const repoRoot = process.cwd();
const configPath = resolve(repoRoot, process.argv[2] || '.mcp.json');

function isLocalPath(value) {
  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('/') ||
    value.startsWith('packages/') ||
    value.startsWith('scripts/') ||
    value.startsWith('docs/') ||
    value.startsWith('src/')
  );
}

function resolveLocal(value) {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function shouldCheckArg(value) {
  if (typeof value !== 'string') return false;
  if (!isLocalPath(value)) return false;
  if (value.includes('${')) return false;
  return /\.(?:[cm]?js|ts|tsx|sh)$/.test(value) || value.includes('/src/') || value.startsWith('packages/');
}

function checkExists(label, value, errors, { executable = false } = {}) {
  const target = resolveLocal(value);
  if (!existsSync(target)) {
    errors.push(`${label} points at missing path: ${value}`);
    return;
  }
  if (executable) {
    try {
      accessSync(target, constants.X_OK);
    } catch {
      errors.push(`${label} is not executable: ${value}`);
    }
  }
}

const errors = [];
let parsed;
try {
  parsed = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error(`Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const servers = parsed?.mcpServers;
if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
  errors.push('.mcp.json must contain an object at mcpServers');
} else {
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      errors.push(`${name} must be an object`);
      continue;
    }
    const command = server.command;
    if (typeof command !== 'string' || command.trim() === '') {
      errors.push(`${name}.command must be a non-empty string`);
    } else if (isLocalPath(command)) {
      checkExists(`${name}.command`, command, errors, { executable: command.endsWith('.sh') || command.startsWith('./') });
    }

    const args = Array.isArray(server.args) ? server.args : [];
    args.forEach((arg, index) => {
      if (shouldCheckArg(arg)) {
        checkExists(`${name}.args[${index}]`, arg, errors);
      }
    });
  }
}

if (errors.length > 0) {
  console.error('MCP config validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`✓ MCP config valid: ${Object.keys(servers || {}).length} server(s) checked`);
