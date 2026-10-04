/**
 * RoutingStepCollection — query helpers for {@link RoutingStep} rows.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { RoutingStep } from '../models/RoutingStep.js';

export class RoutingStepCollection extends SmrtCollection<RoutingStep> {
  static readonly _itemClass = RoutingStep;

  /** Return the routing of a bill in step order; empty when it has none. */
  async findByBom(bomId: string): Promise<RoutingStep[]> {
    return this.list({ where: { bomId }, orderBy: 'sequence ASC' });
  }

  /** Return every step that uses the given operation, across bills. */
  async findByOperation(operationId: string): Promise<RoutingStep[]> {
    return this.list({ where: { operationId }, orderBy: 'bomId ASC' });
  }
}
