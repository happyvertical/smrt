import type { DatabaseInterface } from '@happyvertical/sql';
import type { HandlerContext } from './execution-contracts.js';

// Package-internal transaction bridge. Neither symbol is a public package export.
export const discoveryTransaction = Symbol('ingestion.discoveryTransaction');
export const generationSnapshotRead = Symbol(
  'ingestion.generationSnapshotRead',
);
export type TransactionRunner<T> = (
  work: (db: DatabaseInterface) => Promise<T>,
) => Promise<T>;
export type DiscoveryGate = <T>(
  handlerId: string,
  handlerVersion: string,
  work: (
    context: HandlerContext,
    currentTarget: (model: string, id: string) => Promise<{ revision: string }>,
  ) => Promise<T>,
) => Promise<T>;
