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

/**
 * Atomically records an exact-minor-unit double entry. `runOnce` scopes the
 * key by tenant and ledger; its receipt binds the request digest so retries recover the
 * original journal and a changed replay refuses instead of double-posting.
 */
export async function postLedgerEntry(
  input: LedgerPostingInput,
): Promise<Journal> {
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
  if (receipt.requestDigest !== digest)
    throw new Error(
      'Ledger posting idempotency key was replayed with different content',
    );
  const journal = await withTenant({ tenantId: input.tenantId }, async () => {
    const journals = await JournalCollection.create({ db: input.db });
    return journals.get({ id: String(receipt.journalId) });
  });
  if (!journal?.isPosted())
    throw new Error(
      'Ledger posting receipt does not resolve to a posted journal',
    );
  if (journal.requestDigest !== digest)
    throw new Error(
      'Ledger posting idempotency key was replayed with different content',
    );
  return journal;
}

export const postReceivable = postLedgerEntry;
export const postPayable = postLedgerEntry;
export const postSettlement = postLedgerEntry;
