#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packagesDir = join(root, 'packages');
const sourceExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.svelte']);
const skippedDirectories = new Set(['node_modules', 'dist', '.smrt', '.generated-tmp']);
const banned = [
  ['PingRequestSchema', 'ping was removed'],
  ['logging/setLevel', 'logging/setLevel was removed'],
  ['SetLevelRequestSchema', 'logging/setLevel was removed'],
  ['notifications/roots/list_changed', 'roots list_changed was removed'],
  ['RootsListChangedNotificationSchema', 'roots list_changed was removed'],
  ['ListRootsRequestSchema', 'roots are deprecated'],
  ['sampling/createMessage', 'sampling is deprecated'],
  ['CreateMessageRequestSchema', 'sampling is deprecated'],
  ['mcp-session-id', 'sessions were removed'],
  ['SSEServerTransport', 'HTTP+SSE is deprecated'],
  ['SSEClientTransport', 'HTTP+SSE is deprecated'],
];
const findings = [];

for (const packageName of readdirSync(packagesDir)) {
  const packageDir = join(packagesDir, packageName);
  const manifestPath = join(packageDir, 'package.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (manifest[section]?.['@modelcontextprotocol/sdk']) {
        findings.push(`${relative(root, manifestPath)}: direct monolithic SDK dependency`);
      }
    }
  } catch {}

  const sourceDir = join(packageDir, 'src');
  try {
    if (statSync(sourceDir).isDirectory()) scan(sourceDir);
  } catch {}
}

function scan(directory) {
  for (const entry of readdirSync(directory)) {
    if (skippedDirectories.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      scan(path);
      continue;
    }
    if (!sourceExtensions.has(extname(path))) continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes('mcp-protocol-hygiene-allow:')) return;
      for (const [token, reason] of banned) {
        if (line.toLowerCase().includes(token.toLowerCase())) {
          findings.push(`${relative(root, path)}:${index + 1}: ${reason} (${token})`);
        }
      }
      if (/\b(?:client|server|mcp\w*)\s*\.\s*ping\s*\(/.test(line)) {
        findings.push(`${relative(root, path)}:${index + 1}: ping was removed`);
      }
    });
  }
}

if (findings.length) {
  console.error(`MCP 2026-07-28 protocol hygiene failed:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log('MCP protocol hygiene passed: scoped SDK manifests and no removed features.');
