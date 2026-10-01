/** Validate opt-in portable MCP Apps metadata before an application build. */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (process.argv[2] !== 'validate-if-present') {
  throw new Error('Usage: smrt-mcp-apps.mjs validate-if-present');
}

if (!existsSync('mcp-apps')) process.exit(0);

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(
  command,
  ['exec', 'smrt', 'mcp-apps', 'validate', '--output-dir', './mcp-apps'],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
