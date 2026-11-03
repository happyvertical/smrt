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
}

export type BookingKind = 'developer-hour' | 'supervision-day';

export interface BookingOffering {
  id: string;
  kind: BookingKind;
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
  window: ResolvedBookingWindow;
  terms: ProposalTerms;
  approvedPlan: ApprovedPlanRef | null;
}

export interface ProposeBookingInput {
  bookingId: string;
  providerId: string;
  window: BookingWindow;
  terms: ProposalTerms;
  approvedPlan?: ApprovedPlanRef;
}

export interface RequestBookingInput {
  offeringId: string;
  contactId: string;
  projectId?: string;
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
