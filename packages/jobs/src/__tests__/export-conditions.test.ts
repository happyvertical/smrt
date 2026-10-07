import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as jobs from '../index.js';
import * as jobsNode from '../index.node.js';
import * as runner from '../runner.js';

describe('package export conditions (#3615)', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, Record<string, unknown>> };

  it('resolves the root to the Node entry under node, browser-safe otherwise', () => {
    const root = pkg.exports['.'];
    // `node` first so it wins for Node (runtime and types); bundlers skip it.
    expect(Object.keys(root)[0]).toBe('node');
    expect(root.node).toEqual({
      types: './dist/index.node.d.ts',
      import: './dist/index.node.js',
    });
    expect(root.types).toBe('./dist/index.d.ts');
    expect(root.import).toBe('./dist/index.js');
  });

  it('keeps ./runner as an explicit subpath', () => {
    expect(pkg.exports['./runner']).toEqual({
      types: './dist/runner.d.ts',
      import: './dist/runner.js',
    });
  });

  it('keeps the browser-safe root free of the runner names', () => {
    for (const name of [
      'TaskRunner',
      'createTaskRunner',
      'JobTimeoutError',
    ] as const) {
      expect(jobs).not.toHaveProperty(name);
    }
  });

  it('exposes the root plus the runner names from the Node entry', () => {
    expect(jobsNode.TaskRunner).toBe(runner.TaskRunner);
    expect(jobsNode.createTaskRunner).toBe(runner.createTaskRunner);
    expect(jobsNode.JobTimeoutError).toBe(runner.JobTimeoutError);
    for (const name of Object.keys(jobs)) {
      expect(jobsNode).toHaveProperty(name);
    }
  });
});
