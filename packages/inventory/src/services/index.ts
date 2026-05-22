/**
 * Service exports for `@happyvertical/smrt-inventory`.
 *
 * @packageDocumentation
 */

export {
  type ContractCreatedLine,
  type ContractCreatedPayload,
  type FulfillmentShippedLine,
  type FulfillmentShippedPayload,
  type InstalledInventoryDispatchHandlers,
  type InstallInventoryDispatchHandlersOptions,
  installInventoryDispatchHandlers,
} from './dispatch-handlers.js';
export {
  createStockService,
  InsufficientStockError,
  type StockMutationOptions,
  StockService,
  type StockServiceOptions,
} from './StockService.js';
