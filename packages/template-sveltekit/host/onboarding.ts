/** Resumable local-owner composition. The cookbook service remains the mutation authority. */
import { createHash, randomUUID } from 'node:crypto';
import type { AssistantApprovalView } from '@happyvertical/smrt-chat/assistant-turn';
import {
  createCookbookEngine,
  type EngineCatalog,
} from '@happyvertical/smrt-core/cookbook/engine';
import type {
  CookbookToolName,
  CookbookToolResult,
} from '@happyvertical/smrt-core/cookbook/tools';
import type {
  OnboardingAction,
  OnboardingProgress,
  OnboardingState,
  OnboardingTemplate,
} from '@happyvertical/smrt-svelte/onboarding';
import type { Cookbook } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { RequestEvent } from '@sveltejs/kit';

const TABLE = '_smrt_cookbook_onboarding';
const initial: OnboardingProgress = {
  step: 'welcome',
  completed: false,
  rerunning: false,
  selected: null,
  approvalId: null,
};
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Actor = { userId: string; tenantId: string };
type Saved = OnboardingProgress & {
  revision: string;
  preview: OnboardingState['preview'];
  signature?: string;
};
export async function createCookbookOnboarding(options: {
  db: DatabaseInterface;
  catalog: EngineCatalog;
  authorize(event: { locals: unknown }): Promise<Actor | null>;
  invoke(
    actor: Actor,
    name: CookbookToolName,
    args: Record<string, unknown>,
  ): Promise<CookbookToolResult>;
  approval(actor: Actor, id: string): Promise<AssistantApprovalView | null>;
}) {
  const { db } = options;
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (tenant_id, user_id))`,
  );
  async function read(actor: Actor): Promise<Saved> {
    await db.query(
      `INSERT INTO ${TABLE} (tenant_id, user_id, revision, state) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      actor.tenantId,
      actor.userId,
      randomUUID(),
      JSON.stringify({ ...initial, preview: null }),
    );
    const row = (
      await db.query(
        `SELECT revision, state FROM ${TABLE} WHERE tenant_id = ? AND user_id = ?`,
        actor.tenantId,
        actor.userId,
      )
    ).rows[0];
    if (!row) throw new Error('Onboarding unavailable');
    return { ...JSON.parse(String(row.state)), revision: String(row.revision) };
  }
  async function save(actor: Actor, before: Saved, after: Saved) {
    const revision = randomUUID();
    const result = await db.query(
      `UPDATE ${TABLE} SET revision = ?, state = ? WHERE tenant_id = ? AND user_id = ? AND revision = ? RETURNING revision`,
      revision,
      JSON.stringify(after),
      actor.tenantId,
      actor.userId,
      before.revision,
    );
    if (result.rows.length !== 1) throw new Error('Onboarding changed');
    return { ...after, revision };
  }
  const lists = (document: Cookbook) =>
    createCookbookEngine({ catalog: options.catalog, cookbook: document })
      .snapshot()
      .sections.filter((s) => !s.hidden)
      .flatMap((s) => s.items.filter((i) => !i.hidden).map((i) => i.label));
  async function project(actor: Actor, saved: Saved): Promise<OnboardingState> {
    const approval = saved.approvalId
      ? await options.approval(actor, saved.approvalId)
      : null;
    if (approval?.status === 'succeeded' && saved.step !== 'done') {
      saved = await save(actor, saved, {
        ...saved,
        completed: true,
        rerunning: false,
        step: 'done',
        preview: null,
      });
    }
    let templates: OnboardingTemplate[] = [];
    if (saved.step === 'template') {
      try {
        templates = (await options.invoke(actor, 'cookbook.listTemplates', {}))
          .templates as OnboardingTemplate[];
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'forbidden'
        )
          throw error;
      }
    }
    return {
      step: saved.step,
      completed: saved.completed,
      rerunning: saved.rerunning,
      selected: saved.selected,
      approvalId: saved.approvalId,
      revision: saved.revision,
      preview: saved.preview,
      approval,
      templates,
    };
  }
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
  async function handle(event: RequestEvent) {
    const actor = await options.authorize(event);
    if (!actor) return json({ code: 'not_allowed' }, 403);
    if (!['GET', 'POST'].includes(event.request.method))
      return json({ code: 'method_not_allowed' }, 405);
    try {
      if (event.request.method === 'GET')
        return json(await project(actor, await read(actor)));
      if (event.request.headers.get('origin') !== event.url.origin)
        return json({ code: 'invalid_origin' }, 403);
      if (
        event.request.headers.get('content-type')?.split(';')[0].trim() !==
        'application/json'
      )
        return json({ code: 'invalid_request' }, 415);
      const reader = event.request.body?.getReader();
      if (!reader) return json({ code: 'invalid_request' }, 400);
      let raw = '';
      try {
        const decoder = new TextDecoder();
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 4096) {
            await reader.cancel();
            return json({ code: 'body_too_large' }, 413);
          }
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      let body: OnboardingAction & { revision: string };
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ code: 'invalid_request' }, 400);
      }
      if (
        !body ||
        Array.isArray(body) ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (k) => !['action', 'revision', 'id'].includes(k),
        ) ||
        typeof body.action !== 'string' ||
        typeof body.revision !== 'string'
      )
        return json({ code: 'invalid_request' }, 400);
      const saved = await read(actor);
      const held = saved.approvalId
        ? await options.approval(actor, saved.approvalId)
        : null;
      const unsettled =
        !!saved.approvalId &&
        (!held || ['pending', 'approved', 'executing'].includes(held.status));
      if (body.revision !== saved.revision)
        return json({ code: 'conflict' }, 409);
      const next = { ...saved };
      switch (body.action) {
        case 'welcome':
          if (saved.step !== 'welcome' || saved.completed)
            return json({ code: 'invalid_step' }, 409);
          next.step = 'ai';
          break;
        case 'continue':
        case 'skip':
          if (saved.step !== 'ai') return json({ code: 'invalid_step' }, 409);
          next.step = 'template';
          break;
        case 'back':
          if (unsettled || !['ai', 'template'].includes(saved.step))
            return json({ code: 'invalid_step' }, 409);
          next.step = saved.step === 'ai' ? 'welcome' : 'ai';
          next.preview = null;
          next.selected = null;
          next.approvalId = null;
          break;
        case 'restart':
          if (!saved.completed || saved.rerunning)
            return json({ code: 'invalid_step' }, 409);
          Object.assign(next, {
            step: 'template',
            rerunning: true,
            selected: null,
            preview: null,
            approvalId: null,
          });
          break;
        case 'cancel':
          if (!saved.rerunning || unsettled)
            return json({ code: 'invalid_step' }, 409);
          Object.assign(next, {
            step: 'done',
            rerunning: false,
            selected: null,
            preview: null,
            approvalId: null,
          });
          break;
        case 'preview': {
          if (
            saved.step !== 'template' ||
            unsettled ||
            typeof body.id !== 'string'
          )
            return json({ code: 'invalid_step' }, 409);
          const preview = await options.invoke(actor, 'cookbook.apply', {
            id: body.id,
          });
          const diff = preview.diff as { before: Cookbook; after: Cookbook };
          next.selected = body.id;
          next.approvalId = null;
          next.preview = {
            id: body.id,
            previewToken: String(preview.previewToken),
            revision: Number(preview.revision),
            before: lists(diff.before),
            after: lists(diff.after),
          };
          next.signature = hash(diff);
          break;
        }
        case 'apply': {
          if (saved.step !== 'template' || !saved.preview || saved.approvalId)
            return json({ code: 'invalid_step' }, 409);
          // Refresh process-local preview receipts after a restart, but only for exactly the reviewed diff/revision.
          const preview = await options.invoke(actor, 'cookbook.apply', {
            id: saved.preview.id,
          });
          if (
            hash(preview.diff) !== saved.signature ||
            preview.revision !== saved.preview.revision
          )
            return json({ code: 'preview_changed' }, 409);
          const result = await options.invoke(actor, 'cookbook.apply', {
            id: saved.preview.id,
            apply: true,
            expectedRevision: preview.revision,
            previewToken: preview.previewToken,
          });
          if (result.status === 'approval_required')
            next.approvalId = String(result.approvalId);
          else if (result.status === 'ok')
            Object.assign(next, {
              step: 'done',
              completed: true,
              rerunning: false,
              preview: null,
            });
          else throw new Error('Unexpected application result');
          break;
        }
        default:
          return json({ code: 'invalid_request' }, 400);
      }
      return json(await project(actor, await save(actor, saved, next)));
    } catch {
      return json({ code: 'onboarding_failed' }, 503);
    }
  }
  return {
    handle,
    async load(event: { locals: unknown }) {
      const actor = await options.authorize(event);
      return actor ? project(actor, await read(actor)) : null;
    },
  };
}
