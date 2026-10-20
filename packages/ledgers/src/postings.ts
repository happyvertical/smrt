import { digestRunOnceContent, runOnce } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import { JournalCollection } from './collections/Journals';
import { LedgerCollection } from './collections/Ledgers';
import type { Journal } from './models/Journal';

export type Counterparty = { kind: string; id: string };

export interface LedgerPostingInput {
  db: DatabaseInterface;
  tenantId: string;
  ledgerId: string;
  idempotencyKey: string;
  sourceModule: string;
  sourceRef: string;
  description: string;
  date?: Date;
  currency: string;
  amountMinor: number;
  counterparty: Counterparty;
  debitAccountId: string;
  creditAccountId: string;
  dueDate?: Date;
  settlesSourceRef?: string;
}

function assertInput(input: LedgerPostingInput): void {
  for (const value of [
    input.tenantId,
    input.ledgerId,
    input.idempotencyKey,
    input.sourceModule,
    input.sourceRef,
    input.currency,
    input.counterparty.kind,
    input.counterparty.id,
    input.debitAccountId,
    input.creditAccountId,
    ...(input.settlesSourceRef === undefined ? [] : [input.settlesSourceRef]),
  ]) {
    if (!value?.trim() || value !== value.trim())
      throw new Error(
        'Ledger posting identifiers must be nonempty trimmed strings',
      );
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new Error(
      'Ledger posting amountMinor must be a positive safe integer',
    );
}

function replayMismatchError(): Error {
  return new Error(
    'Ledger posting idempotency key was replayed with different content',
  );
}

/**
 * Atomically records an exact-minor-unit double entry. `runOnce` scopes the
 * key by tenant and ledger; its receipt binds the request digest so retries recover the
 * original journal and a changed replay refuses instead of double-posting.
 * Idempotency is permanent: once the receipt is pruned, the journal's unique
 * `(tenantId, ledgerId, idempotencyKey)` row and its `requestDigest` answer the
 * same replay.
 */
export async function postLedgerEntry(
  input: LedgerPostingInput,
): Promise<Journal> {
  // Snapshot caller-owned data before the first await; a caller may reuse or
  // mutate its request object while another posting is waiting for a claim.
  input = {
    ...input,
    counterparty: { ...input.counterparty },
    date: input.date ? new Date(input.date) : undefined,
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
  };
  assertInput(input);
  if (getTenantId() && getTenantId() !== input.tenantId)
    throw new Error('Ledger posting tenant differs from active context');
  const content = {
    ledgerId: input.ledgerId,
    sourceModule: input.sourceModule,
    sourceRef: input.sourceRef,
    description: input.description,
    date: input.date?.toISOString() ?? null,
    currency: input.currency,
    amountMinor: input.amountMinor,
    counterparty: input.counterparty,
    debitAccountId: input.debitAccountId,
    creditAccountId: input.creditAccountId,
    dueDate: input.dueDate?.toISOString() ?? null,
    settlesSourceRef: input.settlesSourceRef ?? null,
  };
  const digest = digestRunOnceContent(content);
  const receipt = await withTenant({ tenantId: input.tenantId }, () =>
    runOnce(
      {
        db: input.db,
        tenantId: input.tenantId,
        actor: 'smrt-ledgers.post:v1',
        token: input.idempotencyKey,
        content: { ledgerId: input.ledgerId },
      },
      async (tx) => {
        const ledger = await (await LedgerCollection.create({ db: tx })).get({
          id: input.ledgerId,
        });
        if (
          !ledger ||
          ledger.tenantId !== input.tenantId ||
          ledger.balanceMode !== 'exact-integer'
        )
          throw new Error(
            'Posting helpers require an owned exact-integer ledger',
          );
        const journals = await JournalCollection.create({ db: tx });
        // The `runOnce` claim is pruned after its retention window (30 days by
        // default), after which an identical retry would re-run this callback
        // and hit `journals_ledger_idempotency_key`. The journal row is the
        // permanent idempotency record, so resolve it before inserting (#4067).
        const [existing] = await journals.list({
          where: {
            tenantId: input.tenantId,
            ledgerId: input.ledgerId,
            idempotencyKey: input.idempotencyKey,
          },
          limit: 1,
        });
        if (existing) {
          if (existing.requestDigest !== digest) throw replayMismatchError();
          if (!existing.isPosted())
            throw new Error(
              'Ledger posting idempotency key belongs to a journal that is not posted',
            );
          return { journalId: existing.id, requestDigest: digest };
        }
        const journal = await journals.createWithEntries({
          tenantId: input.tenantId,
          ledgerId: input.ledgerId,
          date: input.date ?? new Date(),
          description: input.description,
          sourceModule: input.sourceModule,
          sourceRef: input.sourceRef,
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
          metadata: {
            idempotencyKey: input.idempotencyKey,
            requestDigest: digest,
          },
          entries: [
            {
              accountId: input.debitAccountId,
              debit: input.amountMinor,
              currency: input.currency,
              counterpartyKind: input.counterparty.kind,
              counterpartyId: input.counterparty.id,
              dueDate: input.dueDate,
              settlesSourceRef: input.settlesSourceRef,
            },
            {
              accountId: input.creditAccountId,
              credit: input.amountMinor,
              currency: input.currency,
              counterpartyKind: input.counterparty.kind,
              counterpartyId: input.counterparty.id,
              dueDate: input.dueDate,
              settlesSourceRef: input.settlesSourceRef,
            },
          ],
        });
        await journal.post();
        return { journalId: journal.id, requestDigest: digest };
      },
    ),
  );
  if (receipt.requestDigest !== digest) throw replayMismatchError();
  const journal = await withTenant({ tenantId: input.tenantId }, async () => {
    const journals = await JournalCollection.create({ db: input.db });
    return journals.get({ id: String(receipt.journalId) });
  });
  if (!journal?.isPosted())
    throw new Error(
      'Ledger posting receipt does not resolve to a posted journal',
    );
  if (journal.requestDigest !== digest) throw replayMismatchError();
  return journal;
}

export const postReceivable = postLedgerEntry;
export const postPayable = postLedgerEntry;
export const postSettlement = postLedgerEntry;
