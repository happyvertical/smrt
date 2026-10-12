#!/usr/bin/env node
/** Make an isolated local plugin copy against this checkout's built CLI. */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const [destination, plannerUi] = process.argv.slice(2);
if (!destination || Number(process.versions.node.split('.')[0]) < 26) {
  throw new Error('Use Node 26+: node scripts/local-plugin.mjs <new-directory> [planner/app/mcp.html]');
}
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(plugin, '../..');
const cli = resolve(root, 'packages/cli/dist/index.js');
if (!existsSync(cli)) throw new Error('Build @happyvertical/smrt-cli before creating the local plugin.');
const target = resolve(destination);
if (existsSync(target)) throw new Error('Destination must not exist; keep each local plugin copy isolated.');
const ui = plannerUi ? resolve(plannerUi) : undefined;
if (ui && !existsSync(ui)) throw new Error('Planner UI HTML does not exist.');
const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
mkdirSync(dirname(target), { recursive: true });
cpSync(plugin, target, { recursive: true });
const config = JSON.parse(readFileSync(resolve(plugin, 'mcp.json'), 'utf8'));
config.mcpServers['smrt-kitchen'] = {
  type: 'stdio',
  command: './scripts/launch-local',
};
const launcher = resolve(target, 'scripts/launch-local');
const plansDir = resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'smrt-kitchen/plans');
const args = [process.execPath, cli, 'kitchen', 'mcp', '--ui-smoke', '--no-registry', '--plans-dir', plansDir, '--preview-port', '0', '--preview-origin', 'http://127.0.0.1:5173', ...(ui ? ['--planner-ui', ui] : [])];
writeFileSync(launcher, `#!/bin/sh\ncd ${shellQuote(root)} || exit 1\nexec ${args.map(shellQuote).join(' ')}\n`);
chmodSync(launcher, 0o755);
writeFileSync(resolve(target, 'mcp.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log(`Local plugin ready: ${target}`);
console.log('Install this copy through a local marketplace; restart the host after rebuilding the CLI or launcher. Planner HTML rebuilds reload in an open app tab.');
