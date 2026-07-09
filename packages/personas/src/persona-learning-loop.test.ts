/**
 * Integration tests for the persona learning & adaptation loop (#1889).
 *
 * Exercises every acceptance criterion end-to-end against real in-memory SQLite
 * (only the reflection/AI boundary is a stub):
 *
 *   - two personas of one agent class behave differently (instructions applied
 *     via tenant/persona-scoped prompt overrides) and learn in separate memory
 *     scopes;
 *   - the ReflectionRunner emits pending directive proposals it CANNOT activate
 *     (its principal lacks `personas.activate-directive`);
 *   - a human holding that permission approves — activating the persona-scoped
 *     override — while a rejection is recorded as a signal and never re-surfaced;
 *   - a non-editable prompt template cannot be overridden (`validatePromptOverride`).
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import { clearPromptCache, PromptRegistry } from '@happyvertical/smrt-prompts';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import { PermissionCatalogService } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentPersona, AgentPersonaCollection } from './agent-persona.js';
import {
  DirectiveActivationDeniedError,
  DirectiveApprovalService,
} from './directive-approval.js';
import {
  ACTIVATE_DIRECTIVE_PERMISSION,
  type DirectivePrincipal,
  ensurePersonaPermissionsRegistered,
  principalFromPermissions,
} from './directive-principal.js';
import { DirectiveProposalCollection } from './directive-proposal.js';
import { FeedbackCollection } from './feedback.js';
import { personaLearningMemory, personaMemoryScope } from './persona-memory.js';
import {
  applyPersonaInstructions,
  ensurePersonaInstructionsPrompt,
  resolvePersonaInstructions,
} from './persona-prompt.js';
import type { DirectiveReflector } from './reflection-runner.js';
import { ReflectionRunner } from './reflection-runner.js';

const TENANT = 'tenant-a';
const AGENT = '@happyvertical/smrt-agents:Praeco';

const CLASSES = [
  'AgentPersona',
  'Feedback',
  'DirectiveProposal',
  'PromptOverride',
];

describe('persona learning & adaptation loop (#1889)', () => {
  let db: DatabaseInterface;
  let personas: AgentPersonaCollection;
  let reflectionPrincipal: DirectivePrincipal;
  let humanPrincipal: DirectivePrincipal;

  beforeEach(async () => {
    disableTenancy();
    PromptRegistry.clear();
    clearPromptCache();
    ensurePersonaPermissionsRegistered();
    db = await getTestDatabase({ classes: CLASSES });
    personas = await AgentPersonaCollection.create({ db });
    // The autonomous reflection principal holds NO permissions.
    reflectionPrincipal = principalFromPermissions([], {
      id: 'reflection-bot',
    });
    // The reviewer holds the activation permission.
    humanPrincipal = principalFromPermissions([ACTIVATE_DIRECTIVE_PERMISSION], {
      id: 'reviewer-1',
    });
  });

  afterEach(async () => {
    PromptRegistry.clear();
    clearPromptCache();
    if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
      await (db as { close: () => Promise<void> }).close();
    }
  });

  async function createPersona(
    name: string,
    instructions: string,
    memoryScope: string,
  ): Promise<AgentPersona> {
    return personas.create({
      tenantId: TENANT,
      agentClass: AGENT,
      name,
      instructions,
      runAsUserId: 'user-runas',
      memoryScope,
    });
  }

  it('applies two personas differently via prompt overrides and isolates their memory', async () => {
    const terse = await createPersona('Terse', 'Be terse.', 'praeco:terse');
    const verbose = await createPersona(
      'Verbose',
      'Be verbose and thorough.',
      'praeco:verbose',
    );

    await applyPersonaInstructions({ persona: terse, db });
    await applyPersonaInstructions({ persona: verbose, db });

    // Behaviour: the same agent class resolves different instructions per persona.
    expect(await resolvePersonaInstructions({ persona: terse, db })).toBe(
      'Be terse.',
    );
    expect(await resolvePersonaInstructions({ persona: verbose, db })).toBe(
      'Be verbose and thorough.',
    );

    // Memory: each persona's memoryScope routes an isolated partition.
    expect(personaMemoryScope(terse)).not.toBe(personaMemoryScope(verbose));
    const terseMem = personaLearningMemory({ db, persona: terse });
    const verboseMem = personaLearningMemory({ db, persona: verbose });

    await terseMem.capture(
      { scope: 'task', key: 'k', value: 'terse-strategy' },
      { success: true },
    );
    await verboseMem.capture(
      { scope: 'task', key: 'k', value: 'verbose-strategy' },
      { success: true },
    );

    const terseRecall = await terseMem.recall('task', { key: 'k' });
    const verboseRecall = await verboseMem.recall('task', { key: 'k' });
    expect(terseRecall.map((r) => r.value)).toEqual(['terse-strategy']);
    expect(verboseRecall.map((r) => r.value)).toEqual(['verbose-strategy']);
  });

  it('registers the activation permission in the manifest-derived catalog', () => {
    const catalog = PermissionCatalogService.create({}).getCatalog();
    const slugs = catalog.permissions.map((p) => p.slug);
    expect(slugs).toContain(ACTIVATE_DIRECTIVE_PERMISSION);
  });

  it('proposes but cannot activate under the reflection principal; a human with the permission activates', async () => {
    const persona = await createPersona(
      'Learner',
      'Base instructions.',
      'praeco:learner',
    );
    await applyPersonaInstructions({ persona, db });

    const memory = personaLearningMemory({ db, persona });
    // A failing episode is captured as evidence of a strategy that stopped working.
    await memory.capture(
      { scope: 'task', key: 'k1', value: 'failing-strategy' },
      { success: false },
    );

    // A human reject signal against that episode, carrying a correlation-id.
    const feedback = await FeedbackCollection.create({ db });
    await feedback.create({
      tenantId: TENANT,
      personaId: persona.id,
      agentClass: AGENT,
      memoryScope: personaMemoryScope(persona),
      scope: 'task',
      key: 'k1',
      signalType: 'reject',
      source: 'human',
      correlationId: 'ai-call-1',
      correlationType: 'ai_call',
      actorId: 'user-2',
    });

    const reflect: DirectiveReflector = async (input) => {
      // The reflector sees the current instructions, episodes, and feedback.
      expect(input.currentInstructions).toBe('Base instructions.');
      expect(input.feedback.length).toBeGreaterThan(0);
      return {
        instructions: 'Be terse and cite sources.',
        rationale:
          'Recent rejections indicate over-verbosity; tighten the directive.',
        confidence: 0.82,
      };
    };

    const runner = new ReflectionRunner({
      db,
      principal: reflectionPrincipal,
      reflect,
    });
    const result = await runner.run({
      persona,
      memory,
      episodeScope: 'task',
    });

    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal.status).toBe('pending');
    expect(proposal.proposedInstructions).toBe('Be terse and cite sources.');
    expect(proposal.rationale).toContain('tighten');
    expect(proposal.getEvidence().feedbackIds?.length).toBeGreaterThan(0);
    expect(proposal.proposedBy).toBe('reflection-bot');

    const approval = new DirectiveApprovalService({ db });

    // The reflection principal lacks the permission → it can only propose.
    await expect(
      approval.approve(proposal, reflectionPrincipal),
    ).rejects.toBeInstanceOf(DirectiveActivationDeniedError);

    // The proposal is untouched by the denied attempt.
    const queue = await DirectiveProposalCollection.create({ db });
    expect(await queue.pending()).toHaveLength(1);

    // A human holding the permission activates it.
    const { override } = await approval.approve(proposal, humanPrincipal, {
      note: 'Approved.',
    });
    expect(override.template).toBe('Be terse and cite sources.');

    // The persona-scoped override now drives the resolved instructions.
    expect(await resolvePersonaInstructions({ persona, db })).toBe(
      'Be terse and cite sources.',
    );

    // The approval was recorded as a human accept signal correlated to the proposal.
    const signals = await feedback.byCorrelation(proposal.id as string);
    expect(
      signals.some((s) => s.signalType === 'accept' && s.source === 'human'),
    ).toBe(true);

    // The queue is now empty (the proposal is approved, not pending).
    expect(await queue.pending()).toHaveLength(0);
  });

  it('supports an edited approval that activates the reviewer-revised text', async () => {
    const persona = await createPersona('Editable', 'Start.', 'praeco:edit');
    await applyPersonaInstructions({ persona, db });

    const reflect: DirectiveReflector = async () => ({
      instructions: 'Model proposal.',
      rationale: 'because',
      confidence: 0.6,
    });
    const runner = new ReflectionRunner({
      db,
      principal: reflectionPrincipal,
      reflect,
    });
    const { proposals } = await runner.run({
      persona,
      memory: personaLearningMemory({ db, persona }),
    });

    const approval = new DirectiveApprovalService({ db });
    const { override } = await approval.approve(proposals[0], humanPrincipal, {
      editedInstructions: 'Reviewer-revised directive.',
    });

    expect(override.template).toBe('Reviewer-revised directive.');
    expect(await resolvePersonaInstructions({ persona, db })).toBe(
      'Reviewer-revised directive.',
    );
  });

  it('records a rejection as a signal and never re-surfaces the same proposal', async () => {
    const persona = await createPersona('Rejected', 'Base.', 'praeco:reject');
    await applyPersonaInstructions({ persona, db });

    const reflect: DirectiveReflector = async () => ({
      instructions: 'Rewrite candidate.',
      rationale: 'candidate rationale',
      confidence: 0.7,
    });
    const runner = new ReflectionRunner({
      db,
      principal: reflectionPrincipal,
      reflect,
    });
    const memory = personaLearningMemory({ db, persona });

    const first = await runner.run({ persona, memory });
    expect(first.proposals).toHaveLength(1);
    const proposal = first.proposals[0];

    const approval = new DirectiveApprovalService({ db });
    const { proposal: rejected, signal } = await approval.reject(
      proposal,
      humanPrincipal,
      { note: 'Not appropriate.' },
    );
    expect(rejected.status).toBe('rejected');
    expect(signal.signalType).toBe('reject');
    expect(signal.correlationId).toBe(proposal.id);

    // Re-running produces the identical candidate → deduped, not re-surfaced.
    const second = await runner.run({ persona, memory });
    expect(second.proposals).toHaveLength(0);
    expect(second.skipped).toBe(1);

    const queue = await DirectiveProposalCollection.create({ db });
    expect(
      await queue.pending({ personaId: persona.id ?? undefined }),
    ).toHaveLength(0);
  });

  it('cannot override a non-editable prompt template', async () => {
    const persona = await createPersona('Locked', 'Base.', 'praeco:locked');
    // Lock the persona's instructions template against overrides.
    ensurePersonaInstructionsPrompt(persona, { editable: { template: false } });

    const reflect: DirectiveReflector = async () => ({
      instructions: 'Attempted rewrite.',
      rationale: 'x',
      confidence: 0.5,
    });
    const runner = new ReflectionRunner({
      db,
      principal: reflectionPrincipal,
      reflect,
    });
    const { proposals } = await runner.run({
      persona,
      memory: personaLearningMemory({ db, persona }),
    });
    expect(proposals).toHaveLength(1);

    // The reviewer holds the permission, but the prompt field is non-editable,
    // so activation is refused by validatePromptOverride.
    const approval = new DirectiveApprovalService({ db });
    await expect(
      approval.approve(proposals[0], humanPrincipal),
    ).rejects.toThrow(/does not allow template overrides/);

    // Nothing was activated: the proposal remains pending.
    const queue = await DirectiveProposalCollection.create({ db });
    expect(await queue.pending()).toHaveLength(1);
  });
});
