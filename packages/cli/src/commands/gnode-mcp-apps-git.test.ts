import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { gnodeCommands } from './gnode.js';

it('extracts an offline Git subdirectory and adds its MCP Apps overlay through the real loaders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-offline-git-'));
  const nested = join(root, 'repo/nested');
  mkdirSync(join(nested, 'template'), { recursive: true });
  mkdirSync(join(nested, 'mcp-apps-template/src'), { recursive: true });
  writeFileSync(join(root, 'repo/package.json'), '{"type":"module"}');
  writeFileSync(
    join(nested, 'template.config.js'),
    'export default {name:"offline",description:"fixture",framework:"sveltekit",dependencies:{},devDependencies:{}};',
  );
  writeFileSync(join(nested, 'template/package.json'), '{}');
  writeFileSync(
    join(nested, 'mcp-apps-template/package.dependencies.json'),
    '{}',
  );
  writeFileSync(
    join(nested, 'mcp-apps-template/src/offline.txt'),
    'real extracted overlay',
  );
  const tar = join(root, 'fixture.tgz');
  execFileSync('tar', ['-czf', tar, '-C', root, 'repo']);
  const get = vi.spyOn(https, 'get').mockImplementation((_url, callback) => {
    const request = Object.assign(new EventEmitter(), {
      setTimeout() {
        return this;
      },
      destroy() {
        return this;
      },
    });
    queueMicrotask(() => {
      const response = Object.assign(createReadStream(tar), {
        statusCode: 200,
        headers: {},
      });
      (callback as (value: unknown) => void)(response);
    });
    return request as ReturnType<typeof https.get>;
  });
  try {
    await gnodeCommands['gnode create'].handler(['offline'], {
      template: 'github:synthetic/offline/nested',
      outputDir: join(root, 'app'),
      mcpApps: true,
    });
    expect(readFileSync(join(root, 'app/src/offline.txt'), 'utf8')).toBe(
      'real extracted overlay',
    );
    expect(existsSync(join(root, 'app/mcp-apps/plugin.json'))).toBe(true);
    expect(get).toHaveBeenCalledOnce();
  } finally {
    get.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
