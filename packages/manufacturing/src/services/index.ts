/**
 * Service exports for `@happyvertical/smrt-manufacturing`.
 *
 * @packageDocumentation
 */

export {
  BomService,
  type BomServiceOptions,
  type ComponentCostResolver,
  createBomService,
} from './BomService.js';
export {
  type InstalledManufacturingDispatchHandlers,
  type InstallManufacturingDispatchHandlersOptions,
  installManufacturingDispatchHandlers,
  type ProductionOrderCompletedPayload,
  type ProductionOrderPostedPayload,
} from './dispatch-handlers.js';
export {
  type ConsumeMaterialsOptions,
  type ConsumeResult,
  createProductionService,
  type ProduceFinishedGoodsOptions,
  type ProduceResult,
  type ProductionOrderRef,
  ProductionService,
  type ProductionServiceOptions,
} from './ProductionService.js';
