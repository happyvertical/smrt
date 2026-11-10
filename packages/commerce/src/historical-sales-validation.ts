import { ISO_4217_MINOR_UNITS } from '@happyvertical/smrt-ui/currency';
import type {
  HistoricalSalesMoneyFacts,
  HistoricalSalesRetention,
  HistoricalSalesSource,
} from './historical-sales-types.js';
import { MoneyValidationError } from './money.js';

function invalid(): never {
  throw new MoneyValidationError(
    'INVALID_MONEY_INPUT',
    'Historical sales require exact supported source facts and explicit unknown values',
  );
}
export function historicalText(value: unknown, max = 2000): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim() !== value ||
    value.length > max
  )
    invalid();
  return value;
}
export function historicalCalendarDate(value: unknown): string {
  const date = historicalText(value);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    invalid();
  return date;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function fields(input: unknown, allowed: readonly string[]) {
  const value = record(input);
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid();
  return value;
}
function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}
function nullableText(value: unknown): string | null {
  return value === null ? null : historicalText(value);
}
function sum(values: number[]): number {
  const result = values.reduce((total, value) => total + BigInt(value), 0n);
  if (
    result > BigInt(Number.MAX_SAFE_INTEGER) ||
    result < BigInt(Number.MIN_SAFE_INTEGER)
  )
    invalid();
  return Number(result);
}
function sameAmount(net: number, tax: number, gross: number) {
  if (sum([net, tax]) !== gross) invalid();
}
export function historicalSalesMagnitudes(facts: HistoricalSalesMoneyFacts) {
  const sign =
    facts.kind === 'credit_note' && facts.polarity === 'signed' ? -1 : 1;
  const result = {
    netMinor: facts.netMinor * sign,
    taxMinor: facts.taxMinor * sign,
    grossMinor: facts.grossMinor * sign,
  };
  if (Object.values(result).some((value) => value < 0)) invalid();
  return result;
}
export function validateHistoricalSalesSource(
  input: HistoricalSalesSource,
): HistoricalSalesSource {
  const value = fields(input, [
    'namespace',
    'key',
    'version',
    'issuedOn',
    'dueOn',
    'timeZone',
    'approval',
    'retention',
  ]);
  const retention =
    value.retention == null
      ? value.retention
      : (() => {
          const r = fields(value.retention, [
            'retainedMinor',
            'creditPolicy',
            'policyRef',
            'effectiveOn',
            'evidenceRef',
            'originalActorRef',
            'releases',
          ]);
          if (
            r.creditPolicy !== 'retained-first' ||
            !Array.isArray(r.releases) ||
            r.releases.length > 10000
          )
            invalid();
          const retainedMinor = integer(r.retainedMinor);
          if (retainedMinor <= 0) invalid();
          const effectiveOn = historicalCalendarDate(r.effectiveOn);
          const keys = new Set<string>();
          const releases = r.releases.map(
            (input): HistoricalSalesRetention['releases'][number] => {
              const event = fields(input, [
                'sourceKey',
                'amountMinor',
                'effectiveOn',
                'evidenceRef',
                'originalActorRef',
                'sameDayCreditOrder',
              ]);
              const sourceKey = historicalText(event.sourceKey),
                amountMinor = integer(event.amountMinor),
                on = historicalCalendarDate(event.effectiveOn);
              if (keys.has(sourceKey) || amountMinor <= 0 || on < effectiveOn)
                invalid();
              keys.add(sourceKey);
              return {
                ...(event.sameDayCreditOrder === undefined
                  ? {}
                  : {
                      sameDayCreditOrder:
                        event.sameDayCreditOrder === null ||
                        event.sameDayCreditOrder === 'credit-before-release' ||
                        event.sameDayCreditOrder === 'release-before-credit'
                          ? event.sameDayCreditOrder
                          : invalid(),
                    }),
                sourceKey,
                amountMinor,
                effectiveOn: on,
                evidenceRef: historicalText(event.evidenceRef),
                originalActorRef: nullableText(event.originalActorRef),
              };
            },
          );
          if (sum(releases.map((event) => event.amountMinor)) > retainedMinor)
            invalid();
          return {
            retainedMinor,
            creditPolicy: 'retained-first' as const,
            policyRef: historicalText(r.policyRef),
            effectiveOn,
            evidenceRef: historicalText(r.evidenceRef),
            originalActorRef: nullableText(r.originalActorRef),
            releases,
          };
        })();
  if (
    retention &&
    retention.effectiveOn !== historicalCalendarDate(value.issuedOn)
  )
    invalid();
  const timeZone = historicalText(value.timeZone);
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
  } catch {
    invalid();
  }
  const approval =
    value.approval === null
      ? null
      : fields(value.approval, ['actorRef', 'approvedOn']);
  return {
    ...(retention === undefined ? {} : { retention }),
    namespace: historicalText(value.namespace),
    key: historicalText(value.key),
    version: historicalText(value.version),
    issuedOn: historicalCalendarDate(value.issuedOn),
    dueOn: value.dueOn === null ? null : historicalCalendarDate(value.dueOn),
    timeZone,
    approval:
      approval === null
        ? null
        : {
            actorRef: historicalText(approval.actorRef),
            approvedOn:
              approval.approvedOn === null
                ? null
                : historicalCalendarDate(approval.approvedOn),
          },
  };
}
/** Validate original facts without a tax calculator, source normalization, or implicit polarity. */
export function validateHistoricalSalesMoneyFacts(
  input: HistoricalSalesMoneyFacts,
): HistoricalSalesMoneyFacts {
  const value = fields(input, [
    'currency',
    'kind',
    'polarity',
    'netMinor',
    'taxMinor',
    'grossMinor',
    'taxComponents',
    'detail',
  ]);
  const currency = historicalText(value.currency);
  if (
    !ISO_4217_MINOR_UNITS.has(currency) ||
    ISO_4217_MINOR_UNITS.get(currency) === null ||
    !['invoice', 'credit_note'].includes(value.kind as string) ||
    !['signed', 'magnitudes'].includes(value.polarity as string)
  )
    invalid();
  const netMinor = integer(value.netMinor),
    taxMinor = integer(value.taxMinor),
    grossMinor = integer(value.grossMinor);
  sameAmount(netMinor, taxMinor, grossMinor);
  const seenComponents = new Set<string>();
  const taxComponents =
    value.taxComponents === null
      ? null
      : (() => {
          if (
            !Array.isArray(value.taxComponents) ||
            value.taxComponents.length > 1000
          )
            invalid();
          return value.taxComponents.map((inputComponent) => {
            const component = fields(inputComponent, [
                'sourceKey',
                'label',
                'amountMinor',
                'classification',
                'taxCodeId',
                'taxComponentId',
                'taxableMinor',
                'netMinor',
                'liabilityAccountId',
              ]),
              sourceKey = historicalText(component.sourceKey);
            if (seenComponents.has(sourceKey)) invalid();
            seenComponents.add(sourceKey);
            if (
              component.classification !== null &&
              !['taxable', 'zero-rated', 'exempt', 'out-of-scope'].includes(
                component.classification as string,
              )
            )
              invalid();
            const classification = component.classification as
              | 'taxable'
              | 'zero-rated'
              | 'exempt'
              | 'out-of-scope'
              | null;
            const amountMinor = integer(component.amountMinor),
              taxableMinor = nullableInteger(component.taxableMinor);
            if (
              classification !== null &&
              classification !== 'taxable' &&
              amountMinor !== 0
            )
              invalid();
            return {
              sourceKey,
              label: historicalText(component.label),
              amountMinor,
              classification,
              taxCodeId: nullableText(component.taxCodeId),
              taxComponentId: nullableText(component.taxComponentId),
              taxableMinor,
              netMinor: nullableInteger(component.netMinor),
              liabilityAccountId: nullableText(component.liabilityAccountId),
            };
          });
        })();
  if (
    taxComponents !== null &&
    sum(taxComponents.map((component) => component.amountMinor)) !== taxMinor
  )
    invalid();
  const detailInput = fields(
    value.detail,
    record(value.detail).kind === 'header-only' ? ['kind'] : ['kind', 'lines'],
  );
  let detail: HistoricalSalesMoneyFacts['detail'];
  if (detailInput.kind === 'header-only') detail = { kind: 'header-only' };
  else if (detailInput.kind === 'lines') {
    if (
      !Array.isArray(detailInput.lines) ||
      !detailInput.lines.length ||
      detailInput.lines.length > 100000
    )
      invalid();
    const seen = new Set<string>();
    const lines = detailInput.lines.map((inputLine) => {
      const line = fields(inputLine, [
          'sourceKey',
          'creditedLineId',
          'description',
          'netMinor',
          'taxMinor',
          'grossMinor',
          'quantityText',
          'unitRateText',
          'sourceFields',
        ]),
        sourceKey = historicalText(line.sourceKey);
      if (seen.has(sourceKey)) invalid();
      seen.add(sourceKey);
      const sourceFields = record(line.sourceFields);
      if (
        Object.keys(sourceFields).length > 100 ||
        Object.entries(sourceFields).some(
          ([key, cell]) =>
            key.length > 200 || typeof cell !== 'string' || cell.length > 10000,
        )
      )
        invalid();
      const netMinor = integer(line.netMinor),
        taxMinor = nullableInteger(line.taxMinor),
        grossMinor = nullableInteger(line.grossMinor);
      if (taxMinor !== null && grossMinor !== null)
        sameAmount(netMinor, taxMinor, grossMinor);
      if (
        typeof line.description !== 'string' ||
        line.description.length > 10000
      )
        invalid();
      return {
        sourceKey,
        description: line.description,
        creditedLineId: nullableText(line.creditedLineId),
        netMinor,
        taxMinor,
        grossMinor,
        quantityText: nullableText(line.quantityText),
        unitRateText: nullableText(line.unitRateText),
        sourceFields: Object.fromEntries(
          Object.entries(sourceFields),
        ) as Record<string, string>,
      };
    });
    if (
      sum(lines.map((line) => line.netMinor)) !== netMinor ||
      (lines.every((line) => line.taxMinor !== null) &&
        sum(lines.map((line) => line.taxMinor as number)) !== taxMinor) ||
      (lines.every((line) => line.grossMinor !== null) &&
        sum(lines.map((line) => line.grossMinor as number)) !== grossMinor)
    )
      invalid();
    detail = { kind: 'lines', lines };
  } else invalid();
  const result: HistoricalSalesMoneyFacts = {
    currency,
    kind: value.kind as HistoricalSalesMoneyFacts['kind'],
    polarity: value.polarity as HistoricalSalesMoneyFacts['polarity'],
    netMinor,
    taxMinor,
    grossMinor,
    taxComponents,
    detail,
  };
  historicalSalesMagnitudes(result);
  return result;
}
