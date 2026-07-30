/** SQLite coverage for the tenant-safe Lead follow-up workflow. */

import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';
import {
  LeadWorkflowService,
  type LeadWorkflowValidationError,
  type LeadWorkQueueProjection,
  projectLeadWorkQueue,
} from '../services/LeadWorkflowService.js';

describe('LeadWorkflowService', () => {
  let db: DatabaseInterface;
  let leads: LeadCollection;
  let activities: SalesActivityCollection;
  let representatives: SalesRepresentativeCollection;
  let service: LeadWorkflowService;
  let tenantId: string;
  let actorProfileId: string;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase();
    leads = await LeadCollection.create({ db });
    activities = await SalesActivityCollection.create({ db });
    representatives = await SalesRepresentativeCollection.create({ db });
    service = await LeadWorkflowService.create({ db });
    tenantId = randomUUID();
    actorProfileId = randomUUID();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function createLead(name = 'Workflow prospect') {
    return await withTenant({ tenantId }, () => leads.create({ name }));
  }

  async function createRepresentative(
    status: 'active' | 'inactive' = 'active',
  ) {
    return await withTenant({ tenantId }, () =>
      representatives.create({
        tenantId,
        profileId: randomUUID(),
        slug: randomUUID(),
        status,
        title: 'Account Executive',
      }),
    );
  }

  async function workflow<T>(fn: () => Promise<T>): Promise<T> {
    return await withTenant({ tenantId }, fn);
  }

  it('assigns/reassigns an active same-tenant representative atomically and audits only effective changes', async () => {
    const lead = await createLead();
    const first = await createRepresentative();
    const second = await createRepresentative();

    const assigned = await workflow(() =>
      service.assignLead({
        leadId: lead.id as string,
        ownerRepId: first.id as string,
        actorProfileId,
      }),
    );
    const repeat = await workflow(() =>
      service.assignLead({
        leadId: lead.id as string,
        ownerRepId: first.id as string,
        actorProfileId,
      }),
    );
    const reassigned = await workflow(() =>
      service.assignLead({
        leadId: lead.id as string,
        ownerRepId: second.id as string,
        actorProfileId,
      }),
    );

    expect(assigned.changed).toBe(true);
    expect(repeat.changed).toBe(false);
    expect(reassigned.changed).toBe(true);
    expect((await workflow(() => leads.get({ id: lead.id })))?.ownerRepId).toBe(
      second.id,
    );
    const audit = await workflow(() =>
      activities.findBySubject('lead', lead.id as string),
    );
    expect(
      audit.filter((activity) => activity.activityKind === 'assignment'),
    ).toHaveLength(2);
    expect(audit[0].getMetadata()).toMatchObject({
      fromOwnerRepId: null,
      toOwnerRepId: first.id,
    });
    expect(audit[1].getMetadata()).toMatchObject({
      fromOwnerRepId: first.id,
      toOwnerRepId: second.id,
    });
  });

  it('fails closed for inactive, missing, and cross-tenant representatives', async () => {
    const lead = await createLead();
    const inactive = await createRepresentative('inactive');
    const otherTenant = randomUUID();
    const foreign = await withTenant({ tenantId: otherTenant }, () =>
      representatives.create({ profileId: randomUUID(), status: 'active' }),
    );

    await expect(
      workflow(() =>
        service.assignLead({
          leadId: lead.id as string,
          ownerRepId: inactive.id as string,
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'representative_inactive',
    });
    for (const ownerRepId of [randomUUID(), foreign.id as string]) {
      await expect(
        workflow(() =>
          service.assignLead({
            leadId: lead.id as string,
            ownerRepId,
            actorProfileId,
          }),
        ),
      ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
        reason: 'representative_unavailable',
      });
    }
    expect((await workflow(() => leads.get({ id: lead.id })))?.ownerRepId).toBe(
      null,
    );
  });

  it('audits legal start, disqualify, and reopen transitions while refusing illegal paths', async () => {
    const lead = await createLead();
    await workflow(() =>
      service.startWorking({ leadId: lead.id as string, actorProfileId }),
    );
    await workflow(() =>
      service.disqualifyLead({
        leadId: lead.id as string,
        actorProfileId,
        reason: 'Not a fit this quarter',
      }),
    );
    await workflow(() =>
      service.startWorking({ leadId: lead.id as string, actorProfileId }),
    );

    const statusAudit = (
      await workflow(() => activities.findBySubject('lead', lead.id as string))
    ).filter((activity) => activity.activityKind === 'status_change');
    expect(statusAudit.map((activity) => activity.getMetadata())).toMatchObject(
      [
        { from: 'new', to: 'working' },
        {
          from: 'working',
          to: 'disqualified',
          reason: 'Not a fit this quarter',
        },
        { from: 'disqualified', to: 'working' },
      ],
    );

    const qualified = await createLead('Qualified');
    await workflow(async () => {
      qualified.status = 'qualified';
      await qualified.save();
    });
    const merged = await createLead('Merged');
    await workflow(async () => {
      merged.status = 'merged';
      await merged.save();
    });
    for (const target of [qualified, merged]) {
      await expect(
        workflow(() =>
          service.startWorking({ leadId: target.id as string, actorProfileId }),
        ),
      ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
        reason: 'invalid_transition',
      });
    }
    await expect(
      workflow(() =>
        service.disqualifyLead({
          leadId: lead.id as string,
          actorProfileId,
          reason: '  ',
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'reason_required',
    });
  });

  it('records only allowed human activities with actor and plain JSON-object metadata', async () => {
    const lead = await createLead();
    const activity = await workflow(() =>
      service.recordActivity({
        leadId: lead.id as string,
        actorProfileId,
        activityKind: 'call',
        summary: 'Confirmed the discovery call',
        metadata: { channel: 'phone', contacts: ['Pat'] },
      }),
    );
    expect(activity.actorProfileId).toBe(actorProfileId);
    expect(activity.getMetadata()).toEqual({
      channel: 'phone',
      contacts: ['Pat'],
    });
    await expect(
      workflow(() =>
        service.recordActivity({
          leadId: lead.id as string,
          actorProfileId,
          activityKind: 'task' as never,
          summary: 'Not allowed here',
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'invalid_activity_kind',
    });
    await expect(
      workflow(() =>
        service.recordActivity({
          leadId: lead.id as string,
          actorProfileId,
          activityKind: 'note',
          summary: 'Bad metadata',
          metadata: [] as unknown as Record<string, unknown>,
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'invalid_metadata',
    });
  });

  it('schedules ordered next actions and completes one task exactly once', async () => {
    const lead = await createLead();
    const later = await workflow(() =>
      service.scheduleNextAction({
        leadId: lead.id as string,
        actorProfileId,
        summary: 'Send recap',
        dueAt: new Date('2026-09-02T16:00:00Z'),
      }),
    );
    const first = await workflow(() =>
      service.scheduleNextAction({
        leadId: lead.id as string,
        actorProfileId,
        summary: 'Call prospect',
        dueAt: new Date('2026-09-01T16:00:00Z'),
      }),
    );
    expect(
      (
        await workflow(() =>
          activities.findOpenTasks('lead', lead.id as string),
        )
      ).map((task) => task.id),
    ).toEqual([first.id, later.id]);

    const directTask = await workflow(() =>
      activities.get({ id: first.id }, { cache: false }),
    );
    if (!directTask) throw new Error('Expected scheduled task to be readable');
    directTask.completedAt = new Date('2026-09-01T17:00:00Z');
    await expect(directTask.save()).rejects.toThrow(
      'may only be set through LeadWorkflowService',
    );

    const retypedTask = await workflow(() =>
      activities.get({ id: first.id }, { cache: false }),
    );
    if (!retypedTask) throw new Error('Expected scheduled task to be readable');
    retypedTask.activityKind = 'note';
    await expect(retypedTask.save()).rejects.toThrow(
      'Lead task identity cannot be changed once persisted',
    );

    const completedRetypedTask = await workflow(() =>
      activities.get({ id: first.id }, { cache: false }),
    );
    if (!completedRetypedTask)
      throw new Error('Expected scheduled task to be readable');
    completedRetypedTask.activityKind = 'note';
    completedRetypedTask.completedAt = new Date('2026-09-01T17:00:00Z');
    await expect(completedRetypedTask.save()).rejects.toThrow(
      'Lead task identity cannot be changed once persisted',
    );

    const reassignedTask = await workflow(() =>
      activities.get({ id: first.id }, { cache: false }),
    );
    if (!reassignedTask)
      throw new Error('Expected scheduled task to be readable');
    reassignedTask.subjectKind = 'opportunity';
    reassignedTask.completedAt = new Date('2026-09-01T17:00:00Z');
    await expect(reassignedTask.save()).rejects.toThrow(
      'Lead task identity cannot be changed once persisted',
    );
    await expect(
      workflow(() => activities.get({ id: first.id }, { cache: false })),
    ).resolves.toMatchObject({
      subjectKind: 'lead',
      activityKind: 'task',
      completedAt: null,
    });

    const opportunityTask = await workflow(() =>
      activities.create({
        tenantId,
        subjectKind: 'opportunity',
        subjectId: randomUUID(),
        activityKind: 'task',
        summary: 'Existing opportunity task',
        dueAt: new Date('2026-09-01T16:00:00Z'),
        actorProfileId,
      }),
    );
    opportunityTask.completedAt = new Date('2026-09-01T17:00:00Z');
    await expect(opportunityTask.save()).resolves.toBe(opportunityTask);

    const completed = await workflow(() =>
      service.completeNextAction({
        leadId: lead.id as string,
        taskId: first.id as string,
        actorProfileId,
        now: new Date('2026-09-01T17:00:00Z'),
      }),
    );
    const replay = await workflow(() =>
      service.completeNextAction({
        leadId: lead.id as string,
        taskId: first.id as string,
        actorProfileId,
      }),
    );
    expect(completed.completed).toBe(true);
    expect(replay.completed).toBe(false);
    expect(replay.task.completedAt?.toISOString()).toBe(
      '2026-09-01T17:00:00.000Z',
    );
    expect(
      await workflow(() => activities.findOpenTasks('lead', lead.id as string)),
    ).toEqual([expect.objectContaining({ id: later.id })]);
    const completionAudit = (
      await workflow(() => activities.findBySubject('lead', lead.id as string))
    ).filter((activity) => activity.activityKind === 'task_completion');
    expect(completionAudit).toHaveLength(1);
    expect(completionAudit[0].getMetadata()).toMatchObject({
      taskId: first.id,
    });
    await expect(
      workflow(() =>
        service.completeNextAction({
          leadId: lead.id as string,
          taskId: first.id as string,
          actorProfileId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'completion_replay_conflict',
    });
    await expect(
      workflow(() =>
        service.scheduleNextAction({
          leadId: lead.id as string,
          actorProfileId,
          summary: 'Invalid date',
          dueAt: new Date('not a date'),
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'invalid_due_at',
    });
  });

  it('projects the persisted owner and earliest next action without imposing host policy', async () => {
    const lead = await createLead();
    const representative = await createRepresentative();
    expect(
      (
        await workflow(() =>
          service.getLeadWorkState({ leadId: lead.id as string }),
        )
      ).queue.state,
    ).toBe('unassigned');

    await workflow(() =>
      service.assignLead({
        leadId: lead.id as string,
        ownerRepId: representative.id as string,
        actorProfileId,
      }),
    );
    expect(
      (
        await workflow(() =>
          service.getLeadWorkState({ leadId: lead.id as string }),
        )
      ).queue.state,
    ).toBe('no_next_action');

    const first = await workflow(() =>
      service.scheduleNextAction({
        leadId: lead.id as string,
        actorProfileId,
        summary: 'Soonest next action',
        dueAt: new Date('2026-10-01T12:00:00Z'),
      }),
    );
    await workflow(() =>
      service.scheduleNextAction({
        leadId: lead.id as string,
        actorProfileId,
        summary: 'Later next action',
        dueAt: new Date('2026-10-02T12:00:00Z'),
      }),
    );
    const state = await workflow(() =>
      service.getLeadWorkState({
        leadId: lead.id as string,
        now: new Date('2026-09-30T12:00:00Z'),
      }),
    );
    expect(state.owner?.id).toBe(representative.id);
    expect(state.earliestOpenTask?.id).toBe(first.id);
    expect(state.queue.state).toBe('upcoming');
  });

  it('returns merge-aware chronology for original, workflow, qualification, and merge history', async () => {
    const winner = await createLead('Timeline winner');
    const loser = await createLead('Timeline loser');
    const representative = await createRepresentative();
    await workflow(() =>
      service.assignLead({
        leadId: winner.id as string,
        ownerRepId: representative.id as string,
        actorProfileId,
      }),
    );
    await workflow(() =>
      service.startWorking({ leadId: winner.id as string, actorProfileId }),
    );
    const task = await workflow(() =>
      service.scheduleNextAction({
        leadId: winner.id as string,
        actorProfileId,
        summary: 'Timeline task',
        dueAt: new Date('2026-11-01T12:00:00Z'),
      }),
    );
    await workflow(() =>
      service.completeNextAction({
        leadId: winner.id as string,
        taskId: task.id as string,
        actorProfileId,
      }),
    );
    await workflow(() =>
      service.recordActivity({
        leadId: loser.id as string,
        actorProfileId,
        activityKind: 'note',
        summary: 'Original loser follow-up',
      }),
    );
    await workflow(() => leads.qualify({ leadId: winner.id as string }));
    await workflow(() =>
      leads.mergeLeads({
        winnerId: winner.id as string,
        loserId: loser.id as string,
        actorProfileId,
        reason: 'Duplicate prospect',
      }),
    );

    const timeline = await workflow(() =>
      service.getLeadTimeline(winner.id as string),
    );
    expect(timeline.map((activity) => activity.activityKind)).toEqual(
      expect.arrayContaining([
        'assignment',
        'status_change',
        'task',
        'task_completion',
        'qualification',
        'merge',
        'note',
      ]),
    );
    expect(timeline.map((activity) => activity.summary)).toContain(
      'Original loser follow-up',
    );
  });

  it('refuses wrong-subject and cross-tenant tasks without exposing their rows', async () => {
    const lead = await createLead();
    const otherLead = await createLead('Other lead');
    const otherTask = await workflow(() =>
      service.scheduleNextAction({
        leadId: otherLead.id as string,
        actorProfileId,
        summary: 'Other task',
        dueAt: new Date('2026-09-02T12:00:00Z'),
      }),
    );
    await expect(
      workflow(() =>
        service.completeNextAction({
          leadId: lead.id as string,
          taskId: otherTask.id as string,
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'task_unavailable',
    });

    const foreignTenant = randomUUID();
    const foreignLead = await withTenant({ tenantId: foreignTenant }, () =>
      leads.create({ name: 'Foreign lead' }),
    );
    await expect(
      workflow(() => service.getLeadTimeline(foreignLead.id as string)),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'lead_unavailable',
    });
  });

  it('rolls back the lead mutation when its audit append fails', async () => {
    const lead = await createLead();
    const representative = await createRepresentative();
    await db.query(`
      CREATE TRIGGER fail_assignment_audit
      BEFORE INSERT ON sales_activities
      WHEN NEW.activity_kind = 'assignment'
      BEGIN
        SELECT RAISE(ABORT, 'injected assignment audit failure');
      END
    `);

    await expect(
      workflow(() =>
        service.assignLead({
          leadId: lead.id as string,
          ownerRepId: representative.id as string,
          actorProfileId,
        }),
      ),
    ).rejects.toThrow('injected assignment audit failure');
    expect((await workflow(() => leads.get({ id: lead.id })))?.ownerRepId).toBe(
      null,
    );
  });

  it('serializes concurrent completion into one effective event and one compatible replay', async () => {
    const lead = await createLead();
    const task = await workflow(() =>
      service.scheduleNextAction({
        leadId: lead.id as string,
        actorProfileId,
        summary: 'Concurrent task',
        dueAt: new Date('2026-09-03T12:00:00Z'),
      }),
    );
    const firstWorkflow = await LeadWorkflowService.create({ db });
    const secondWorkflow = await LeadWorkflowService.create({ db });
    const [first, second] = await workflow(() =>
      Promise.all([
        firstWorkflow.completeNextAction({
          leadId: lead.id as string,
          taskId: task.id as string,
          actorProfileId,
        }),
        secondWorkflow.completeNextAction({
          leadId: lead.id as string,
          taskId: task.id as string,
          actorProfileId,
        }),
      ]),
    );
    expect([first.completed, second.completed].sort()).toEqual([false, true]);
    expect(
      (
        await workflow(() =>
          activities.findBySubject('lead', lead.id as string),
        )
      ).filter((activity) => activity.activityKind === 'task_completion'),
    ).toHaveLength(1);
  });
});

describe('projectLeadWorkQueue', () => {
  const now = new Date('2026-07-02T05:30:00.000Z');

  function state(
    input: Parameters<typeof projectLeadWorkQueue>[0],
  ): LeadWorkQueueProjection {
    return projectLeadWorkQueue({
      now,
      timeZone: 'America/Edmonton',
      ...input,
    });
  }

  it('classifies unassigned, unscheduled, overdue, due-today, upcoming, terminal, and reopenable Leads with injected time', () => {
    expect(state({ status: 'new' }).state).toBe('unassigned');
    expect(state({ status: 'working', ownerRepId: 'rep' }).state).toBe(
      'no_next_action',
    );
    expect(
      state({
        status: 'working',
        ownerRepId: 'rep',
        nextAction: { dueAt: new Date('2026-07-02T05:00:00Z') },
      }).state,
    ).toBe('overdue');
    expect(
      state({
        status: 'working',
        ownerRepId: 'rep',
        nextAction: { dueAt: new Date('2026-07-02T05:45:00Z') },
      }).state,
    ).toBe('due_today');
    expect(
      state({
        status: 'working',
        ownerRepId: 'rep',
        nextAction: { dueAt: new Date('2026-07-03T18:00:00Z') },
      }).state,
    ).toBe('upcoming');
    expect(state({ status: 'qualified', ownerRepId: 'rep' }).state).toBe(
      'terminal',
    );
    expect(state({ status: 'disqualified', ownerRepId: 'rep' }).state).toBe(
      'reopenable',
    );
  });

  it('falls back to the runtime timezone for invalid host timezone input', () => {
    const input = {
      status: 'working' as const,
      ownerRepId: 'rep',
      nextAction: { dueAt: new Date('2026-07-02T05:45:00Z') },
      now,
    };
    expect(
      projectLeadWorkQueue({ ...input, timeZone: 'Not/A_Real_Timezone' }),
    ).toEqual(projectLeadWorkQueue(input));
  });
});
