/**
 * Provider-neutral agreement signature orchestration and immutable evidence.
 *
 * Provider adapters come from `@happyvertical/signatures`; this module owns
 * tenant-scoped lifecycle, verified-event ingestion, Asset-backed evidence,
 * idempotency, reconciliation, and versioned executed-agreement records.
 *
 * @packageDocumentation
 */

export { AgreementExecutionCollection } from './collections/AgreementExecutionCollection.js';
export { AgreementExecutionEventCollection } from './collections/AgreementExecutionEventCollection.js';
export { ExecutedAgreementCollection } from './collections/ExecutedAgreementCollection.js';
export { AgreementExecution } from './models/AgreementExecution.js';
export { AgreementExecutionEvent } from './models/AgreementExecutionEvent.js';
export { ExecutedAgreement } from './models/ExecutedAgreement.js';
export {
  type AdoptAgreementProviderRequestInput,
  type AgreementExecutionOperationInput,
  AgreementExecutionService,
  type AgreementExecutionServiceDeps,
  type CancelAgreementExecutionInput,
  type ExtendAgreementExecutionInput,
} from './services/AgreementExecutionService.js';
export * from './types.js';
