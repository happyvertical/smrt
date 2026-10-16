/** Exact original issued sales authority. Host review is distinct from original issue/approval. */
import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { CustomerCollection } from './collections/CustomerCollection.js';
import { HistoricalSalesLineCollection } from './collections/HistoricalSalesLineCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from './collections/TaxCodeCollection.js';
import { TaxComponentCollection } from './collections/TaxComponentCollection.js';
import { assertContractScheduleInvoiceFreeze } from './contract-billing-schedule.js';
import {
  lockAndReloadInvoice,
  refreshIssuedCreditBalance,
} from './document-money.js';
import { DOCUMENT_MONEY_WRITE } from './document-money-internal.js';
import { withHistoricalCommerceWrite } from './historical-commerce-internal.js';
import type {
  HistoricalSalesMoneySnapshot,
  RecordHistoricalSalesMoneyInput,
} from './historical-sales-types.js';
import {
  historicalSalesMagnitudes,
  historicalText,
  validateHistoricalSalesMoneyFacts,
  validateHistoricalSalesSource,
} from './historical-sales-validation.js';
import { HistoricalSalesLine } from './models/HistoricalSalesLine.js';
import type { Invoice } from './models/Invoice.js';
import { MoneyValidationError } from './money.js';
import {
  type InvoiceRetentionState,
  parseInvoiceRetention,
} from './retention-money.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';
import { InvoiceStatus } from './types/index.js';

export type * from './historical-sales-types.js';
export { validateHistoricalSalesMoneyFacts } from './historical-sales-validation.js';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function identity(value: unknown): string {
  const h = hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function invalid(message: string): never {
  throw new MoneyValidationError('INVALID_MONEY_INPUT', message);
}
export function historicalSalesSourceHash(
  source: HistoricalSalesMoneySnapshot['source'],
): string {
  return hash([source.namespace, source.key]);
}
function snapshotIdentity(
  invoice: Invoice,
  snapshot: HistoricalSalesMoneySnapshot,
) {
  return identity({
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    customerId: invoice.customerId,
    invoiceNumber: invoice.invoiceNumber,
    snapshot,
  });
}
function originalRetentionState(
  snapshot: HistoricalSalesMoneySnapshot,
): InvoiceRetentionState | null {
  const r = snapshot.source.retention;
  if (!r) return null;
  return {
    version: 1,
    currency: snapshot.facts.currency,
    creditPolicy: r.creditPolicy,
    retainedMinor: r.retainedMinor,
    requestId: `historical-retention:${snapshot.requestId}`,
    policyVersion: r.policyRef,
    evidenceRef: r.evidenceRef,
    actorId: snapshot.review.actorId,
    reason: 'Original source retention',
    recordedAt: snapshot.recordedAt,
    effectiveOn: r.effectiveOn,
    releases: r.releases.map((event) => ({
      requestId: `historical-release:${event.sourceKey}`,
      policyVersion: r.policyRef,
      evidenceRef: event.evidenceRef,
      actorId: snapshot.review.actorId,
      reason: 'Original source release',
      recordedAt: snapshot.recordedAt,
      effectiveOn: event.effectiveOn,
      ...(event.sameDayCreditOrder === undefined
        ? {}
        : { sameDayCreditOrder: event.sameDayCreditOrder }),
      amountMinor: event.amountMinor,
    })),
  };
}
/** Stored source header evidence; never recalculates tax or source line allocations. */
export function getHistoricalSalesMoney(
  invoice: Invoice,
): HistoricalSalesMoneySnapshot | null {
  if (
    invoice.moneyAuthority === 'calculated' &&
    !invoice.historicalSalesMoneyJson &&
    invoice.historicalSourceKeyHash === null
  )
    return null;
  if (
    invoice.moneyAuthority !== 'historical' ||
    !invoice.historicalSalesMoneyJson
  )
    invalid('Historical invoice authority is incomplete');
  const value = JSON.parse(
    invoice.historicalSalesMoneyJson,
  ) as HistoricalSalesMoneySnapshot;
  if (value.version !== 1)
    invalid('Historical invoice snapshot version is unsupported');
  const snapshot: HistoricalSalesMoneySnapshot = {
    version: 1,
    requestId: historicalText(value.requestId),
    evidenceRef: historicalText(value.evidenceRef),
    review: {
      actorId: historicalText(value.review?.actorId),
      policyRef: historicalText(value.review?.policyRef),
    },
    recordedAt: historicalText(value.recordedAt),
    source: validateHistoricalSalesSource(value.source),
    facts: validateHistoricalSalesMoneyFacts(value.facts),
    creditedSource:
      value.creditedSource === null
        ? null
        : {
            invoiceId: historicalText(value.creditedSource?.invoiceId),
            moneySnapshotId: historicalText(
              value.creditedSource?.moneySnapshotId,
            ),
          },
  };
  const amounts = historicalSalesMagnitudes(snapshot.facts);
  if (
    invoice.currency !== snapshot.facts.currency ||
    invoice.kind !== snapshot.facts.kind ||
    invoice.subtotal !== amounts.netMinor ||
    invoice.taxAmount !== amounts.taxMinor ||
    invoice.totalAmount !== amounts.grossMinor ||
    invoice.discountTotal !== 0 ||
    invoice.providerTaxAmount !== 0 ||
    invoice.historicalSourceKeyHash !==
      historicalSalesSourceHash(snapshot.source) ||
    invoice.moneySnapshotId !== snapshotIdentity(invoice, snapshot)
  )
    invalid(
      'Historical invoice no longer matches its immutable original monetary authority',
    );
  if (
    invoice.issueDate.toISOString().slice(0, 10) !== snapshot.source.issuedOn ||
    (invoice.dueDate?.toISOString().slice(0, 10) ?? null) !==
      snapshot.source.dueOn
  )
    invalid('Historical source calendar dates changed');
  if (
    snapshot.facts.kind === 'credit_note'
      ? invoice.creditedInvoiceId !== snapshot.creditedSource?.invoiceId
      : snapshot.creditedSource !== null
  )
    invalid('Historical credit source lineage changed');
  const expectedRetention = originalRetentionState(snapshot),
    retained = parseInvoiceRetention(invoice.retentionStateJson);
  if (expectedRetention) {
    if (!retained) invalid('Original retention authority is missing');
    for (const key of Object.keys(
      expectedRetention,
    ) as (keyof InvoiceRetentionState)[]) {
      if (key === 'releases') continue;
      if (retained[key] !== expectedRetention[key])
        invalid('Original retention source projection changed');
    }
    if (
      JSON.stringify(
        retained.releases.slice(0, expectedRetention.releases.length),
      ) !== JSON.stringify(expectedRetention.releases) ||
      retained.releases
        .slice(expectedRetention.releases.length)
        .some((event) => event.effectiveOn !== undefined)
    )
      invalid('Original retention release projection changed');
  } else if (retained)
    invalid('Historical invoice has no original retention authority');
  return structuredClone(snapshot);
}
function lineIdentity(invoiceId: string, sourceKey: string) {
  return identity({ kind: 'historical-sales-line:v1', invoiceId, sourceKey });
}
/** Read actual immutable source children for typed consumer crosswalks. */
export async function readHistoricalSalesLines(
  db: DatabaseInterface,
  invoice: Invoice,
) {
  const snapshot = getHistoricalSalesMoney(invoice);
  if (!snapshot) return [];
  const lines = await (await HistoricalSalesLineCollection.create({ db })).list(
    {
      where: { tenantId: invoice.tenantId, invoiceId: invoice.id },
      limit: 100001,
    },
  );
  const expected =
    snapshot.facts.detail.kind === 'lines' ? snapshot.facts.detail.lines : [];
  if (lines.length !== expected.length)
    invalid('Historical invoice source child identities are incomplete');
  const byKey = new Map(lines.map((line) => [line.sourceKey, line]));
  if (byKey.size !== lines.length)
    invalid('Historical source child identity is ambiguous');
  return expected.map((source) => {
    const line = byKey.get(source.sourceKey);
    if (
      !line ||
      line.id !== lineIdentity(String(invoice.id), source.sourceKey) ||
      line.sourceKeyHash !== hash(source.sourceKey) ||
      line.moneySnapshotId !== invoice.moneySnapshotId ||
      line.description !== source.description ||
      line.creditedLineId !== source.creditedLineId ||
      line.netMinor !== source.netMinor ||
      line.taxMinor !== source.taxMinor ||
      line.grossMinor !== source.grossMinor ||
      line.quantityText !== source.quantityText ||
      line.unitRateText !== source.unitRateText ||
      line.sourceFieldsJson !== JSON.stringify(source.sourceFields)
    )
      invalid(
        'Historical invoice source child no longer matches its original facts',
      );
    return line;
  });
}
async function assertSourceLineCapacity(
  db: DatabaseInterface,
  invoices: InvoiceCollection,
  source: Invoice | null,
  snapshot: HistoricalSalesMoneySnapshot,
) {
  if (snapshot.facts.detail.kind !== 'lines') return;
  const linked = snapshot.facts.detail.lines.filter(
    (line) => line.creditedLineId !== null,
  );
  if (!linked.length) return;
  if (!source || snapshot.facts.kind !== 'credit_note')
    invalid(
      'Only an exact historical credit may link original historical lines',
    );
  const sourceLines = new Map(
    (await readHistoricalSalesLines(db, source)).map((line) => [line.id, line]),
  );
  const collection = await HistoricalSalesLineCollection.create({ db });
  const requestSign = snapshot.facts.polarity === 'signed' ? -1 : 1;
  const pending = new Map<
    string,
    { netMinor: bigint; taxMinor: bigint; grossMinor: bigint }
  >();
  for (const request of linked) {
    const original = sourceLines.get(request.creditedLineId ?? '');
    if (!original)
      invalid(
        'Historical credit line does not belong to its exact original source invoice',
      );
    const inRequest = pending.get(String(original.id)) ?? {
      netMinor: 0n,
      taxMinor: 0n,
      grossMinor: 0n,
    };
    const previous = await collection.list({
      where: { tenantId: source.tenantId, creditedLineId: original.id },
      limit: 100001,
    });
    if (previous.length > 100000)
      invalid(
        'Historical source line capacity exceeds the bounded credit scope',
      );
    const consumed = { netMinor: 0n, taxMinor: 0n, grossMinor: 0n };
    for (const line of previous) {
      const parent = await invoices.get(
        { id: line.invoiceId, tenantId: source.tenantId },
        { cache: false },
      );
      if (
        !parent ||
        parent.kind !== 'credit_note' ||
        parent.creditedInvoiceId !== source.id
      )
        invalid('Historical source line has invalid credit lineage');
      if (
        parent.status === InvoiceStatus.DRAFT ||
        parent.status === InvoiceStatus.CANCELLED
      )
        continue;
      const prior = getHistoricalSalesMoney(parent);
      if (!prior)
        invalid('Historical source line has no original monetary authority');
      const sign = prior.facts.polarity === 'signed' ? -1 : 1;
      for (const field of ['netMinor', 'taxMinor', 'grossMinor'] as const) {
        if (line[field] !== null)
          consumed[field] += BigInt(line[field]) * BigInt(sign);
      }
    }
    for (const field of ['netMinor', 'taxMinor', 'grossMinor'] as const) {
      const originalAmount = original[field],
        requestedAmount = request[field];
      if (originalAmount === null || requestedAmount === null) continue;
      const magnitude = originalAmount < 0 ? -1n : 1n;
      const originalMagnitude = BigInt(originalAmount) * magnitude;
      const requestMagnitude =
        BigInt(requestedAmount) * BigInt(requestSign) * magnitude;
      if (
        requestMagnitude < 0n ||
        (consumed[field] + inRequest[field]) * magnitude + requestMagnitude >
          originalMagnitude
      )
        invalid(
          'Historical credit exceeds an exact original source line monetary capacity',
        );
    }
    for (const field of ['netMinor', 'taxMinor', 'grossMinor'] as const)
      if (request[field] !== null)
        inRequest[field] += BigInt(request[field]) * BigInt(requestSign);
    pending.set(String(original.id), inRequest);
  }
}
function stableRequest(snapshot: HistoricalSalesMoneySnapshot) {
  return {
    source: snapshot.source,
    facts: snapshot.facts,
    evidenceRef: snapshot.evidenceRef,
    policyRef: snapshot.review.policyRef,
    creditedSource: snapshot.creditedSource,
  };
}
/** Host-authorized import only. Source issue is retained evidence, never a new send/post. */
export async function recordHistoricalSalesMoney(
  input: RecordHistoricalSalesMoneyInput,
) {
  if (getTenantId() !== input.tenantId)
    invalid('Historical sales require the explicit active tenant');
  const facts = validateHistoricalSalesMoneyFacts(input.facts),
    source = validateHistoricalSalesSource(input.source);
  const snapshot: HistoricalSalesMoneySnapshot = {
    version: 1,
    requestId: historicalText(input.requestId),
    evidenceRef: historicalText(input.evidenceRef),
    review: {
      actorId: historicalText(input.review?.actorId),
      policyRef: historicalText(input.review?.policyRef),
    },
    recordedAt: new Date().toISOString(),
    source,
    facts,
    creditedSource: input.creditedSource
      ? {
          invoiceId: historicalText(input.creditedSource.invoiceId),
          moneySnapshotId: historicalText(input.creditedSource.moneySnapshotId),
        }
      : null,
  };
  if ((facts.kind === 'credit_note') !== Boolean(snapshot.creditedSource))
    invalid(
      'Historical credits require the exact original issued invoice snapshot',
    );
  return withTenantMoneyRuntime(input.db, input.tenantId, async ({ db }) => {
    const { invoice } = await lockAndReloadInvoice(
      db,
      historicalText(input.invoiceId),
      input.tenantId,
    );
    if (invoice.tenantId !== input.tenantId)
      invalid('Historical invoice is not owned by the active tenant');
    const existing = getHistoricalSalesMoney(invoice);
    if (existing) {
      if (hash(stableRequest(existing)) !== hash(stableRequest(snapshot)))
        invalid(
          'Historical invoice retry differs from its original facts or reviewed policy',
        );
      return {
        snapshot: existing,
        invoiceId: String(invoice.id),
        moneySnapshotId: invoice.moneySnapshotId,
        lines: (await readHistoricalSalesLines(db, invoice)).map((line) => ({
          sourceKey: line.sourceKey,
          lineId: String(line.id),
        })),
      };
    }
    if (
      invoice.status !== InvoiceStatus.DRAFT ||
      invoice.moneySnapshotId ||
      invoice.arJournalId ||
      invoice.amountPaid ||
      invoice.creditedAmount ||
      invoice.retentionStateJson ||
      invoice.externalId ||
      invoice.externalProvider ||
      invoice.providerTaxAmount
    )
      invalid(
        'Historical source money requires an empty unfrozen invoice without current financial effects',
      );
    if (invoice.kind !== facts.kind || invoice.currency !== facts.currency)
      invalid('Historical source kind/currency must match its draft invoice');
    const customer = invoice.customerId
      ? await (await CustomerCollection.create({ db })).get(
          { id: invoice.customerId, tenantId: input.tenantId },
          { cache: false },
        )
      : null;
    if (!customer)
      invalid('Historical sales require a customer owned by the active tenant');
    if (
      (
        await (
          await InvoiceLineItemCollection.create({ db })
        ).findByInvoice(String(invoice.id))
      ).length
    )
      invalid(
        'Historical source money cannot mix with calculated invoice lines',
      );
    const invoices = await InvoiceCollection.create({ db });
    const duplicate = (
      await invoices.list({
        where: {
          tenantId: input.tenantId,
          historicalSourceKeyHash: historicalSalesSourceHash(source),
        },
        limit: 1,
      })
    )[0];
    if (duplicate && duplicate.id !== invoice.id)
      invalid(
        'Historical source identity already belongs to another canonical invoice',
      );
    for (const component of facts.taxComponents ?? []) {
      const code = component.taxCodeId
        ? await (await TaxCodeCollection.create({ db })).get(
            { id: component.taxCodeId, tenantId: input.tenantId },
            { cache: false },
          )
        : null;
      if (
        component.taxCodeId &&
        (!code ||
          (component.classification !== null &&
            code.kind !== component.classification))
      )
        invalid(
          'Historical source tax code is not owned by its tenant with the reviewed classification',
        );
      if (component.taxComponentId) {
        const tax = await (await TaxComponentCollection.create({ db })).get(
          { id: component.taxComponentId, tenantId: input.tenantId },
          { cache: false },
        );
        if (
          !tax ||
          (code &&
            !code.components.some((part) => part.taxComponentId === tax.id))
        )
          invalid(
            'Historical source tax component is not owned by its declared tenant/code',
          );
      }
      if (component.liabilityAccountId) {
        const { AccountCollection } = await import(
          '@happyvertical/smrt-ledgers'
        );
        const account = await (await AccountCollection.create({ db })).get(
          { id: component.liabilityAccountId, tenantId: input.tenantId },
          { cache: false },
        );
        if (!account || account.type !== 'liability')
          invalid(
            'Historical source tax liability account is not owned by its tenant with the required type',
          );
      }
    }
    let credited: Invoice | null = null;
    const amounts = historicalSalesMagnitudes(facts);
    if (snapshot.creditedSource) {
      credited = (
        await lockAndReloadInvoice(
          db,
          snapshot.creditedSource.invoiceId,
          input.tenantId,
        )
      ).invoice;
      if (
        credited.kind !== 'invoice' ||
        credited.tenantId !== input.tenantId ||
        credited.customerId !== invoice.customerId ||
        credited.currency !== invoice.currency ||
        !credited.moneySnapshotId ||
        credited.moneySnapshotId !== snapshot.creditedSource.moneySnapshotId ||
        credited.status === InvoiceStatus.DRAFT ||
        credited.status === InvoiceStatus.CANCELLED ||
        invoice.creditedInvoiceId !== credited.id
      )
        invalid(
          'Historical credit original invoice/customer/currency/snapshot does not match',
        );
      const prior = (
        await invoices
          .list({
            where: { tenantId: input.tenantId, creditedInvoiceId: credited.id },
            limit: 100001,
          })
          .then((rows) => {
            if (rows.length > 100000)
              invalid(
                'Historical credit scope exceeds its bounded source limit',
              );
            return rows;
          })
      ).filter(
        (row) =>
          row.id !== invoice.id &&
          row.status !== InvoiceStatus.DRAFT &&
          row.status !== InvoiceStatus.CANCELLED,
      );
      if (prior.length > 100000)
        invalid('Historical credit scope exceeds its bounded source limit');
      const retention = parseInvoiceRetention(credited.retentionStateJson);
      if (retention) {
        const credits = [
          ...prior.map((row) => ({
            on:
              getHistoricalSalesMoney(row)?.source.issuedOn ??
              row.issueDate.toISOString().slice(0, 10),
            amount: row.totalAmount,
          })),
          { on: source.issuedOn, amount: amounts.grossMinor },
        ];
        let remaining = retention.retainedMinor;
        const events = [
          ...credits.map((event) => ({
            ...event,
            kind: 'credit' as const,
            rank: 1,
          })),
          ...retention.releases.map((release) => {
            const on = release.effectiveOn ?? release.recordedAt.slice(0, 10);
            if (
              credits.some((event) => event.on === on) &&
              !release.sameDayCreditOrder
            )
              invalid(
                'Same-day original retention release/credit requires explicit reviewed ordering',
              );
            return {
              on,
              amount: release.amountMinor,
              kind: 'release' as const,
              rank:
                release.sameDayCreditOrder === 'release-before-credit' ? 0 : 2,
            };
          }),
        ].sort(
          (left, right) =>
            left.on.localeCompare(right.on) || left.rank - right.rank,
        );
        for (const event of events) {
          if (event.kind === 'credit')
            remaining = Math.max(0, remaining - event.amount);
          else {
            if (event.amount > remaining)
              invalid(
                'Original retention release exceeds retained-first capacity at its source date',
              );
            remaining -= event.amount;
          }
        }
      }
      for (const [field, value] of [
        ['subtotal', amounts.netMinor],
        ['taxAmount', amounts.taxMinor],
        ['totalAmount', amounts.grossMinor],
      ] as const) {
        const consumed = prior.reduce(
          (sum, row) => sum + BigInt(row[field]),
          0n,
        );
        if (consumed + BigInt(value) > BigInt(credited[field]))
          invalid(
            'Historical credit exceeds the remaining exact original net/tax/gross capacity',
          );
      }
    }
    await assertSourceLineCapacity(db, invoices, credited, snapshot);
    if (
      source.retention &&
      (facts.kind !== 'invoice' ||
        source.retention.retainedMinor > amounts.grossMinor)
    )
      invalid('Historical retention must match original invoice gross');
    const originalRetention = originalRetentionState(snapshot);
    invoice.retentionStateJson = originalRetention
      ? JSON.stringify(originalRetention)
      : '';
    invoice.moneyAuthority = 'historical';
    invoice.historicalSalesMoneyJson = JSON.stringify(snapshot);
    invoice.historicalSourceKeyHash = historicalSalesSourceHash(source);
    invoice.subtotal = amounts.netMinor;
    invoice.discountTotal = 0;
    invoice.taxAmount = amounts.taxMinor;
    invoice.providerTaxAmount = 0;
    invoice.totalAmount = amounts.grossMinor;
    invoice.issueDate = new Date(`${source.issuedOn}T00:00:00Z`);
    invoice.dueDate =
      source.dueOn === null ? null : new Date(`${source.dueOn}T00:00:00Z`);
    invoice.moneySnapshotId = snapshotIdentity(invoice, snapshot);
    invoice.status = InvoiceStatus.SENT;
    await assertContractScheduleInvoiceFreeze(db, invoice);
    await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
    if (facts.detail.kind === 'lines')
      for (const line of facts.detail.lines) {
        const child = await new HistoricalSalesLine({
          db,
          id: lineIdentity(String(invoice.id), line.sourceKey),
          tenantId: input.tenantId,
          invoiceId: String(invoice.id),
          ...line,
          sourceKeyHash: hash(line.sourceKey),
          moneySnapshotId: invoice.moneySnapshotId,
        }).initialize();
        await withHistoricalCommerceWrite(child, () => child.save());
      }
    if (credited) await refreshIssuedCreditBalance(db, credited);
    return {
      snapshot: structuredClone(snapshot),
      invoiceId: String(invoice.id),
      moneySnapshotId: invoice.moneySnapshotId,
      lines: (await readHistoricalSalesLines(db, invoice)).map((line) => ({
        sourceKey: line.sourceKey,
        lineId: String(line.id),
      })),
    };
  });
}
