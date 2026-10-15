/**
 * Service-backed write actions for `ServiceTimeEntry` (#4001).
 *
 * The generated CRUD writes stay closed: these are the only generated write
 * path, and each delegates to {@link ServiceEvidenceService}, so the status
 * machine, the submission/approval trail and the charge/compensation
 * snapshots are set in exactly one place. The thin collection methods in
 * `models/service-time-entry.ts` call in here.
 */
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshotCollection,
} from '../models/service-snapshots.js';
import type {
  ServiceTimeEntry,
  ServiceTimeEntryCollection,
} from '../models/service-time-entry.js';
import type { ServiceEvidence } from '../types.js';
import {
  authorizeTimesheetAction,
  principalHolds,
  TimesheetActionError,
  type TimesheetActionPrincipal,
  withActionPrincipal,
} from './action-principal.js';
import {
  type ServiceCommercialResolver,
  ServiceEvidenceService,
} from './service-evidence-service.js';

/** Approval path stamped by the generated `approve` action. */
export const SERVICE_TIME_ENTRY_ACTION_APPROVAL_PATH = 'operator';

/**
 * What `approve` prices with: a resolver, or a factory the action calls per
 * request with the collection's options. Use the factory whenever the
 * resolver writes (e.g. smrt-projects' `SubscriptionServiceCommercialResolver`
 * records client charges): `options.db` is the request-bound executor, so
 * those writes share the request's transaction and PostgreSQL RLS state
 * instead of a connection captured at startup.
 */
export type ServiceTimeEntryCommercialResolverSource =
  | ServiceCommercialResolver
  | ((context: {
      options: SmrtClassOptions;
    }) => ServiceCommercialResolver | Promise<ServiceCommercialResolver>);

let actionCommercialResolver: ServiceTimeEntryCommercialResolverSource | null =
  null;

/**
 * Install what the generated `approve` action prices with. Pass `null` to
 * remove it. Without one, `approve` refuses with 409
 * (`approval_not_configured`) and writes nothing.
 *
 * @example
 * ```ts
 * setServiceTimeEntryCommercialResolver(({ options }) =>
 *   SubscriptionServiceCommercialResolver.create(options, provider),
 * );
 * ```
 */
export function setServiceTimeEntryCommercialResolver(
  resolver: ServiceTimeEntryCommercialResolverSource | null,
): void {
  actionCommercialResolver = resolver;
}

/** The source installed by {@link setServiceTimeEntryCommercialResolver}. */
export function getServiceTimeEntryCommercialResolver(): ServiceTimeEntryCommercialResolverSource | null {
  return actionCommercialResolver;
}

/** Body of the `record` action. Identity and tenant come from the session. */
export interface RecordServiceTimeActionInput {
  workRefType: string;
  workRefId: string;
  /** Defaults to the acting user's profile; another person needs `approve`. */
  participantProfileId?: string | null;
  /** `manual` (default) or `timer`; imports and agents use the service. */
  source?: 'manual' | 'timer';
  description?: string;
  /** ISO 8601 instant. */
  startedAt?: string | null;
  /** ISO 8601 instant. */
  endedAt?: string | null;
  durationSeconds?: number | null;
  /** Exact positive decimal text; exclusive with seconds and timestamps. */
  durationHours?: string;
  evidence?: ServiceEvidence[];
  metadata?: Record<string, unknown>;
}

/** Body of the `submit` and `approve` actions. */
export interface ServiceTimeEntryActionTarget {
  entryId: string;
}

type ActionOptions = SmrtClassOptions;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TimesheetActionError(
      400,
      'invalid_request',
      'The action body must be a JSON object.',
    );
  }
  return value as Record<string, unknown>;
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new TimesheetActionError(
      400,
      'invalid_request',
      `${key} must be a string.`,
    );
  }
  return value;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key)?.trim();
  if (!value) {
    throw new TimesheetActionError(
      400,
      'invalid_request',
      `${key} is required.`,
    );
  }
  return value;
}

function optionalInstant(
  body: Record<string, unknown>,
  key: string,
): Date | null {
  const value = optionalString(body, key);
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TimesheetActionError(
      400,
      'invalid_request',
      `${key} must be an ISO 8601 instant.`,
    );
  }
  return date;
}

/**
 * Plain `Error`s from {@link ServiceEvidenceService} are its own input and
 * state preconditions; surface them as 400 instead of an opaque 500. Typed
 * errors (database, revision conflicts) pass through unchanged.
 */
async function serviceCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && error.constructor === Error) {
      throw new TimesheetActionError(400, 'invalid_request', error.message);
    }
    throw error;
  }
}

async function evidenceService(
  entries: ServiceTimeEntryCollection,
  commercial?: ServiceCommercialResolver,
): Promise<ServiceEvidenceService> {
  const options = entries.options;
  const [charges, compensation] = await Promise.all([
    ServiceChargeSnapshotCollection.create(options),
    ServiceCompensationSnapshotCollection.create(options),
  ]);
  return new ServiceEvidenceService(entries, charges, compensation, commercial);
}

function itemClass(entries: ServiceTimeEntryCollection) {
  return (entries.constructor as unknown as { _itemClass: unknown })
    ._itemClass as typeof ServiceTimeEntry;
}

async function loadEntry(
  entries: ServiceTimeEntryCollection,
  principal: TimesheetActionPrincipal,
  body: Record<string, unknown>,
): Promise<ServiceTimeEntry> {
  const entryId = requiredString(body, 'entryId');
  const entry = await entries.get({ id: entryId });
  // Optional tenancy also admits global (NULL-tenant) rows in a tenant
  // context; a write must land on the principal's own tenant only.
  if (!entry || (entry.tenantId ?? null) !== principal.tenantId) {
    throw new TimesheetActionError(
      404,
      'not_found',
      `Service time entry ${entryId} was not found.`,
    );
  }
  return entry;
}

/** `record`: create a draft entry through `ServiceEvidenceService.record()`. */
export async function recordServiceTimeAction(
  entries: ServiceTimeEntryCollection,
  input: unknown,
): Promise<ServiceTimeEntry> {
  const body = asRecord(input);
  const principal = await authorizeTimesheetAction(
    itemClass(entries),
    'record',
    entries.options as ActionOptions,
    { allowSuperAdminBypass: true },
  );
  const participantProfileId =
    optionalString(body, 'participantProfileId')?.trim() || principal.profileId;
  if (
    participantProfileId !== principal.profileId &&
    !(await principalHolds(itemClass(entries), 'approve', entries.options))
  ) {
    throw new TimesheetActionError(
      403,
      'permission_denied',
      "Recording another person's time needs the approve permission.",
    );
  }
  const source = optionalString(body, 'source') ?? 'manual';
  if (source !== 'manual' && source !== 'timer') {
    throw new TimesheetActionError(
      400,
      'invalid_request',
      "source must be 'manual' or 'timer'.",
    );
  }
  const durationSeconds = body.durationSeconds;
  if (
    durationSeconds !== undefined &&
    durationSeconds !== null &&
    typeof durationSeconds !== 'number'
  ) {
    throw new TimesheetActionError(
      400,
      'invalid_request',
      'durationSeconds must be a number.',
    );
  }
  const evidence = body.evidence;
  if (evidence !== undefined && !Array.isArray(evidence)) {
    throw new TimesheetActionError(
      400,
      'invalid_request',
      'evidence must be an array.',
    );
  }
  const metadata = body.metadata;
  if (
    metadata !== undefined &&
    (metadata === null ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata))
  ) {
    throw new TimesheetActionError(
      400,
      'invalid_request',
      'metadata must be an object.',
    );
  }
  return withActionPrincipal(principal, async () => {
    const service = await evidenceService(entries);
    return serviceCall(() =>
      service.record({
        tenantId: principal.tenantId,
        workRefType: requiredString(body, 'workRefType'),
        workRefId: requiredString(body, 'workRefId'),
        participantKind: 'human',
        participantProfileId,
        source,
        description: optionalString(body, 'description') ?? '',
        startedAt: optionalInstant(body, 'startedAt'),
        endedAt: optionalInstant(body, 'endedAt'),
        ...(durationSeconds !== undefined
          ? { durationSeconds: durationSeconds as number | null }
          : {}),
        ...(body.durationHours !== undefined
          ? { durationHours: optionalString(body, 'durationHours') }
          : {}),
        ...(evidence ? { evidence: evidence as ServiceEvidence[] } : {}),
        ...(metadata ? { metadata: metadata as Record<string, unknown> } : {}),
      }),
    );
  });
}

/**
 * `submit`: `draft | rejected → submitted` through
 * `ServiceEvidenceService.submit()`, stamping `submittedAt` and the acting
 * profile. Only the entry's participant may submit it, unless the caller
 * holds `approve` (a supervisor submitting on someone's behalf).
 */
export async function submitServiceTimeAction(
  entries: ServiceTimeEntryCollection,
  input: unknown,
): Promise<ServiceTimeEntry> {
  const body = asRecord(input);
  const principal = await authorizeTimesheetAction(
    itemClass(entries),
    'submit',
    entries.options,
    { allowSuperAdminBypass: true },
  );
  return withActionPrincipal(principal, async () => {
    const entry = await loadEntry(entries, principal, body);
    if (
      entry.participantProfileId !== principal.profileId &&
      !(await principalHolds(itemClass(entries), 'approve', entries.options))
    ) {
      throw new TimesheetActionError(
        403,
        'permission_denied',
        "Submitting another person's time needs the approve permission.",
      );
    }
    const service = await evidenceService(entries);
    return serviceCall(() => service.submit(entry, principal.profileId));
  });
}

/**
 * `approve`: `submitted → approved` through `ServiceEvidenceService.approve()`,
 * which stamps `approvedAt`, the acting profile and the approval path, then
 * writes the immutable charge and compensation snapshots through the
 * installed {@link setServiceTimeEntryCommercialResolver resolver} (a factory
 * is called per request with the collection's options). Money:
 * super-admin bypass does not apply, the grant must be explicit.
 */
export async function approveServiceTimeAction(
  entries: ServiceTimeEntryCollection,
  input: unknown,
): Promise<ServiceTimeEntry> {
  const body = asRecord(input);
  const principal = await authorizeTimesheetAction(
    itemClass(entries),
    'approve',
    entries.options,
    { allowSuperAdminBypass: false },
  );
  const source = actionCommercialResolver;
  if (!source) {
    throw new TimesheetActionError(
      // A 4xx so generated transports return the message; the host has not
      // installed the pricing the approval needs.
      409,
      'approval_not_configured',
      'No ServiceCommercialResolver is installed for time entry approval.',
    );
  }
  return withActionPrincipal(principal, async () => {
    const entry = await loadEntry(entries, principal, body);
    // Built per request inside the principal's tenancy context, on the same
    // options (and so the same request-bound executor) as the entries.
    const commercial =
      typeof source === 'function'
        ? await source({ options: entries.options })
        : source;
    const service = await evidenceService(entries, commercial);
    return serviceCall(() =>
      service.approve(entry, {
        actorProfileId: principal.profileId,
        approvalPath: SERVICE_TIME_ENTRY_ACTION_APPROVAL_PATH,
      }),
    );
  });
}
