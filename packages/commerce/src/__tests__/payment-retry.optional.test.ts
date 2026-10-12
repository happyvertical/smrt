import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { paymentRetryContract } from './helpers/payment-retry.js';

paymentRetryContract(true, isPostgresAvailable());
