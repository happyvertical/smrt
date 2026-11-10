/**
 * Declared recipes for smrt-support (#4409, #4437): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { SupportCase } from './models/support-case.js';
import { SupportInteraction } from './models/support-interaction.js';
import { SupportSpecialist } from './models/support-specialist.js';

/** Support tickets: Track what customers ask for help with, until it is solved. */
export class SupportTicketsRecipe extends SmrtRecipe {
  static id = 'support.tickets';
  static help = './tickets.recipe.md';
  static label = 'Support';
  static summary =
    'Keep every customer request for help in one place until it is solved.';
  static synonyms = [
    'support tickets',
    'tickets',
    'helpdesk',
    'help desk',
    'customer support',
    'cases',
  ];
  static section = {
    id: 'support',
    label: 'Support',
    icon: 'users',
    description: 'Help your customers and keep track of every request.',
  };
  static models = [SupportCase, SupportInteraction, SupportSpecialist];
  static nav = [
    {
      label: 'Tickets',
      model: SupportCase,
      icon: 'fileText',
      description:
        'Every request for help, who is handling it and where it stands.',
      noun: 'ticket',
    },
    {
      label: 'Messages',
      model: SupportInteraction,
      icon: 'book',
      description:
        'What was said on each ticket, by the customer or your team.',
      noun: 'message',
    },
    {
      label: 'Support team',
      model: SupportSpecialist,
      icon: 'users',
      description: 'The people who answer tickets and when they are available.',
      noun: 'team member',
    },
  ];
  static options = {
    SupportCase: {
      fields: {
        caseNumber: { label: 'Ticket number', order: 1 },
        subject: { order: 2 },
        description: { order: 3 },
        status: { order: 4 },
        priority: { order: 5 },
        clientProfileId: { label: 'Customer', order: 6 },
        assignedSpecialistId: { label: 'Assigned to', order: 7 },
        tenantId: { visibility: 'hidden' },
        assignedAt: { visibility: 'hidden' },
        escalatedAt: { visibility: 'hidden' },
        acknowledgedAt: { visibility: 'hidden' },
        firstRespondedAt: { visibility: 'hidden' },
        humanRequestedAt: { visibility: 'hidden' },
        resolvedAt: { visibility: 'hidden' },
        closedAt: { visibility: 'hidden' },
        lastReopenedAt: { visibility: 'hidden' },
        severity: { visibility: 'advanced' },
        category: { visibility: 'advanced' },
        sensitive: { visibility: 'advanced' },
        channelKind: { visibility: 'advanced' },
        openedByProfileId: { visibility: 'advanced' },
        resolutionSummary: { visibility: 'advanced' },
        projectId: { visibility: 'hidden' },
        bindingId: { visibility: 'hidden' },
        threadKey: { visibility: 'hidden' },
        planId: { visibility: 'hidden' },
        planSnapshot: { visibility: 'hidden' },
        preferredSpecialistId: { visibility: 'hidden' },
        escalationLevel: { visibility: 'hidden' },
        resolvedByProfileId: { visibility: 'hidden' },
        resolutionKind: { visibility: 'hidden' },
        reopenCount: { visibility: 'hidden' },
        aiEnabled: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    SupportInteraction: {
      fields: {
        body: { label: 'Message', order: 1 },
        caseId: { label: 'Ticket', order: 2 },
        direction: { order: 3 },
        tenantId: { visibility: 'hidden' },
        channelKind: { visibility: 'advanced' },
        actorKind: { visibility: 'advanced' },
        authorProfileId: { visibility: 'advanced' },
        sourceType: { visibility: 'hidden' },
        sourceId: { visibility: 'hidden' },
        sourceKey: { visibility: 'hidden' },
        rfcMessageId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    SupportSpecialist: {
      fields: {
        displayName: { label: 'Name', order: 1 },
        status: { order: 2 },
        tenantId: { visibility: 'hidden' },
        profileId: { visibility: 'advanced' },
        languages: { visibility: 'advanced' },
        timezone: { visibility: 'advanced' },
        maxConcurrentCases: {
          label: 'Most tickets at once',
          visibility: 'advanced',
        },
        onCallPriority: { visibility: 'hidden' },
        notes: { visibility: 'advanced' },
        metadata: { visibility: 'hidden' },
      },
    },
  } as const;
}
