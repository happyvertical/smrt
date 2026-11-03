import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { BookingError } from './errors.js';
import type {
  AvailabilityInput,
  BookingAccess,
  BookingAuthority,
  BookingContext,
  BookingHistoryEvent,
  BookingKind,
  BookingOffering,
  BookingOperation,
  BookingPage,
  BookingPageOptions,
  BookingProposal,
  BookingReceipt,
  BookingReferences,
  BookingStatus,
  BookingView,
  DeclaredAvailabilityWindow,
  ListBookingsOptions,
  ProposeBookingInput,
  ProviderAvailability,
  RequestBookingInput,
  ResolvedBookingWindow,
} from './types.js';
import {
  declareWindows,
  elapsedHour,
  fitsCapacity,
  type Reservation,
  resolveBookingWindow,
  supervisionDeclared,
} from './windows.js';

type WriteOperation = Exclude<BookingOperation, 'read' | 'history'>;

interface BookingRow {
  id: string;
  offering_id: string;
  contact_id: string;
  project_id: string | null;
  kind: BookingKind;
  status: BookingStatus;
  proposal_id: string | null;
  assented_proposal_id: string | null;
  confirmed_proposal_id: string | null;
}

interface ProposalRow {
  provider_id: string;
  coverage: string;
  terms: string;
  approved_plan: string | null;
}

interface Allocation extends Reservation {
  window: ResolvedBookingWindow;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BookingError('invalid', 'Expected a UUID reference');
  }
  return value.toLowerCase();
}

function pageBounds({ afterId, limit = 50 }: BookingPageOptions) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BookingError('invalid', 'Page limit must be between 1 and 100');
  }
  return { after: afterId === undefined ? null : id(afterId), limit };
}

function page<T>(
  rows: T[],
  limit: number,
  cursor: (item: T) => string,
): BookingPage<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? cursor(rows[limit - 1]) : null,
  };
}

function bookingView(
  row: BookingRow,
  proposal: BookingProposal | null,
): BookingView {
  return {
    id: row.id,
    offeringId: row.offering_id,
    contactId: row.contact_id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    proposal,
    assentedProposalId: row.assented_proposal_id,
    confirmedProposalId: row.confirmed_proposal_id,
  };
}

function proposalView(proposalId: string, row: ProposalRow): BookingProposal {
  return {
    id: proposalId,
    providerId: row.provider_id,
    window: JSON.parse(row.coverage),
    terms: JSON.parse(row.terms),
    approvedPlan:
      row.approved_plan === null ? null : JSON.parse(row.approved_plan),
  };
}

function required(value: string, max = 200): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max ||
    value.includes('\0')
  ) {
    throw new BookingError(
      'invalid',
      'Expected a nonempty text value within the length limit',
    );
  }
  return value;
}

function identity(input: BookingContext): Readonly<BookingContext> {
  return Object.freeze({
    tenantId: id(input.tenantId),
    actorId: required(input.actorId),
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function operator(access: BookingAccess): void {
  if (!access.operator)
    throw new BookingError('forbidden', 'Operator access required');
}

function contact(access: BookingAccess, contactId: string): void {
  if (access.contactId !== contactId) {
    throw new BookingError(
      'forbidden',
      'Only the named customer contact may act for this booking',
    );
  }
}

function visible(access: BookingAccess, row: BookingRow): void {
  if (!access.operator && access.contactId !== row.contact_id) {
    throw new BookingError('not-found', 'Booking does not exist');
  }
}

function pending(row: BookingRow): void {
  if (row.status !== 'requested' && row.status !== 'proposed') {
    throw new BookingError('conflict', 'Booking is no longer pending');
  }
}

function declared(
  kind: BookingKind,
  window: ResolvedBookingWindow,
  availability: readonly DeclaredAvailabilityWindow[],
): void {
  if (
    (kind === 'supervision-day' &&
      !supervisionDeclared(window, availability)) ||
    (kind === 'developer-hour' &&
      !availability.some((entry) => entry.zone === window.zone)) ||
    !fitsCapacity(
      { ...window, exclusive: kind === 'developer-hour' },
      availability,
      [],
    )
  ) {
    throw new BookingError(
      'unavailable',
      'The proposed window is outside declared availability',
    );
  }
}

/** Transactional PostgreSQL service. The application supplies trusted identity and authorization. */
export class BookingService {
  readonly #db: DatabaseInterface;
  readonly #authority: BookingAuthority;

  constructor(db: DatabaseInterface, authority: BookingAuthority) {
    this.#db = db;
    this.#authority = authority;
  }

  async configureOffering(
    context: BookingContext,
    key: string,
    input: { offeringId: string; kind: BookingKind; enabled: boolean },
  ): Promise<BookingReceipt> {
    const offeringId = id(input.offeringId);
    const { kind, enabled } = input;
    if (
      (kind !== 'developer-hour' && kind !== 'supervision-day') ||
      typeof enabled !== 'boolean'
    ) {
      throw new BookingError(
        'invalid',
        'Invalid offering kind or enabled flag',
      );
    }
    return this.#write(
      context,
      'configure-offering',
      key,
      { offeringId, kind, enabled },
      operator,
      async (tx, ctx) => {
        const saved = await tx.query(
          `INSERT INTO smrt_booking_offerings (tenant_id, id, kind, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, id) DO UPDATE SET enabled = EXCLUDED.enabled
         WHERE smrt_booking_offerings.kind = EXCLUDED.kind RETURNING id`,
          ctx.tenantId,
          offeringId,
          kind,
          enabled,
        );
        if (!saved.rows.length)
          throw new BookingError('conflict', 'An offering kind cannot change');
        return { id: offeringId };
      },
    );
  }

  async declareAvailability(
    context: BookingContext,
    key: string,
    input: AvailabilityInput,
  ): Promise<BookingReceipt> {
    const providerId = id(input.providerId);
    const windows = declareWindows(input.zone, input.windows);
    return this.#write(
      context,
      'declare-availability',
      key,
      { providerId, windows },
      operator,
      async (tx, ctx) => {
        await tx.query(
          `INSERT INTO smrt_booking_resources (tenant_id, id, windows) VALUES (?, ?, '[]')
         ON CONFLICT (tenant_id, id) DO NOTHING`,
          ctx.tenantId,
          providerId,
        );
        await this.#resource(tx, ctx, providerId, true);
        operator(await this.#access(ctx, 'declare-availability'));
        await this.#verify(ctx, { providerId });
        const allocated = await this.#allocations(tx, ctx, providerId);
        if (
          allocated.some(
            (item, i) =>
              (!item.exclusive && !supervisionDeclared(item.window, windows)) ||
              !fitsCapacity(
                item,
                windows,
                allocated.filter((_, j) => j !== i),
              ),
          )
        ) {
          throw new BookingError(
            'unavailable',
            'Availability change would undercut confirmed reservations',
          );
        }
        await tx.query(
          'UPDATE smrt_booking_resources SET windows = ? WHERE tenant_id = ? AND id = ?',
          JSON.stringify(windows),
          ctx.tenantId,
          providerId,
        );
        return { id: providerId };
      },
    );
  }

  async request(
    context: BookingContext,
    key: string,
    input: RequestBookingInput,
  ): Promise<BookingReceipt> {
    const offeringId = id(input.offeringId);
    const contactId = id(input.contactId);
    const projectId =
      input.projectId === undefined ? null : id(input.projectId);
    return this.#write(
      context,
      'request',
      key,
      { offeringId, contactId, projectId },
      (access) => {
        if (!access.operator) contact(access, contactId);
      },
      async (tx, ctx) => {
        const { rows } = await tx.query(
          'SELECT kind, enabled FROM smrt_booking_offerings WHERE tenant_id = ? AND id = ? FOR SHARE',
          ctx.tenantId,
          offeringId,
        );
        if (!rows[0]?.enabled)
          throw new BookingError('not-found', 'Offering is not available');
        const kind = rows[0].kind as BookingKind;
        if (kind === 'supervision-day' && !projectId) {
          throw new BookingError(
            'invalid',
            'A supervision request requires a project',
          );
        }
        await this.#verify(ctx, {
          contactId,
          projectId: projectId ?? undefined,
        });
        const bookingId = randomUUID();
        await tx.query(
          `INSERT INTO smrt_bookings (tenant_id, id, offering_id, contact_id, project_id, kind, status)
         VALUES (?, ?, ?, ?, ?, ?, 'requested')`,
          ctx.tenantId,
          bookingId,
          offeringId,
          contactId,
          projectId,
          kind,
        );
        return { id: bookingId };
      },
      { createsBooking: true },
    );
  }

  async propose(
    context: BookingContext,
    key: string,
    input: ProposeBookingInput,
  ): Promise<BookingReceipt> {
    const bookingId = id(input.bookingId);
    const providerId = id(input.providerId);
    const window = resolveBookingWindow(input.window);
    const terms = {
      revision: required(input.terms.revision),
      text: required(input.terms.text, 65_536),
    };
    const plan = input.approvedPlan;
    const approvedPlan =
      plan === undefined
        ? null
        : { id: id(plan.id), version: required(plan.version) };
    return this.#write(
      context,
      'propose',
      key,
      { bookingId, providerId, window, terms, approvedPlan },
      operator,
      async (tx, ctx) => {
        const row = await this.#booking(tx, ctx, bookingId, true);
        pending(row);
        if (
          row.kind === 'supervision-day'
            ? !approvedPlan
            : approvedPlan || !elapsedHour(window)
        ) {
          throw new BookingError(
            'invalid',
            'Supervision requires a plan version; dedicated time requires one elapsed hour',
          );
        }
        await this.#verify(ctx, {
          ...this.#refs(row),
          providerId,
          approvedPlan: approvedPlan ?? undefined,
        });
        declared(
          row.kind,
          window,
          await this.#resource(tx, ctx, providerId, false),
        );
        const proposalId = randomUUID();
        await tx.query(
          `INSERT INTO smrt_booking_proposals (tenant_id, booking_id, id, provider_id, coverage, terms, approved_plan)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ctx.tenantId,
          bookingId,
          proposalId,
          providerId,
          JSON.stringify(window),
          JSON.stringify(terms),
          approvedPlan && JSON.stringify(approvedPlan),
        );
        await tx.query(
          `UPDATE smrt_bookings SET status = 'proposed', proposal_id = ?, assented_proposal_id = NULL
         WHERE tenant_id = ? AND id = ?`,
          proposalId,
          ctx.tenantId,
          bookingId,
        );
        return { id: bookingId, proposalId };
      },
      { bookingId },
    );
  }

  async assent(
    context: BookingContext,
    key: string,
    input: { bookingId: string; proposalId: string },
  ): Promise<BookingReceipt> {
    const bookingId = id(input.bookingId);
    const proposalId = id(input.proposalId);
    return this.#write(
      context,
      'assent',
      key,
      { bookingId, proposalId },
      async (access, tx, ctx) => {
        // Check contact ownership before exposing the existence of a replay.
        const row = await this.#booking(tx, ctx, bookingId, false);
        visible(access, row);
        contact(access, row.contact_id);
      },
      async (tx, ctx) => {
        const row = await this.#booking(tx, ctx, bookingId, true);
        contact(await this.#access(ctx, 'assent'), row.contact_id);
        this.#current(row, proposalId);
        if (row.assented_proposal_id)
          throw new BookingError(
            'conflict',
            'Customer assent is already recorded',
          );
        await this.#verify(ctx, this.#refs(row));
        await tx.query(
          'UPDATE smrt_bookings SET assented_proposal_id = ? WHERE tenant_id = ? AND id = ?',
          proposalId,
          ctx.tenantId,
          bookingId,
        );
        return { id: bookingId, proposalId };
      },
      { bookingId },
    );
  }

  async confirm(
    context: BookingContext,
    key: string,
    input: { bookingId: string; proposalId: string },
  ): Promise<BookingReceipt> {
    const bookingId = id(input.bookingId);
    const proposalId = id(input.proposalId);
    return this.#write(
      context,
      'confirm',
      key,
      { bookingId, proposalId },
      operator,
      async (tx, ctx) => {
        const row = await this.#booking(tx, ctx, bookingId, true);
        this.#current(row, proposalId);
        if (row.assented_proposal_id !== proposalId) {
          throw new BookingError(
            'conflict',
            'Exact proposal does not have customer assent',
          );
        }
        const proposal = await this.#proposal(tx, ctx, row, proposalId);
        const availability = await this.#resource(
          tx,
          ctx,
          proposal.providerId,
          true,
        );
        // Refresh after waiting for contested capacity; this does not lock external authorities.
        operator(await this.#access(ctx, 'confirm'));
        await this.#verify(ctx, {
          ...this.#refs(row),
          providerId: proposal.providerId,
          approvedPlan: proposal.approvedPlan ?? undefined,
        });
        const exclusive = row.kind === 'developer-hour';
        const window = proposal.window;
        declared(row.kind, window, availability);
        if (
          !fitsCapacity(
            { ...window, exclusive },
            availability,
            await this.#allocations(tx, ctx, proposal.providerId, window),
          )
        ) {
          throw new BookingError(
            'unavailable',
            'The proposed window has insufficient capacity',
          );
        }
        const inserted = await tx.query(
          `INSERT INTO smrt_booking_allocations
           (tenant_id, booking_id, proposal_id, provider_id, project_id, exclusive, start_at, end_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, project_id, start_at, end_at)
           WHERE released_at IS NULL AND project_id IS NOT NULL DO NOTHING RETURNING booking_id`,
          ctx.tenantId,
          bookingId,
          proposalId,
          proposal.providerId,
          exclusive ? null : row.project_id,
          exclusive,
          window.startUtc,
          window.endUtc,
        );
        if (!inserted.rows.length) {
          throw new BookingError(
            'duplicate-project-window',
            'Project already has a reservation for this window',
          );
        }
        await tx.query(
          `UPDATE smrt_bookings SET status = 'confirmed', confirmed_proposal_id = ?
         WHERE tenant_id = ? AND id = ?`,
          proposalId,
          ctx.tenantId,
          bookingId,
        );
        return { id: bookingId, proposalId };
      },
      { bookingId },
    );
  }

  decline(
    context: BookingContext,
    key: string,
    input: { bookingId: string; reason: string },
  ): Promise<BookingReceipt> {
    return this.#close(context, 'decline', key, input);
  }

  cancel(
    context: BookingContext,
    key: string,
    input: { bookingId: string; reason: string },
  ): Promise<BookingReceipt> {
    return this.#close(context, 'cancel', key, input);
  }

  async get(context: BookingContext, bookingId: string): Promise<BookingView> {
    const ctx = identity(context);
    const access = await this.#access(ctx, 'read');
    const row = await this.#booking(this.#db, ctx, id(bookingId), false);
    visible(access, row);
    return bookingView(
      row,
      row.proposal_id
        ? await this.#proposal(this.#db, ctx, row, row.proposal_id)
        : null,
    );
  }

  /** Lists the tenant's bookings, restricted to the current contact for nonoperators. */
  async listBookings(
    context: BookingContext,
    options: ListBookingsOptions = {},
  ): Promise<BookingPage<BookingView>> {
    const ctx = identity(context);
    const access = await this.#discover(ctx);
    const { after, limit } = pageBounds(options);
    const projectId =
      options.projectId === undefined ? null : id(options.projectId);
    const result = await this.#db.query(
      `SELECT b.id, b.offering_id, b.contact_id, b.project_id, b.kind, b.status,
              b.proposal_id, b.assented_proposal_id, b.confirmed_proposal_id,
              p.provider_id, p.coverage::text, p.terms::text, p.approved_plan::text
       FROM smrt_bookings b
       LEFT JOIN smrt_booking_proposals p
         ON p.tenant_id = b.tenant_id AND p.booking_id = b.id AND p.id = b.proposal_id
       WHERE b.tenant_id = ? AND (?::boolean OR b.contact_id = ?)
         AND (?::uuid IS NULL OR b.project_id = ?)
         AND (?::uuid IS NULL OR b.id > ?)
       ORDER BY b.id LIMIT ?`,
      ctx.tenantId,
      access.operator,
      access.contactId ?? null,
      projectId,
      projectId,
      after,
      after,
      limit + 1,
    );
    const rows = result.rows as Array<BookingRow & ProposalRow>;
    const selected = page(rows, limit, (row) => row.id);
    return {
      items: selected.items.map((row) =>
        bookingView(
          row,
          row.proposal_id ? proposalView(row.proposal_id, row) : null,
        ),
      ),
      nextCursor: selected.nextCursor,
    };
  }

  /** Lists configured offerings. Contacts only see enabled offerings. */
  async listOfferings(
    context: BookingContext,
    options: BookingPageOptions = {},
  ): Promise<BookingPage<BookingOffering>> {
    const ctx = identity(context);
    const access = await this.#discover(ctx);
    const { after, limit } = pageBounds(options);
    const { rows } = await this.#db.query(
      `SELECT id, kind, enabled FROM smrt_booking_offerings
       WHERE tenant_id = ? AND (?::boolean OR enabled)
         AND (?::uuid IS NULL OR id > ?)
       ORDER BY id LIMIT ?`,
      ctx.tenantId,
      access.operator,
      after,
      after,
      limit + 1,
    );
    return page(rows as BookingOffering[], limit, (row) => row.id);
  }

  /** Lists provider schedules so operators can inspect or replace existing windows. */
  async listAvailability(
    context: BookingContext,
    options: BookingPageOptions = {},
  ): Promise<BookingPage<ProviderAvailability>> {
    const ctx = identity(context);
    operator(await this.#access(ctx, 'read'));
    const { after, limit } = pageBounds(options);
    const { rows } = await this.#db.query(
      `SELECT id, windows::text FROM smrt_booking_resources
       WHERE tenant_id = ? AND (?::uuid IS NULL OR id > ?)
       ORDER BY id LIMIT ?`,
      ctx.tenantId,
      after,
      after,
      limit + 1,
    );
    const selected = page(
      rows as Array<{ id: string; windows: string }>,
      limit,
      (row) => row.id,
    );
    return {
      items: selected.items.map((row) => ({
        providerId: row.id,
        windows: JSON.parse(row.windows),
      })),
      nextCursor: selected.nextCursor,
    };
  }

  async getProposal(
    context: BookingContext,
    bookingId: string,
    proposalId: string,
  ): Promise<BookingProposal> {
    const ctx = identity(context);
    const access = await this.#access(ctx, 'read');
    const row = await this.#booking(this.#db, ctx, id(bookingId), false);
    visible(access, row);
    return this.#proposal(this.#db, ctx, row, id(proposalId));
  }

  async history(
    context: BookingContext,
    bookingId: string,
  ): Promise<BookingHistoryEvent[]> {
    const ctx = identity(context);
    operator(await this.#access(ctx, 'history'));
    await this.#booking(this.#db, ctx, id(bookingId), false);
    const { rows } = await this.#db.query(
      `SELECT operation, actor_id, result->>'proposalId' AS proposal_id, reason, at
       FROM smrt_booking_commands WHERE tenant_id = ? AND booking_id = ? ORDER BY at, sequence`,
      ctx.tenantId,
      id(bookingId),
    );
    return rows.map((row) => ({
      operation: row.operation as BookingOperation,
      actorId: row.actor_id,
      proposalId: row.proposal_id,
      reason: row.reason,
      at: new Date(row.at).toISOString(),
    }));
  }

  async #close(
    context: BookingContext,
    operation: 'decline' | 'cancel',
    key: string,
    input: { bookingId: string; reason: string },
  ): Promise<BookingReceipt> {
    const bookingId = id(input.bookingId);
    const reason = required(input.reason, 2_048);
    return this.#write(
      context,
      operation,
      key,
      { bookingId, reason },
      operator,
      async (tx, ctx) => {
        const row = await this.#booking(tx, ctx, bookingId, true);
        if (
          operation === 'cancel' &&
          row.confirmed_proposal_id &&
          row.status === 'confirmed'
        ) {
          const proposal = await this.#proposal(
            tx,
            ctx,
            row,
            row.confirmed_proposal_id,
          );
          await this.#resource(tx, ctx, proposal.providerId, true);
          operator(await this.#access(ctx, 'cancel'));
          const released = await tx.query(
            `UPDATE smrt_booking_allocations SET released_at = clock_timestamp()
           WHERE tenant_id = ? AND booking_id = ? AND released_at IS NULL RETURNING booking_id`,
            ctx.tenantId,
            bookingId,
          );
          if (!released.rows.length)
            throw new BookingError(
              'conflict',
              'Confirmed booking has no active allocation',
            );
        } else {
          pending(row);
        }
        await tx.query(
          'UPDATE smrt_bookings SET status = ? WHERE tenant_id = ? AND id = ?',
          operation === 'cancel' ? 'cancelled' : 'declined',
          ctx.tenantId,
          bookingId,
        );
        return {
          id: bookingId,
          ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
        };
      },
      { bookingId, reason },
    );
  }

  async #access(
    context: Readonly<BookingContext>,
    operation: BookingOperation,
  ): Promise<BookingAccess> {
    const access = await this.#authority.access(context, operation);
    if (!access) throw new BookingError('forbidden', 'Booking access denied');
    return {
      operator: access.operator === true,
      contactId:
        access.contactId === undefined ? undefined : id(access.contactId),
    };
  }

  async #discover(ctx: Readonly<BookingContext>): Promise<BookingAccess> {
    const access = await this.#access(ctx, 'read');
    if (!access.operator && !access.contactId) {
      throw new BookingError(
        'forbidden',
        'A named customer contact is required',
      );
    }
    return access;
  }

  async #verify(
    ctx: Readonly<BookingContext>,
    refs: BookingReferences,
  ): Promise<void> {
    // Use a detached copy so a host callback cannot change the version being verified and saved.
    if (
      (await this.#authority.verifyReferences(ctx, structuredClone(refs))) !==
      true
    ) {
      throw new BookingError(
        'forbidden',
        'Booking references or approval could not be verified',
      );
    }
  }

  #refs(row: BookingRow): BookingReferences {
    return {
      contactId: row.contact_id,
      projectId: row.project_id ?? undefined,
    };
  }

  async #booking(
    tx: DatabaseInterface,
    ctx: Readonly<BookingContext>,
    bookingId: string,
    lock: boolean,
  ): Promise<BookingRow> {
    const { rows } = await tx.query(
      `SELECT * FROM smrt_bookings WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`,
      ctx.tenantId,
      bookingId,
    );
    if (!rows[0]) throw new BookingError('not-found', 'Booking does not exist');
    return rows[0] as BookingRow;
  }

  #current(row: BookingRow, proposalId: string): void {
    if (row.status !== 'proposed' || row.proposal_id !== proposalId) {
      throw new BookingError(
        'conflict',
        'Booking does not have this current proposal',
      );
    }
  }

  async #proposal(
    tx: DatabaseInterface,
    ctx: Readonly<BookingContext>,
    booking: BookingRow,
    proposalId: string,
  ): Promise<BookingProposal> {
    const { rows } = await tx.query(
      `SELECT provider_id, coverage::text, terms::text, approved_plan::text FROM smrt_booking_proposals
       WHERE tenant_id = ? AND booking_id = ? AND id = ?`,
      ctx.tenantId,
      booking.id,
      proposalId,
    );
    const row = rows[0];
    if (!row) throw new BookingError('not-found', 'Proposal does not exist');
    return proposalView(proposalId, row as ProposalRow);
  }

  async #resource(
    tx: DatabaseInterface,
    ctx: Readonly<BookingContext>,
    providerId: string,
    lock: boolean,
  ): Promise<DeclaredAvailabilityWindow[]> {
    const { rows } = await tx.query(
      `SELECT windows::text FROM smrt_booking_resources WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`,
      ctx.tenantId,
      providerId,
    );
    if (!rows[0])
      throw new BookingError(
        'not-found',
        'Provider availability is not configured',
      );
    return JSON.parse(rows[0].windows);
  }

  async #allocations(
    tx: DatabaseInterface,
    ctx: Readonly<BookingContext>,
    providerId: string,
    window?: ResolvedBookingWindow,
  ): Promise<Allocation[]> {
    const { rows } = await tx.query(
      `SELECT a.exclusive, p.coverage::text FROM smrt_booking_allocations a
       JOIN smrt_booking_proposals p ON p.tenant_id = a.tenant_id AND p.booking_id = a.booking_id AND p.id = a.proposal_id
       WHERE a.tenant_id = ? AND a.provider_id = ? AND a.released_at IS NULL${window ? ' AND a.start_at < ? AND a.end_at > ?' : ''}`,
      ctx.tenantId,
      providerId,
      ...(window ? [window.endUtc, window.startUtc] : []),
    );
    return rows.map((row) => {
      const snapshot = JSON.parse(row.coverage) as ResolvedBookingWindow;
      return { ...snapshot, window: snapshot, exclusive: row.exclusive };
    });
  }

  async #write(
    context: BookingContext,
    operation: WriteOperation,
    key: string,
    canonical: object,
    permit: (
      access: BookingAccess,
      tx: DatabaseInterface,
      ctx: Readonly<BookingContext>,
    ) => void | Promise<void>,
    work: (
      tx: DatabaseInterface,
      ctx: Readonly<BookingContext>,
    ) => Promise<BookingReceipt>,
    options: {
      bookingId?: string;
      reason?: string;
      createsBooking?: boolean;
    } = {},
  ): Promise<BookingReceipt> {
    const ctx = identity(context);
    const keyHash = digest(required(key));
    const payloadHash = digest(JSON.stringify(canonical));
    if (!this.#db.transaction)
      throw new TypeError('Bookings requires a PostgreSQL transaction');
    return this.#db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await permit(await this.#access(ctx, operation), tx, ctx);
      const inserted = await tx.query(
        `INSERT INTO smrt_booking_commands (tenant_id, operation, key_hash, actor_id, payload_hash)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, operation, key_hash) DO NOTHING RETURNING key_hash`,
        ctx.tenantId,
        operation,
        keyHash,
        ctx.actorId,
        payloadHash,
      );
      if (!inserted.rows.length) {
        await permit(await this.#access(ctx, operation), tx, ctx);
        const { rows } = await tx.query(
          `SELECT actor_id, payload_hash, result::text FROM smrt_booking_commands
           WHERE tenant_id = ? AND operation = ? AND key_hash = ?`,
          ctx.tenantId,
          operation,
          keyHash,
        );
        const prior = rows[0];
        if (
          !prior ||
          prior.actor_id !== ctx.actorId ||
          prior.payload_hash !== payloadHash ||
          !prior.result
        ) {
          throw new BookingError(
            'conflict',
            'Idempotency key is bound to a different command',
          );
        }
        return JSON.parse(prior.result) as BookingReceipt;
      }
      const result = await work(tx, ctx);
      await tx.query(
        `UPDATE smrt_booking_commands SET booking_id = ?, result = ?, reason = ?, at = clock_timestamp()
         WHERE tenant_id = ? AND operation = ? AND key_hash = ?`,
        options.bookingId ?? (options.createsBooking ? result.id : null),
        JSON.stringify(result),
        options.reason ?? null,
        ctx.tenantId,
        operation,
        keyHash,
      );
      return result;
    });
  }
}
