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
  type AttachDocumentInput,
  createLotService,
  type LotChangeOptions,
  LotService,
  type LotServiceOptions,
  type ReceiveLotInput,
  type RecordUsageInput,
  type TraceNode,
  type TraceOptions,
} from './LotService.js';
export {
  DuplicateLotError,
  LotCorrectionError,
  LotInUseError,
  LotMismatchError,
  LotNotFoundError,
} from './lot-errors.js';
export {
  createStockService,
  InsufficientStockError,
  type StockMutationOptions,
  StockService,
  type StockServiceOptions,
} from './StockService.js';
