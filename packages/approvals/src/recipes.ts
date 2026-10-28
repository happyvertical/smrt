/**
 * Declared recipes for smrt-approvals (#4409): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { ApprovalEvent } from './models/ApprovalEvent.js';
import { ApprovalPolicy } from './models/ApprovalPolicy.js';
import { ApprovalRequest } from './models/ApprovalRequest.js';

/**
 * Approvals: who has to say yes before something happens. Every model is
 * exposed read-only (`list`/`get`); the approval service is the only write
 * path, so the generated screens find and read, never change.
 */
export class ApprovalsRecipe extends SmrtRecipe {
  static id = 'approvals.requests';
  static help = './requests.recipe.md';
  static label = 'Approvals';
  static summary =
    'See what is waiting for a yes, who decided what, and the rules each kind of approval follows.';
  static synonyms = [
    'approvals',
    'approval requests',
    'sign-off',
    'sign off',
    'authorisation',
    'authorization',
    'review queue',
    'waiting for approval',
  ];
  static section = {
    id: 'approvals',
    label: 'Approvals',
    icon: 'done',
    description: 'Who has to say yes before something happens.',
  };
  static models = [ApprovalRequest, ApprovalEvent, ApprovalPolicy];
  static nav = [
    {
      label: 'Requests',
      model: ApprovalRequest,
      icon: 'fileText',
      description:
        'Everything waiting for a yes or already decided, and where each one stands.',
      noun: 'request',
    },
    {
      label: 'History',
      model: ApprovalEvent,
      icon: 'book',
      description: 'Who did what on each request, and when.',
      noun: 'history entry',
    },
    {
      label: 'Policies',
      model: ApprovalPolicy,
      icon: 'settings',
      description:
        'The rules for each kind of approval: how many people must agree and how long a request lasts.',
      noun: 'policy',
    },
  ];
  static options = {
    ApprovalRequest: {
      fields: {
        summary: { order: 1 },
        kind: { order: 2 },
        status: { order: 3 },
        requestedBy: { label: 'Requested by', order: 4 },
        requestedByType: { label: 'Requested by a', order: 5 },
        expiresAt: { label: 'Expires', order: 6 },
        decidedAt: { label: 'Decided on', order: 7 },
        subjectType: { label: 'What it is about', visibility: 'advanced' },
        subjectId: { label: 'Which one', visibility: 'advanced' },
        requiredApprovals: {
          label: 'Approvals needed',
          visibility: 'advanced',
        },
        approvalCount: { label: 'Approvals so far', visibility: 'advanced' },
        consumedAt: { label: 'Used on', visibility: 'advanced' },
        consumedBy: { label: 'Used by', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        subjectRevisionHash: { visibility: 'hidden' },
        requestKey: { visibility: 'hidden' },
        requiredPermissions: { visibility: 'hidden' },
        version: { visibility: 'hidden' },
      },
    },
    ApprovalEvent: {
      fields: {
        requestId: { label: 'Request', order: 1 },
        type: { label: 'What happened', order: 2 },
        actorId: { label: 'Who', order: 3 },
        actorType: { label: 'Who it was', order: 4 },
        reason: { order: 5 },
        occurredAt: { label: 'When', order: 6 },
        selfApproved: {
          label: 'Decided by the requester',
          visibility: 'advanced',
        },
        tenantId: { visibility: 'hidden' },
        subjectRevisionHash: { visibility: 'hidden' },
        sequence: { visibility: 'hidden' },
        voteKey: { visibility: 'hidden' },
        selfApprovalPermission: { visibility: 'hidden' },
      },
    },
    ApprovalPolicy: {
      fields: {
        kind: { order: 1 },
        requiredApprovals: { label: 'Approvals needed', order: 2 },
        ttlMs: { label: 'Time limit in milliseconds', order: 3 },
        requiredPermission: { label: 'Extra permission needed', order: 4 },
        updatedBy: { label: 'Last changed by', order: 5 },
        tenantId: { visibility: 'hidden' },
      },
    },
  } as const;
}
