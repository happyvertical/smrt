/**
 * BTCPay Server as a crypto payment rail (#3138): sugar over
 * {@link createCryptoBillingProvider} with the SDK's BTCPay checkout gateway.
 * One BTCPay store per seller; keys and secrets come from the host's secret
 * store, never from this package.
 */
import {
  BtcpayClient,
  type BtcpayClientOptions,
  type BtcpaySpeedPolicy,
  createBtcpayCheckoutGateway,
} from '@happyvertical/payments/btcpay';
import { createCryptoBillingProvider } from './crypto.js';
import type { BillingProvider } from './provider.js';

export interface BtcPayBillingProviderOptions {
  /** Server origin, for example `https://btcpay.example.com`. */
  baseUrl: string;
  /** Store-scoped key: `canviewinvoices` + `cancreateinvoice` suffice. */
  apiKey: string;
  storeId: string;
  /** The store webhook's secret. */
  webhookSecret: string;
  /** Secret signing the `smrt_*` checkout metadata. */
  metadataSecret: string;
  /**
   * Confirmations before BTCPay settles on-chain: `HighSpeed` 0,
   * `MediumSpeed` 1, `LowMediumSpeed` 2, `LowSpeed` 6 (default — BTCPay has
   * no 3-confirmation policy, and 6 never settles on fewer).
   */
  speedPolicy?: BtcpaySpeedPolicy;
  /** Default `['BTC-CHAIN']`; add `BTC-LN` once the store has Lightning. */
  paymentMethods?: string[];
  expirationMinutes?: number;
  monitoringMinutes?: number;
  /** BTCPay's own underpayment tolerance, percent (default 0). */
  paymentTolerance?: number;
  /** Label of the store's rate source, recorded on every payment. */
  rateSource?: string;
  /** Minimum checkout per currency, minor units. */
  minimumAmount?: Record<string, number>;
  /** Provider name (default `btcpay`). */
  name?: string;
  fetch?: BtcpayClientOptions['fetch'];
}

export function createBtcPayBillingProvider(
  options: BtcPayBillingProviderOptions,
): BillingProvider {
  const gateway = createBtcpayCheckoutGateway({
    client: new BtcpayClient({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      storeId: options.storeId,
      fetch: options.fetch,
    }),
    webhookSecret: options.webhookSecret,
    speedPolicy: options.speedPolicy ?? 'LowSpeed',
    paymentMethods: options.paymentMethods,
    expirationMinutes: options.expirationMinutes,
    monitoringMinutes: options.monitoringMinutes,
    paymentTolerance: options.paymentTolerance,
    rateSource: options.rateSource,
  });
  return createCryptoBillingProvider({
    gateway,
    metadataSecret: options.metadataSecret,
    name: options.name ?? 'btcpay',
    minimumAmount: options.minimumAmount,
  });
}
