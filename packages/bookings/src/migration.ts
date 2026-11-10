import type { DatabaseInterface } from '@happyvertical/sql';

const statements = [
  `CREATE TABLE smrt_booking_offerings (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('developer-hour', 'supervision-day')),
    enabled boolean NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE TABLE smrt_booking_resources (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    windows jsonb NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE TABLE smrt_bookings (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    offering_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    project_id uuid,
    kind text NOT NULL CHECK (kind IN ('developer-hour', 'supervision-day')),
    status text NOT NULL CHECK (status IN ('requested', 'proposed', 'confirmed', 'declined', 'cancelled')),
    proposal_id uuid,
    assented_proposal_id uuid,
    confirmed_proposal_id uuid,
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, offering_id) REFERENCES smrt_booking_offerings (tenant_id, id),
    CHECK (kind <> 'supervision-day' OR project_id IS NOT NULL),
    CHECK (status <> 'confirmed' OR confirmed_proposal_id IS NOT NULL),
    CHECK (assented_proposal_id IS NULL OR assented_proposal_id IS NOT DISTINCT FROM proposal_id),
    CHECK (confirmed_proposal_id IS NULL OR confirmed_proposal_id IS NOT DISTINCT FROM assented_proposal_id)
  )`,
  `CREATE TABLE smrt_booking_proposals (
    tenant_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    coverage jsonb NOT NULL,
    terms jsonb NOT NULL,
    approved_plan jsonb,
    PRIMARY KEY (tenant_id, booking_id, id),
    FOREIGN KEY (tenant_id, booking_id) REFERENCES smrt_bookings (tenant_id, id),
    FOREIGN KEY (tenant_id, provider_id) REFERENCES smrt_booking_resources (tenant_id, id)
  )`,
  `ALTER TABLE smrt_bookings
    ADD FOREIGN KEY (tenant_id, id, proposal_id) REFERENCES smrt_booking_proposals (tenant_id, booking_id, id)`,
  `CREATE TABLE smrt_booking_allocations (
    tenant_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    project_id uuid,
    exclusive boolean NOT NULL,
    start_at timestamptz NOT NULL,
    end_at timestamptz NOT NULL CHECK (end_at > start_at),
    released_at timestamptz,
    PRIMARY KEY (tenant_id, booking_id),
    FOREIGN KEY (tenant_id, booking_id, proposal_id)
      REFERENCES smrt_booking_proposals (tenant_id, booking_id, id),
    FOREIGN KEY (tenant_id, provider_id) REFERENCES smrt_booking_resources (tenant_id, id),
    CHECK (exclusive = (project_id IS NULL))
  )`,
  `CREATE INDEX smrt_booking_active_provider ON smrt_booking_allocations (tenant_id, provider_id, start_at)
    WHERE released_at IS NULL`,
  `CREATE UNIQUE INDEX smrt_booking_active_project_window
    ON smrt_booking_allocations (tenant_id, project_id, start_at, end_at)
    WHERE released_at IS NULL AND project_id IS NOT NULL`,
  `CREATE TABLE smrt_booking_commands (
    sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    tenant_id uuid NOT NULL,
    operation text NOT NULL,
    key_hash text NOT NULL,
    actor_id text NOT NULL,
    payload_hash text NOT NULL,
    booking_id uuid,
    result jsonb,
    reason text,
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, operation, key_hash),
    FOREIGN KEY (tenant_id, booking_id) REFERENCES smrt_bookings (tenant_id, id)
  )`,
  `CREATE INDEX smrt_booking_history ON smrt_booking_commands (tenant_id, booking_id, sequence)`,
];

/** Initial PostgreSQL schema. Register once in the host deployment's migration ledger. */
export async function migrateBookingsV1(db: DatabaseInterface): Promise<void> {
  if (!db.transaction)
    throw new TypeError('Bookings requires a PostgreSQL transaction');
  await db.transaction(async (tx) => {
    for (const statement of statements) await tx.query(statement);
  });
}

const v2 = [
  `ALTER TABLE smrt_booking_offerings ADD COLUMN unit text`,
  `UPDATE smrt_booking_offerings SET unit = CASE kind WHEN 'supervision-day' THEN 'day' ELSE 'hour' END`,
  `ALTER TABLE smrt_booking_offerings ALTER COLUMN unit SET NOT NULL`,
  `ALTER TABLE smrt_booking_offerings ADD COLUMN price_cents bigint`,
  `ALTER TABLE smrt_booking_offerings ADD COLUMN currency text`,
  `ALTER TABLE smrt_booking_offerings
    ADD CONSTRAINT smrt_booking_offerings_unit CHECK (unit IN ('hour','day','week','month')),
    ADD CONSTRAINT smrt_booking_offerings_supervision_unit CHECK (kind <> 'supervision-day' OR unit = 'day'),
    ADD CONSTRAINT smrt_booking_offerings_price CHECK (price_cents IS NULL OR price_cents >= 0),
    ADD CONSTRAINT smrt_booking_offerings_currency CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT smrt_booking_offerings_priced CHECK ((price_cents IS NULL) = (currency IS NULL))`,
  `ALTER TABLE smrt_booking_offerings ADD COLUMN title text NOT NULL DEFAULT ''`,
  `ALTER TABLE smrt_booking_offerings ADD COLUMN description text NOT NULL DEFAULT ''`,
  `ALTER TABLE smrt_booking_offerings ADD COLUMN public boolean NOT NULL DEFAULT false`,
  `ALTER TABLE smrt_booking_offerings ADD CONSTRAINT smrt_booking_offerings_title CHECK (char_length(title) <= 120)`,
  `ALTER TABLE smrt_booking_offerings ADD CONSTRAINT smrt_booking_offerings_description CHECK (char_length(description) <= 2000)`,
  `ALTER TABLE smrt_bookings ADD COLUMN unit text`,
  `UPDATE smrt_bookings b SET unit = o.unit FROM smrt_booking_offerings o
    WHERE o.tenant_id = b.tenant_id AND o.id = b.offering_id`,
  `ALTER TABLE smrt_bookings ALTER COLUMN unit SET NOT NULL`,
  `ALTER TABLE smrt_bookings ADD COLUMN quantity integer NOT NULL DEFAULT 1`,
  `ALTER TABLE smrt_bookings
    ADD CONSTRAINT smrt_bookings_unit CHECK (unit IN ('hour','day','week','month')),
    ADD CONSTRAINT smrt_bookings_quantity CHECK (quantity >= 1 AND quantity <= 1000),
    ADD CONSTRAINT smrt_bookings_supervision_quantity CHECK (kind <> 'supervision-day' OR (unit = 'day' AND quantity = 1))`,
  `ALTER TABLE smrt_booking_proposals ADD COLUMN windows jsonb`,
  `UPDATE smrt_booking_proposals SET windows = jsonb_build_array(coverage)`,
  `ALTER TABLE smrt_booking_proposals ALTER COLUMN windows SET NOT NULL`,
  `ALTER TABLE smrt_booking_proposals ADD COLUMN unit text`,
  `UPDATE smrt_booking_proposals p SET unit = b.unit FROM smrt_bookings b
    WHERE b.tenant_id = p.tenant_id AND b.id = p.booking_id`,
  `ALTER TABLE smrt_booking_proposals ALTER COLUMN unit SET NOT NULL`,
  `ALTER TABLE smrt_booking_proposals ADD COLUMN quantity integer NOT NULL DEFAULT 1`,
  `ALTER TABLE smrt_booking_proposals ADD COLUMN unit_price_cents bigint`,
  `ALTER TABLE smrt_booking_proposals ADD COLUMN currency text`,
  `ALTER TABLE smrt_booking_proposals ADD COLUMN total_cents bigint`,
  `ALTER TABLE smrt_booking_proposals
    ADD CONSTRAINT smrt_booking_proposals_unit CHECK (unit IN ('hour','day','week','month')),
    ADD CONSTRAINT smrt_booking_proposals_quantity CHECK (quantity >= 1 AND quantity <= 1000),
    ADD CONSTRAINT smrt_booking_proposals_priced
      CHECK ((unit_price_cents IS NULL) = (currency IS NULL) AND (unit_price_cents IS NULL) = (total_cents IS NULL)),
    ADD CONSTRAINT smrt_booking_proposals_total CHECK (total_cents IS NULL OR total_cents = unit_price_cents * quantity),
    ADD CONSTRAINT smrt_booking_proposals_windows CHECK (jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) >= 1)`,
];

/**
 * Additive priced-offering, quantity and multi-window schema. Register once in
 * the host deployment's migration ledger after `migrateBookingsV1`. Like V1 it
 * is not idempotent, and it never drops data.
 */
export async function migrateBookingsV2(db: DatabaseInterface): Promise<void> {
  if (!db.transaction)
    throw new TypeError('Bookings requires a PostgreSQL transaction');
  await db.transaction(async (tx) => {
    for (const statement of v2) await tx.query(statement);
  });
}
