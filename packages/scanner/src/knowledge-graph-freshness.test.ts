import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKnowledgeGraphFreshness } from './knowledge-graph';

const GRAPH = '.smrt/smrt-knowledge-graph.json';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-graph-fresh-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeGraph(raw: string): void {
  const file = join(root, GRAPH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, raw);
}

describe('checkKnowledgeGraphFreshness malformed graph (#3075)', () => {
  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a non-object sourceHashes', '{"sourceHashes":5}'],
    ['an array sourceHashes', '{"sourceHashes":[]}'],
    ['a non-string hash value', '{"sourceHashes":{"a.json":1}}'],
  ])('reports %s as malformed instead of throwing', (_label, raw) => {
    writeGraph(raw);
    const issues = checkKnowledgeGraphFreshness(root, GRAPH);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: 'error',
      code: 'stale-knowledge-graph',
      file: GRAPH,
    });
    expect(issues[0].message).toContain(`${GRAPH} is malformed`);
  });

  it('treats a graph without sourceHashes as recording no artifacts', () => {
    writeGraph('{"schemaVersion":1,"packages":[]}');
    expect(checkKnowledgeGraphFreshness(root, GRAPH)).toEqual([]);
  });
});
