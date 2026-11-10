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
  BookingUnit,
  BookingView,
  BookingWindow,
  ConfigureOfferingInput,
  DeclaredAvailabilityWindow,
  ListBookingsOptions,
  ListOpenSlotsOptions,
  OpenSlot,
  ProposeBookingInput,
  ProviderAvailability,
  RequestBookingInput,
  ResolvedBookingWindow,
} from './types.js';
import {
  declareWindows,
  fitsCapacity,
  localEnd,
  MAX_SEGMENTS,
  measures,
  type Reservation,
  remainingCapacity,
  resolveCoverage,
  supervisionDeclared,
  windowFromInstants,
} from './windows.js';

type WriteOperation = Exclude<BookingOperation, 'read' | 'history'>;

interface BookingRow {
  id: string;
  offering_id: string;
  contact_id: string;
  project_id: string | null;
  kind: BookingKind;
  unit: BookingUnit;
  quantity: number;
  status: BookingStatus;
  proposal_id: string | null;
  assented_proposal_id: string | null;
  confirmed_proposal_id: string | null;
}

interface ProposalRow {
  provider_id: string;
  coverage: string;
  windows: string;
  proposal_unit: BookingUnit;
  proposal_quantity: number;
  unit_price_cents: string | number | null;
  currency: string | null;
  total_cents: string | number | null;
  terms: string;
  approved_plan: string | null;
}

interface Allocation extends Reservation {
  window: ResolvedBookingWindow;
  providerId: string;
}

const CURRENCY = /^[A-Z]{3}$/;
const UNITS: readonly BookingUnit[] = ['hour', 'day', 'week', 'month'];
const MAX_QUANTITY = 1000;
const MAX_SLOT_RANGE_MS = 400 * 86_400_000;
const HOUR_MS = 3_600_000;
const SLOT_CURSOR =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function project(window: ResolvedBookingWindow): ResolvedBookingWindow {
  const { zone, start, end, startUtc, endUtc } = window;
  return { zone, start, end, startUtc, endUtc };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BookingError('invalid', 'Expected a UUID reference');
  }
  return value.toLowerCase();
}

function quantityOf(value: number | undefined, fallback = 1): number {
  const quantity = value === undefined ? fallback : value;
  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_QUANTITY
  ) {
    throw new BookingError(
      'invalid',
      `Quantity must be an integer between 1 and ${MAX_QUANTITY}`,
    );
  }
  return quantity;
}

/** Convert a bigint money column to a JavaScript-safe integer. */
function money(value: string | number | bigint | null): number | null {
  if (value === null) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new BookingError('invalid', 'Amount is not a safe integer');
  }
  return amount;
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
    unit: row.unit,
    quantity: row.quantity,
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
    windows: JSON.parse(row.windows),
    unit: row.proposal_unit,
    quantity: row.proposal_quantity,
    unitPriceCents: money(row.unit_price_cents),
    currency: row.currency,
    totalCents: money(row.total_cents),
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
    input: ConfigureOfferingInput,
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
    const unit =
      input.unit ?? (kind === 'supervision-day' ? 'day' : ('hour' as const));
    if (
      !UNITS.includes(unit) ||
      (kind === 'supervision-day' && unit !== 'day')
    ) {
      throw new BookingError(
        'invalid',
        'Invalid offering unit; supervision is sold by the day',
      );
    }
    const priceCents = input.priceCents ?? null;
    const currency = input.currency ?? null;
    if (
      (priceCents !== null &&
        (!Number.isSafeInteger(priceCents) || priceCents < 0)) ||
      (currency !== null &&
        (typeof currency !== 'string' || !CURRENCY.test(currency))) ||
      (priceCents === null) !== (currency === null)
    ) {
      throw new BookingError(
        'invalid',
        'A price needs a nonnegative integer amount in minor units and an uppercase ISO 4217 currency',
      );
    }
    const title = input.title ?? '';
    const description = input.description ?? '';
    const isPublic = input.public ?? false;
    if (
      typeof title !== 'string' ||
      typeof description !== 'string' ||
      title.length > 120 ||
      description.length > 2000 ||
      title.includes('\0') ||
      description.includes('\0') ||
      typeof isPublic !== 'boolean'
    ) {
      throw new BookingError(
        'invalid',
        'Offering title (120), description (2000) and public flag are invalid',
      );
    }
    return this.#write(
      context,
      'configure-offering',
      key,
      // Fields at their defaults are omitted so a v1 retry key still replays its receipt.
      {
        offeringId,
        kind,
        enabled,
        ...(unit !== (kind === 'supervision-day' ? 'day' : 'hour')
          ? { unit }
          : {}),
        ...(priceCents !== null ? { priceCents, currency } : {}),
        ...(title !== '' ? { title } : {}),
        ...(description !== '' ? { description } : {}),
        ...(isPublic ? { public: true } : {}),
      },
      operator,
      async (tx, ctx) => {
        const saved = await tx.query(
          `INSERT INTO smrt_booking_offerings (tenant_id, id, kind, unit, price_cents, currency, title, description, public, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, id) DO UPDATE
           SET enabled = EXCLUDED.enabled, price_cents = EXCLUDED.price_cents, currency = EXCLUDED.currency,
               title = EXCLUDED.title, description = EXCLUDED.description, public = EXCLUDED.public
         WHERE smrt_booking_offerings.kind = EXCLUDED.kind AND smrt_booking_offerings.unit = EXCLUDED.unit
         RETURNING id`,
          ctx.tenantId,
          offeringId,
          kind,
          unit,
          priceCents,
          currency,
          title,
          description,
          isPublic,
          enabled,
        );
        if (!saved.rows.length)
          throw new BookingError(
            'conflict',
            'An offering kind or unit cannot change',
          );
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
    const quantity = quantityOf(input.quantity);
    return this.#write(
      context,
      'request',
      key,
      {
        offeringId,
        contactId,
        projectId,
        ...(quantity !== 1 ? { quantity } : {}),
      },
      (access) => {
        if (!access.operator) contact(access, contactId);
      },
      async (tx, ctx) => {
        const { rows } = await tx.query(
          'SELECT kind, unit, enabled FROM smrt_booking_offerings WHERE tenant_id = ? AND id = ? FOR SHARE',
          ctx.tenantId,
          offeringId,
        );
        if (!rows[0]?.enabled)
          throw new BookingError('not-found', 'Offering is not available');
        const kind = rows[0].kind as BookingKind;
        const unit = rows[0].unit as BookingUnit;
        if (kind === 'supervision-day' && (!projectId || quantity !== 1)) {
          throw new BookingError(
            'invalid',
            'A supervision request requires a project and a quantity of one',
          );
        }
        await this.#verify(ctx, {
          contactId,
          projectId: projectId ?? undefined,
        });
        const bookingId = randomUUID();
        await tx.query(
          `INSERT INTO smrt_bookings (tenant_id, id, offering_id, contact_id, project_id, kind, unit, quantity, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested')`,
          ctx.tenantId,
          bookingId,
          offeringId,
          contactId,
          projectId,
          kind,
          unit,
          quantity,
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
    if ((input.window === undefined) === (input.windows === undefined)) {
      throw new BookingError(
        'invalid',
        'Provide exactly one of window or windows',
      );
    }
    const { windows, span } = resolveCoverage(
      input.windows ?? [input.window as BookingWindow],
    );
    const requestedQuantity =
      input.quantity === undefined ? null : quantityOf(input.quantity);
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
      // The v1 single-window shape (and hash) is kept for a single segment at the default quantity.
      {
        bookingId,
        providerId,
        ...(windows.length === 1 ? { window: windows[0] } : { windows }),
        ...(requestedQuantity !== null ? { quantity: requestedQuantity } : {}),
        terms,
        approvedPlan,
      },
      operator,
      async (tx, ctx) => {
        const row = await this.#booking(tx, ctx, bookingId, true);
        pending(row);
        const quantity = requestedQuantity ?? row.quantity;
        if (row.kind === 'supervision-day') {
          if (!approvedPlan || quantity !== 1 || windows.length !== 1) {
            throw new BookingError(
              'invalid',
              'Supervision requires a plan version, one window and a quantity of one',
            );
          }
        } else {
          if (approvedPlan) {
            throw new BookingError(
              'invalid',
              'Dedicated time does not take an approved plan',
            );
          }
          if (!measures(row.unit, quantity, windows)) {
            throw new BookingError(
              'invalid',
              'Proposed windows do not measure the requested quantity',
            );
          }
        }
        await this.#verify(ctx, {
          ...this.#refs(row),
          providerId,
          approvedPlan: approvedPlan ?? undefined,
        });
        const availability = await this.#resource(tx, ctx, providerId, false);
        for (const window of windows) declared(row.kind, window, availability);
        const offering = await tx.query(
          `SELECT price_cents, currency FROM smrt_booking_offerings
           WHERE tenant_id = ? AND id = ? FOR SHARE`,
          ctx.tenantId,
          row.offering_id,
        );
        const unitPriceCents = money(offering.rows[0]?.price_cents ?? null);
        const currency: string | null = offering.rows[0]?.currency ?? null;
        const totalCents =
          unitPriceCents === null ? null : unitPriceCents * quantity;
        if (totalCents !== null && !Number.isSafeInteger(totalCents)) {
          throw new BookingError('invalid', 'Total price is too large');
        }
        const proposalId = randomUUID();
        await tx.query(
          `INSERT INTO smrt_booking_proposals
             (tenant_id, booking_id, id, provider_id, coverage, windows, unit, quantity,
              unit_price_cents, currency, total_cents, terms, approved_plan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ctx.tenantId,
          bookingId,
          proposalId,
          providerId,
          JSON.stringify(span),
          JSON.stringify(windows),
          row.unit,
          quantity,
          unitPriceCents,
          currency,
          totalCents,
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
        const occupied = await this.#allocations(
          tx,
          ctx,
          proposal.providerId,
          window,
        );
        for (const segment of proposal.windows) {
          declared(row.kind, segment, availability);
          if (
            !fitsCapacity({ ...segment, exclusive }, availability, occupied)
          ) {
            throw new BookingError(
              'unavailable',
              'The proposed window has insufficient capacity',
            );
          }
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

  /** Operator command: bind a lead-bound booking to a project once one exists. */
  async attachProject(
    context: BookingContext,
    key: string,
    input: { bookingId: string; projectId: string },
  ): Promise<BookingReceipt> {
    const bookingId = id(input.bookingId);
    const projectId = id(input.projectId);
    return this.#write(
      context,
      'attach-project',
      key,
      { bookingId, projectId },
      operator,
      async (tx, ctx) => {
        const row = await this.#booking(tx, ctx, bookingId, true);
        if (row.status === 'declined' || row.status === 'cancelled') {
          throw new BookingError('conflict', 'Booking is no longer active');
        }
        if (row.project_id === projectId) return { id: bookingId };
        if (row.project_id !== null) {
          throw new BookingError(
            'conflict',
            'Booking is already bound to a different project',
          );
        }
        await this.#verify(ctx, { contactId: row.contact_id, projectId });
        await tx.query(
          'UPDATE smrt_bookings SET project_id = ? WHERE tenant_id = ? AND id = ?',
          projectId,
          ctx.tenantId,
          bookingId,
        );
        return { id: bookingId };
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
    const contactId =
      options.contactId === undefined ? null : id(options.contactId);
    if (!access.operator && contactId && contactId !== access.contactId) {
      throw new BookingError(
        'forbidden',
        'Only the named customer contact may be listed',
      );
    }
    const result = await this.#db.query(
      `SELECT b.id, b.offering_id, b.contact_id, b.project_id, b.kind, b.unit, b.quantity, b.status,
              b.proposal_id, b.assented_proposal_id, b.confirmed_proposal_id,
              p.provider_id, p.coverage::text, p.windows::text, p.unit AS proposal_unit,
              p.quantity AS proposal_quantity, p.unit_price_cents, p.currency, p.total_cents,
              p.terms::text, p.approved_plan::text
       FROM smrt_bookings b
       LEFT JOIN smrt_booking_proposals p
         ON p.tenant_id = b.tenant_id AND p.booking_id = b.id AND p.id = b.proposal_id
       WHERE b.tenant_id = ? AND (?::boolean OR b.contact_id = ?)
         AND (?::uuid IS NULL OR b.project_id = ?)
         AND (?::uuid IS NULL OR b.contact_id = ?)
         AND (?::uuid IS NULL OR b.id > ?)
       ORDER BY b.id LIMIT ?`,
      ctx.tenantId,
      access.operator,
      access.contactId ?? null,
      projectId,
      projectId,
      contactId,
      contactId,
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

  /**
   * Lists configured offerings. Operators see all, contacts see enabled
   * offerings, and a reader with no contact mapping sees enabled public ones.
   */
  async listOfferings(
    context: BookingContext,
    options: BookingPageOptions = {},
  ): Promise<BookingPage<BookingOffering>> {
    const ctx = identity(context);
    const access = await this.#access(ctx, 'read');
    const { after, limit } = pageBounds(options);
    const { rows } = await this.#db.query(
      `SELECT id, kind, unit, price_cents, currency, title, description, public, enabled
       FROM smrt_booking_offerings
       WHERE tenant_id = ? AND (?::boolean OR (enabled AND (?::boolean OR public)))
         AND (?::uuid IS NULL OR id > ?)
       ORDER BY id LIMIT ?`,
      ctx.tenantId,
      access.operator,
      access.operator || access.contactId !== undefined,
      after,
      after,
      limit + 1,
    );
    const offerings: BookingOffering[] = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      unit: row.unit,
      priceCents: money(row.price_cents),
      currency: row.currency,
      title: row.title,
      description: row.description,
      public: row.public,
      enabled: row.enabled,
    }));
    return page(offerings, limit, (row) => row.id);
  }

  /**
   * Lists candidate open slots for an offering: a pure read that reserves nothing
   * and takes no retry key. Confirmation re-checks capacity under the provider lock.
   * Offerings are discoverable by operators (all), contact-mapped readers (enabled)
   * and contact-less readers (enabled and public); the host decides who may read.
   */
  async listOpenSlots(
    context: BookingContext,
    options: ListOpenSlotsOptions,
  ): Promise<BookingPage<OpenSlot>> {
    const ctx = identity(context);
    const access = await this.#access(ctx, 'read');
    const offeringId = id(options.offeringId);
    const fromMs = Date.parse(options.from);
    const toMs = Date.parse(options.to);
    if (
      !Number.isFinite(fromMs) ||
      !Number.isFinite(toMs) ||
      toMs <= fromMs ||
      toMs - fromMs > MAX_SLOT_RANGE_MS
    ) {
      throw new BookingError(
        'invalid',
        'Expected from before to, at most 400 days apart',
      );
    }
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    const quantity = quantityOf(options.quantity);
    const providerId =
      options.providerId === undefined ? null : id(options.providerId);
    const { limit } = pageBounds({ limit: options.limit });
    if (options.after !== undefined && !SLOT_CURSOR.test(options.after)) {
      throw new BookingError('invalid', 'Invalid slot cursor');
    }
    const after = options.after?.replace(/\|.*$/, (provider) =>
      provider.toLowerCase(),
    );
    const found = await this.#db.query(
      'SELECT kind, unit, enabled, public FROM smrt_booking_offerings WHERE tenant_id = ? AND id = ?',
      ctx.tenantId,
      offeringId,
    );
    const offering = found.rows[0];
    const discoverable =
      offering &&
      (access.operator ||
        (offering.enabled &&
          (access.contactId !== undefined || offering.public)));
    if (!discoverable) {
      throw new BookingError('not-found', 'Offering is not available');
    }
    const kind = offering.kind as BookingKind;
    const unit = offering.unit as BookingUnit;
    if (kind === 'supervision-day' && quantity !== 1) {
      throw new BookingError(
        'invalid',
        'Supervision slots have a quantity of one',
      );
    }
    const resources = await this.#db.query(
      `SELECT id, windows::text FROM smrt_booking_resources
       WHERE tenant_id = ? AND (?::uuid IS NULL OR id = ?)`,
      ctx.tenantId,
      providerId,
      providerId,
    );
    const occupied = await this.#allocations(this.#db, ctx, providerId, {
      startUtc: from,
      endUtc: to,
    });
    const slots: OpenSlot[] = [];
    for (const resource of resources.rows) {
      const declaredWindows = (
        JSON.parse(resource.windows) as DeclaredAvailabilityWindow[]
      ).sort((a, b) => a.startUtc.localeCompare(b.startUtc));
      const taken = occupied.filter((item) => item.providerId === resource.id);
      const inRange = (w: ResolvedBookingWindow) =>
        w.startUtc >= from && w.endUtc <= to;
      const push = (windows: ResolvedBookingWindow[], remaining: number) => {
        if (remaining >= 1) {
          slots.push({
            providerId: resource.id,
            offeringId,
            unit,
            quantity,
            windows,
            remainingCapacity: remaining,
          });
        }
      };
      if (kind === 'supervision-day') {
        for (const w of declaredWindows) {
          if (w.supervision && inRange(w)) {
            push(
              [project(w)],
              remainingCapacity(
                { ...w, exclusive: false },
                declaredWindows,
                taken,
              ),
            );
          }
        }
      } else if (unit === 'hour') {
        const length = quantity * HOUR_MS;
        for (const w of declaredWindows) {
          const start = Date.parse(w.startUtc);
          const end = Date.parse(w.endUtc);
          if (w.endUtc <= from || w.startUtc >= to) continue;
          const first = Math.max(0, Math.ceil((fromMs - start) / HOUR_MS));
          for (let k = first; start + k * HOUR_MS + length <= end; k++) {
            const candidate = windowFromInstants(
              w.zone,
              start + k * HOUR_MS,
              start + k * HOUR_MS + length,
            );
            if (candidate.startUtc >= to) break;
            if (!inRange(candidate)) continue;
            push(
              [candidate],
              remainingCapacity(
                { ...candidate, exclusive: true },
                declaredWindows,
                taken,
              ),
            );
          }
        }
      } else {
        const starts = [
          ...new Set(declaredWindows.map((w) => w.start.slice(0, 10))),
        ];
        for (const d0 of starts) {
          const d1 = localEnd(unit, quantity, d0);
          const bundle = declaredWindows.filter(
            (w) =>
              w.start.slice(0, 10) >= d0 &&
              w.start.slice(0, 10) < d1 &&
              (w.end.slice(0, 10) < d1 || w.end.slice(0, 16) === `${d1}T00:00`),
          );
          const segments = bundle.map(project);
          if (
            segments.length === 0 ||
            segments.length > MAX_SEGMENTS ||
            segments[0].start.slice(0, 10) !== d0 ||
            !segments.every(inRange) ||
            !measures(unit, quantity, segments) ||
            !bundle.every(
              (w) =>
                remainingCapacity(
                  { ...w, exclusive: true },
                  declaredWindows,
                  taken,
                ) >= 1,
            )
          ) {
            continue;
          }
          push(segments, 1);
        }
      }
    }
    const key = (slot: OpenSlot) =>
      `${slot.windows[0].startUtc}|${slot.providerId}`;
    const seen = new Set<string>();
    const ordered = slots
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      .filter((slot) => !seen.has(key(slot)) && seen.add(key(slot)))
      .filter((slot) => after === undefined || key(slot) > after);
    return page(ordered.slice(0, limit + 1), limit, key);
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
    if (
      refs.projectId === undefined &&
      refs.contactId !== undefined &&
      this.#authority.verifyContact
    ) {
      // A lead-bound booking has no project: the host vouches for the contact alone.
      if ((await this.#authority.verifyContact(ctx, refs.contactId)) !== true) {
        throw new BookingError(
          'forbidden',
          'Booking references or approval could not be verified',
        );
      }
      const { contactId: _contact, ...others } = refs;
      const rest = Object.fromEntries(
        Object.entries(others).filter(([, value]) => value !== undefined),
      ) as BookingReferences;
      if (Object.keys(rest).length === 0) return;
      refs = rest;
    }
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
      `SELECT provider_id, coverage::text, windows::text, unit AS proposal_unit, quantity AS proposal_quantity,
              unit_price_cents, currency, total_cents, terms::text, approved_plan::text FROM smrt_booking_proposals
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
    providerId: string | null,
    window?: Pick<ResolvedBookingWindow, 'startUtc' | 'endUtc'>,
  ): Promise<Allocation[]> {
    const { rows } = await tx.query(
      `SELECT a.provider_id, a.exclusive, p.windows::text FROM smrt_booking_allocations a
       JOIN smrt_booking_proposals p ON p.tenant_id = a.tenant_id AND p.booking_id = a.booking_id AND p.id = a.proposal_id
       WHERE a.tenant_id = ? AND (?::uuid IS NULL OR a.provider_id = ?) AND a.released_at IS NULL${window ? ' AND a.start_at < ? AND a.end_at > ?' : ''}`,
      ctx.tenantId,
      providerId,
      providerId,
      ...(window ? [window.endUtc, window.startUtc] : []),
    );
    // One allocation row spans its proposal; its reserved segments are what block capacity.
    return rows.flatMap((row) =>
      (JSON.parse(row.windows) as ResolvedBookingWindow[])
        .filter(
          (segment) =>
            !window ||
            (segment.startUtc < window.endUtc &&
              segment.endUtc > window.startUtc),
        )
        .map((segment) => ({
          ...segment,
          window: segment,
          providerId: row.provider_id as string,
          exclusive: row.exclusive as boolean,
        })),
    );
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
