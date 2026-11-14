import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      status?: string;
      result?: unknown;
      preserved?: boolean;
      view?: ApprovalView;
    }[];
    const expected: Record<string, string> = {
      insert: '1 inserted, 0 updated',
      upsert: 'overwrite stored values',
      merge: '1 record in Customers',
      mergeCapped: '12 records in total',
      extract: '2 records will be linked',
      plain: '2 stored values will be overwritten',
      replace: 'from Quantity to 3',
      clear: '2 records keep their current values',
      undoCalculation: 'Invoice total in Customers',
      undoLoad: 'removes 1 inserted record and restores 1 updated value',
      undoRefused: '1 record needs attention',
      undoFailed: '1 record needs attention',
      undoMerge: 'recreates 1 removed record and points 1 reference back',
      undoExtract:
        'restores 2 original text values and removes 1 created linked record',
      undoType: 'Undoes the type change for Invoice total in Customers',
      empty: '0 records will be recalculated',
    };
    expect(cards).toHaveLength(16);
    const rendered: string[] = [];
    for (const card of cards) {
      const container = document.createElement('div');
      document.body.append(container);
      const approval: ApprovalView = card.view ?? {
        id: card.name,
        status: (card.status ?? 'pending') as ApprovalView['status'],
        summary: card.summary,
        preview: card.preview,
        action: { kind: 'command', command: card.command },
        requestedBy: '',
        decidedBy: '',
        decidedAt: '',
        result: card.result ?? null,
        createdAt: new Date().toISOString(),
      };
      const component = mount(ApprovalCard, {
        target: container,
        props: { approval, ondecide: () => {} },
      });
      try {
        rendered.push(
          `${card.name}\nHeading: ${container.querySelector('h3')?.textContent}\n${[
            ...container.querySelectorAll('p,li'),
          ]
            .filter((element) => !element.querySelector('time'))
            .map((element) => element.textContent?.trim())
            .filter(Boolean)
            .join('\n')}`,
        );
        expect(container.textContent, card.name).toContain(expected[card.name]);
        if (
          [
            'undoLoad',
            'undoMerge',
            'undoExtract',
            'undoCalculation',
            'undoType',
          ].includes(card.name)
        ) {
          expect(container.textContent).not.toContain('cannot undo');
          expect(
            [...container.querySelectorAll('button')].some(
              (button) =>
                /Approve/.test(button.textContent ?? '') && !button.disabled,
            ),
          ).toBe(true);
        }
        if (card.name === 'undoRefused')
          expect(
            [...container.querySelectorAll('button')].filter(
              (button) =>
                /Approve/.test(button.textContent ?? '') && !button.disabled,
            ),
          ).toHaveLength(0);
        if (card.name === 'undoCalculation')
          expect(container.textContent).toContain('2 original stored values');
        if (card.name === 'undoType') {
          expect(container.textContent).toContain('2 archived original values');
          expect(container.textContent).not.toContain('refuses conflicts');
        }
        if (card.name === 'undoFailed') {
          expect(card.preserved).toBe(true);
          expect(container.querySelector('h3')?.textContent).toBe(
            'Undo: load into Contacts',
          );
          expect(container.textContent).not.toContain('the app did not start');
        }
        if (card.name === 'mergeCapped') {
          expect(container.querySelectorAll('li[title]')).toHaveLength(10);
          expect(container.textContent).toContain('the selected record');
          expect(container.textContent).not.toContain('Removed 11');
          expect(container.textContent).not.toMatch(
            /[0-9a-f]{8}-[0-9a-f]{4}-/i,
          );
        }
        if (card.name === 'merge') {
          expect(container.textContent).toContain('1 reference in Orders');
          const label = container.querySelector('li[title]');
          expect(label?.getAttribute('title')).toContain('<b>Removed</b>');
          expect(label?.textContent).toContain('…');
          expect(container.querySelector('b')).toBeNull();
          expect(container.textContent).toContain('1 record in total');
        }
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
    if (process.env.SMRT_APPROVAL_TEXT_ARTIFACT)
      writeFileSync(
        process.env.SMRT_APPROVAL_TEXT_ARTIFACT,
        rendered.join('\n\n'),
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90000);
