/** A host-authenticated identity. Never construct this directly from request data. */
export interface BookingContext {
  tenantId: string;
  actorId: string;
}

export type BookingOperation =
  | 'configure-offering'
  | 'declare-availability'
  | 'request'
  | 'propose'
  | 'assent'
  | 'confirm'
  | 'decline'
  | 'cancel'
  | 'attach-project'
  | 'read'
  | 'history';

export interface BookingAccess {
  operator: boolean;
  /** Customer contact the host currently maps to this actor, if any. */
  contactId?: string;
}

export interface ApprovedPlanRef {
  id: string;
  version: string;
}

export interface BookingReferences {
  contactId?: string;
  /** Canonical provider identity, shared by all offerings for this human. */
  providerId?: string;
  projectId?: string;
  /** Only passed when the host must attest this exact version is approved. */
  approvedPlan?: ApprovedPlanRef;
}

/** The host verifies tenant ownership, reference relationships and role access. */
export interface BookingAuthority {
  access(
    context: Readonly<BookingContext>,
    operation: BookingOperation,
  ): Promise<BookingAccess | null>;
  verifyReferences(
    context: Readonly<BookingContext>,
    references: Readonly<BookingReferences>,
  ): Promise<boolean>;
  /**
   * Optional. Used instead of verifyReferences for the contact when a booking has
   * no project (a lead-bound request). Must confirm the contact exists in this
   * tenant and that the actor may act for it. When absent, the contact is passed
   * to verifyReferences as before.
   */
  verifyContact?(
    context: Readonly<BookingContext>,
    contactId: string,
  ): Promise<boolean>;
}

/**
 * `developer-hour` is dedicated, exclusive attention for any unit (the name is
 * kept for schema compatibility); `supervision-day` is shared supervision
 * capacity and is always one day.
 */
export type BookingKind = 'developer-hour' | 'supervision-day';

/** Sales granularity of an offering. */
export type BookingUnit = 'hour' | 'day' | 'week' | 'month';

export interface BookingOffering {
  id: string;
  kind: BookingKind;
  unit: BookingUnit;
  /** Integer minor units, or null when the offering is unpriced. */
  priceCents: number | null;
  /** ISO 4217 uppercase code, null iff priceCents is null. */
  currency: string | null;
  /** Short display name, at most 120 characters. */
  title: string;
  /** Plain-text description, at most 2000 characters. */
  description: string;
  /** Discoverable by a reader with no contact mapping. Only affects discovery. */
  public: boolean;
  enabled: boolean;
}

export interface ConfigureOfferingInput {
  offeringId: string;
  kind: BookingKind;
  /** Defaults from kind: developer-hour is hour, supervision-day is day. Frozen after creation. */
  unit?: BookingUnit;
  /** Integer minor units; default null (unpriced). */
  priceCents?: number | null;
  /** ISO 4217 uppercase code; set together with priceCents. */
  currency?: string | null;
  /** Default ''. */
  title?: string;
  /** Default ''. */
  description?: string;
  /** Default false. */
  public?: boolean;
  enabled: boolean;
}

export interface BookingPageOptions {
  /** The nextCursor returned by the previous page, with the same filters. */
  afterId?: string;
  /** Defaults to 50. Accepts 1 through 100. */
  limit?: number;
}

export interface ListBookingsOptions extends BookingPageOptions {
  projectId?: string;
  /** Operators may narrow to one contact; other callers may only name their own. */
  contactId?: string;
}

export interface ListOpenSlotsOptions {
  offeringId: string;
  /** ISO 8601 instants. to - from must be positive and at most 400 days. */
  from: string;
  to: string;
  /** Default 1. Supervision offerings accept only 1. */
  quantity?: number;
  /** Narrow to one provider. */
  providerId?: string;
  /** Opaque nextCursor from the previous page. */
  after?: string;
  /** Defaults to 50. Accepts 1 through 100. */
  limit?: number;
}

export interface OpenSlot {
  providerId: string;
  offeringId: string;
  unit: BookingUnit;
  quantity: number;
  /** Candidate segments to pass as `windows` to propose(). */
  windows: ResolvedBookingWindow[];
  /** 1 for dedicated slots; the minimum remaining shared units for supervision. */
  remainingCapacity: number;
}

export interface BookingPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** A minute-precision local timestamp with explicit UTC offset, e.g. YYYY-MM-DDTHH:mm-06:00. */
export interface WallWindow {
  start: string;
  end: string;
}

export interface BookingWindow extends WallWindow {
  zone: string;
}

export interface ResolvedBookingWindow extends BookingWindow {
  startUtc: string;
  endUtc: string;
}

export interface AvailabilityWindow extends WallWindow {
  capacity: number;
  /** May this exact local coverage window be proposed as a supervision day? */
  supervision: boolean;
}

export interface DeclaredAvailabilityWindow
  extends ResolvedBookingWindow,
    AvailabilityWindow {}

export interface ProviderAvailability {
  providerId: string;
  windows: DeclaredAvailabilityWindow[];
}

export interface AvailabilityInput {
  providerId: string;
  zone: string;
  windows: readonly AvailabilityWindow[];
}

/** Terms revision and verbatim accepted wording; does not encode capacity or payment state. */
export interface ProposalTerms {
  revision: string;
  text: string;
}

export interface BookingProposal {
  id: string;
  providerId: string;
  /** Overall span: first window start to last window end. */
  window: ResolvedBookingWindow;
  /** Reserved segments, sorted, non-overlapping and in one zone. */
  windows: ResolvedBookingWindow[];
  unit: BookingUnit;
  quantity: number;
  /** Frozen from the offering at proposal time; null when unpriced. */
  unitPriceCents: number | null;
  currency: string | null;
  /** unitPriceCents * quantity; null when unpriced. */
  totalCents: number | null;
  terms: ProposalTerms;
  approvedPlan: ApprovedPlanRef | null;
}

export interface ProposeBookingInput {
  bookingId: string;
  providerId: string;
  /** Exactly one of `window` (single segment) or `windows`. */
  window?: BookingWindow;
  windows?: readonly BookingWindow[];
  /** Defaults to the request's quantity. */
  quantity?: number;
  terms: ProposalTerms;
  approvedPlan?: ApprovedPlanRef;
}

export interface RequestBookingInput {
  offeringId: string;
  contactId: string;
  projectId?: string;
  /** Positive integer, default 1, at most 1000; supervision must be 1. */
  quantity?: number;
}

export type BookingStatus =
  | 'requested'
  | 'proposed'
  | 'confirmed'
  | 'declined'
  | 'cancelled';

export interface BookingView {
  id: string;
  offeringId: string;
  contactId: string;
  projectId: string | null;
  kind: BookingKind;
  unit: BookingUnit;
  quantity: number;
  status: BookingStatus;
  proposal: BookingProposal | null;
  assentedProposalId: string | null;
  confirmedProposalId: string | null;
}

/** Stable response persisted for retries, independent of subsequent changes. */
export interface BookingReceipt {
  id: string;
  proposalId?: string;
}

export interface BookingHistoryEvent {
  operation: BookingOperation;
  actorId: string;
  proposalId: string | null;
  reason: string | null;
  at: string;
}
