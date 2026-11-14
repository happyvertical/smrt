import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mount, unmount } from 'svelte';
import { expect, it } from 'vitest';
import type { ApprovalView } from '../ui/types.ts';
import ApprovalCard from './ApprovalCard.svelte';

it('renders real Node engine previews in approval cards for all data and calculation operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-card-'));
  try {
    const output = join(dir, 'previews.json');
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'test-support/approval-engine-previews.ts', output],
      { timeout: 60000 },
    );
    const cards = JSON.parse(readFileSync(output, 'utf8')) as {
      name: string;
      command: Record<string, unknown>;
      summary: string;
      preview: unknown;
    }[];
    const expected: Record<string, string> = {
      insert: '1 inserted, 0 updated',
      upsert: 'overwrite stored values',
      merge: '1 record in Customers',
      extract: '2 records will be linked',
      plain: '2 stored values will be overwritten',
      replace: 'from Quantity to 3',
      clear: '2 records keep their current values',
      undo: 'original value',
      empty: '0 records will be recalculated',
    };
    expect(cards).toHaveLength(9);
    for (const card of cards) {
      const container = document.createElement('div');
      document.body.append(container);
      const approval: ApprovalView = {
        id: card.name,
        status: 'pending',
        summary: card.summary,
        preview: card.preview,
        action: { kind: 'command', command: card.command },
        requestedBy: '',
        decidedBy: '',
        decidedAt: '',
        result: null,
        createdAt: new Date().toISOString(),
      };
      const component = mount(ApprovalCard, {
        target: container,
        props: { approval },
      });
      try {
        expect(container.textContent, card.name).toContain(expected[card.name]);
        if (['empty', 'replace', 'clear', 'insert'].includes(card.name))
          expect(container.textContent, card.name).not.toContain(
            'will be overwritten',
          );
        if (card.name === 'clear')
          expect(container.textContent).toContain(
            'Future edits can set this field directly',
          );
      } finally {
        await unmount(component);
        container.remove();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90000);
