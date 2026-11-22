/**
 * Dispatch routing predicate (internal).
 *
 * A row R is eligible for subscriber S iff there EXISTS one enabled
 * subscription s of S such that `s` matches `R.type` and either
 * `R.target_subscriber IS NULL AND s.delivery = 'compete'` or
 * `R.target_subscriber = S`.
 *
 * The decision never depends on which matching subscription is looked at
 * first: a subscriber holding both a fanout and a compete subscription that
 * match a type receives its targeted copies and the shared compete row.
 */

import type { DispatchSubscription } from './models/DispatchSubscription.js';

/** The row fields the routing decision reads. */
export interface RoutableDispatch {
  type: string;
  targetSubscriber: string | null;
}

/**
 * Whether `dispatch` is routed to `subscriber` by any of `subscriptions`
 * (the subscriber's own subscriptions, as loaded for the active scope).
 */
export function isDispatchRoutedTo(
  dispatch: RoutableDispatch,
  subscriber: string,
  subscriptions: readonly DispatchSubscription[],
): boolean {
  const targeted = dispatch.targetSubscriber !== null;
  if (targeted && dispatch.targetSubscriber !== subscriber) {
    return false;
  }
  return subscriptions.some(
    (sub) =>
      (targeted || sub.delivery === 'compete') && sub.matches(dispatch.type),
  );
}
