/**
 * Store-only write capability for `UiPreferenceRecord` (#3727).
 *
 * A preference payload is only meaningful after its kind validated it, and
 * only the store runs the validator. So the model refuses every insert,
 * update and delete that the store did not grant: an insert carries
 * {@link STORE_WRITE} as a constructor option (a symbol key never arrives
 * from JSON), and an update or delete is granted per instance just before
 * the store calls `save()` / `delete()`. A write grant is bound to the exact
 * `payloadJson` the store validated, and every grant is single-use.
 *
 * Not part of the package's public exports (the smrt-approvals
 * `write-capability.ts` pattern). This guards in-process callers of the
 * model and collection; it is not a defence against raw SQL.
 *
 * @internal
 * @packageDocumentation
 */

/** Constructor-option key carrying the capability. Never exported publicly. */
export const STORE_WRITE = Symbol('smrt-preferences.storeWrite');

/** The only value accepted under {@link STORE_WRITE}. */
const TOKEN = Object.freeze({ capability: 'smrt-preferences.storeWrite' });

/** Granted writes: the payload the store validated for each instance. */
const writes = new WeakMap<object, string>();

/** Granted deletes. */
const deletes = new WeakSet<object>();

/** Constructor options fragment that grants an insert of `payloadJson`. */
export function storeWriteOption(): { [STORE_WRITE]: object } {
  return { [STORE_WRITE]: TOKEN };
}

/** Record an insert grant when the constructor options carry the token. */
export function adoptStoreWrite(instance: object, options: unknown): void {
  if (
    options &&
    typeof options === 'object' &&
    (options as Record<symbol, unknown>)[STORE_WRITE] === TOKEN &&
    typeof (options as { payloadJson?: unknown }).payloadJson === 'string'
  ) {
    writes.set(instance, (options as { payloadJson: string }).payloadJson);
  }
}

/** Grant one save of `instance` with its current, validated payload. */
export function grantStoreWrite(instance: { payloadJson: string }): void {
  writes.set(instance, instance.payloadJson);
}

/** Grant one delete of `instance`. */
export function grantStoreDelete(instance: object): void {
  deletes.add(instance);
}

/** Whether a save of `instance` with `payloadJson` was granted. */
export function hasStoreWrite(instance: object, payloadJson: string): boolean {
  return writes.get(instance) === payloadJson;
}

/** Spend the save grant of `instance`. */
export function spendStoreWrite(instance: object): void {
  writes.delete(instance);
}

/** Spend the delete grant of `instance`; false when there was none. */
export function takeStoreDelete(instance: object): boolean {
  return deletes.delete(instance);
}
