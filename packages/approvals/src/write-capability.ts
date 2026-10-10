/**
 * Service-only write capability for approval requests and events.
 *
 * `ApprovalRequest` and `ApprovalEvent` rows are inserted only by
 * `ApprovalService`. The service passes {@link SERVICE_WRITE} as a
 * constructor option; the models record the instance here and refuse any
 * insert that does not carry it. A symbol key can never arrive from JSON
 * (REST body, MCP tool arguments) and this module is not part of the
 * package's public exports, so `new ApprovalRequest({ status: 'approved' })`,
 * `ApprovalRequestCollection.create(...)`, or a forged `approved` event are
 * all refused at the model layer (the `runtime-report.ts` pattern in
 * smrt-reports). This is an in-process API guard, not a defence against raw
 * SQL; `consume()` additionally re-checks the ledger.
 *
 * @internal
 * @packageDocumentation
 */

/** Constructor-option key carrying the capability. Never exported publicly. */
export const SERVICE_WRITE = Symbol('smrt-approvals.serviceWrite');

/** The only value accepted under {@link SERVICE_WRITE}. */
const TOKEN = Object.freeze({ capability: 'smrt-approvals.serviceWrite' });

/** Instances the service minted for exactly one insert. */
const minted = new WeakSet<object>();

/** Constructor options fragment that grants the capability. */
export function serviceWriteOption(): { [SERVICE_WRITE]: object } {
  return { [SERVICE_WRITE]: TOKEN };
}

/** Record `instance` as service-minted when its options carry the token. */
export function adoptServiceWrite(instance: object, options: unknown): void {
  if (
    options &&
    typeof options === 'object' &&
    (options as Record<symbol, unknown>)[SERVICE_WRITE] === TOKEN
  ) {
    minted.add(instance);
  }
}

/** Whether `instance` was minted by the service for insertion. */
export function hasServiceWrite(instance: object): boolean {
  return minted.has(instance);
}
