import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mount, tick, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import ApprovalsPage from '../../routes/approvals/+page.svelte';
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
      rawSummary?: string;
      preview: unknown;
      status?: string;
      result?: unknown;
      preserved?: boolean;
      view?: ApprovalView;
    }[];
    const expected: Record<string, string> = {
      insert: '1 inserted, 0 updated',
      removeField: 'Removes Invoice total from Invoices',
      removeModel: 'Removes the model Invoices',
      changeType:
        'Changes Invoice total in Invoices from whole numbers to text',
      method: 'Adds Send reminder code to Invoices',
      template: 'Code for Send greeting in Members',
      recordDelete: 'Deletes “Acme” in Contacts',
      toolDelete: 'Deletes “Acme” in Contacts',
      restDelete: 'Deletes “Acme” in Contacts',
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
    expect(cards).toHaveLength(24);
    const rendered: string[] = [];
    for (const card of cards) {
      const container = document.createElement('div');
      document.body.append(container);
      const approval: ApprovalView = card.view ?? {
        id: card.name,
        status: (card.status ?? 'pending') as ApprovalView['status'],
        summary: card.rawSummary ?? card.summary,
        humanSummary: card.summary,
        preview: card.preview,
        action: { kind: 'command', command: card.command },
        requestedBy: '',
        decidedBy: '',
        decidedAt: '',
        result: card.result ?? null,
        createdAt: new Date().toISOString(),
      };
      const ondecide = vi.fn();
      const component = mount(ApprovalCard, {
        target: container,
        props: { approval, ondecide },
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
        if (card.name === 'undoRefused') {
          expect(
            [...container.querySelectorAll('button')].filter(
              (button) =>
                /Approve/.test(button.textContent ?? '') && !button.disabled,
            ),
          ).toHaveLength(0);
          const deny = [...container.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === 'Deny',
          );
          expect(deny?.disabled).toBe(false);
          deny?.click();
          expect(ondecide).toHaveBeenCalledWith(false);
          expect(container.textContent).toContain(
            'Cannot undo: 1 record needs attention. Orders “QA changed order”',
          );
        }
        if (
          [
            'removeField',
            'removeModel',
            'changeType',
            'method',
            'template',
            'recordDelete',
            'toolDelete',
            'restDelete',
          ].includes(card.name)
        ) {
          expect(container.textContent).not.toContain('InvoiceEntry');
          expect(container.textContent).not.toContain('TemplateContact');
          expect(container.textContent).not.toContain('UndoContact');
          expect(container.textContent).not.toContain('/api/');
          expect(container.textContent).not.toMatch(
            /[0-9a-f]{8}-[0-9a-f]{4}-/i,
          );
        }
        if (card.name === 'extract')
          expect(container.textContent).toContain('1 linked record created');
        if (card.name === 'method')
          expect(container.querySelector('code')?.textContent).toBe(
            'return 1;',
          );
        if (card.name === 'template')
          expect(container.querySelector('code')?.textContent).toBe(
            'return 2;',
          );
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
        if (card.name === 'replace') {
          expect(container.textContent).toContain(
            'Undo restores the previous calculation',
          );
          expect(container.textContent).not.toContain(
            'Undo restores the original values',
          );
        }
        if (card.name === 'plain')
          expect(container.textContent).toContain(
            'Undo restores the original values',
          );
        if (['insert', 'upsert', 'merge'].includes(card.name))
          expect(container.textContent).toContain(
            'Later edits can prevent undo.',
          );
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
    const remove = cards.find((card) => card.name === 'removeField');
    if (!remove) throw new Error('Expected real remove-field preview');
    const target = document.createElement('div');
    document.body.append(target);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'denied' }), { status: 200 }),
      ),
    );
    const page = mount(ApprovalsPage, {
      target,
      props: {
        data: {
          approvals: [
            {
              id: 'status',
              status: 'pending',
              summary: remove.rawSummary,
              humanSummary: remove.summary,
              preview: remove.preview,
              action: { kind: 'command', command: remove.command },
              createdAt: new Date().toISOString(),
              requestedBy: '',
              decidedBy: '',
              decidedAt: '',
              result: null,
            },
          ],
          session: null,
        },
      } as never,
    });
    try {
      await tick();
      [...target.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'Deny')
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();
      expect(target.querySelector('[role="status"]')?.textContent).toBe(
        `Denied: ${remove.summary}`,
      );
      expect(
        target.querySelector('[role="status"]')?.textContent,
      ).not.toContain('InvoiceEntry');
      rendered.push(
        `approvalStatus\n${target.querySelector('[role="status"]')?.textContent}`,
      );
    } finally {
      await unmount(page);
      target.remove();
      vi.unstubAllGlobals();
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
