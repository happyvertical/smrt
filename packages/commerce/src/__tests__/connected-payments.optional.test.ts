/** Tenant-owned connected payment accounts (#3831), PostgreSQL lane. */
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { connectedPaymentsContract } from './helpers/connected-payments-contract.js';

connectedPaymentsContract(true, isPostgresAvailable());
