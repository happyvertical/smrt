/**
 * Types and error classes for operations, routing and the labour estimate.
 *
 * Strictly industry-neutral.
 *
 * @packageDocumentation
 */

import type { Operation } from './models/Operation.js';

/**
 * Callback that returns the hourly labour rate for an operation, in the bill's
 * currency, or `null` / `undefined` when no rate is known. The package holds no
 * rates: the caller decides where they come from (a price list, a rate class
 * the application keeps against the operation code, a timesheet rate). Mirrors
 * `ComponentCostResolver` for materials.
 */
export type OperationRateResolver = (
  operation: Operation,
) => Promise<number | null | undefined> | number | null | undefined;

/** One step of {@link LabourEstimate}. */
export interface RoutingStepEstimate {
  /** The routing step id. */
  stepId: string;
  /** Position in the routing, starting at 1. */
  sequence: number;
  /** Plain string id of the operation. */
  operationId: string;
  /** Operation code, or `''` if the operation row is missing. */
  operationCode: string;
  /** Operation name, or `''` if the operation row is missing. */
  operationName: string;
  /** Estimated working minutes per produced unit. */
  estimatedMinutes: number;
  /** Hourly rate from the resolver, or `0` when unavailable. */
  hourlyRate: number;
  /** `estimatedMinutes / 60 * hourlyRate`; `0` when the rate is unavailable. */
  stepCost: number;
  /** `true` when no resolver was supplied or it returned no rate. */
  rateUnavailable: boolean;
}

/**
 * Estimated labour per produced unit, returned by
 * `BomService.computeLabourEstimate`. A bill with no routing returns an empty
 * `steps` array and zero totals.
 */
export interface LabourEstimate {
  /** The bill that was rolled up. */
  bomId: string;
  /** `true` when the bill has at least one routing step. */
  hasRouting: boolean;
  /** Total estimated working minutes per produced unit. */
  totalMinutes: number;
  /** Total estimated labour cost per unit; counts only steps with a rate. */
  totalCost: number;
  /** ISO 4217 currency code of the bill. */
  currency: string;
  /** Steps in routing order. */
  steps: RoutingStepEstimate[];
  /** `true` when a step's rate was unavailable, so `totalCost` is a lower bound. */
  hasMissingRates: boolean;
}

/** One step handed to `RoutingService.replaceRouting`. */
export interface RoutingStepInput {
  /** Plain string id of the operation to perform. */
  operationId: string;
  /** Estimated working minutes per produced unit; zero or more. */
  estimatedMinutes: number;
  /** Optional free-form note. */
  notes?: string;
}

/** Input for `OperationService.define`. */
export interface DefineOperationInput {
  /** Unique per tenant; not changed afterwards. */
  code: string;
  name: string;
  category?: string;
  /** Plain string id of a `smrt-human-resources` qualification definition. */
  requiredQualificationId?: string;
}

/** Thrown when an operation id does not exist. */
export class OperationNotFoundError extends Error {
  override name = 'OperationNotFoundError';

  constructor(public readonly operationId: string) {
    super(`Operation not found: ${operationId}`);
  }
}

/** Thrown when defining an operation whose code is already in use. */
export class DuplicateOperationCodeError extends Error {
  override name = 'DuplicateOperationCodeError';

  constructor(public readonly code: string) {
    super(`An operation with code "${code}" already exists.`);
  }
}

/** Thrown when a routing would newly add a retired operation. */
export class OperationRetiredError extends Error {
  override name = 'OperationRetiredError';

  constructor(public readonly operationId: string) {
    super(
      `Operation ${operationId} is retired and cannot be added to a routing.`,
    );
  }
}

/** Thrown for invalid operation or routing input. */
export class InvalidOperationInputError extends Error {
  override name = 'InvalidOperationInputError';
}
