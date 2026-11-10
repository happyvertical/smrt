import type { Cookbook } from '../cookbook/types.ts';
import {
  type KitchenConfig,
  type KitchenEndpoint,
  type KitchenOutcome,
  sendToKitchen,
} from './client.ts';

export type KitchenStatus = 'idle' | 'sending' | 'sent' | 'failed';

/** Whether a kitchen is listening, and the state of the current send. */
export class KitchenState {
  /** Where the kitchen listens, from `planner.config.json`. */
  endpoint = $state<string | undefined>(undefined);
  /** An older CLI still puts its token in the config: never used, and sending is off. */
  tokenInConfig = $state(false);
  /** The one-time token, from the address's fragment. Memory only. */
  private token = $state<string | undefined>(undefined);
  status = $state<KitchenStatus>('idle');
  outcome = $state<KitchenOutcome | undefined>(undefined);

  /** A kitchen is listening and this page holds its token: sending is possible. */
  get config(): KitchenConfig | undefined {
    return this.endpoint && this.token && !this.tokenInConfig
      ? { endpoint: this.endpoint, token: this.token }
      : undefined;
  }

  /**
   * A kitchen is listening but this page was opened without its token (the
   * address had no `#kitchen=` fragment, or the page was reloaded after the
   * fragment was removed): the person needs the address `smrt kitchen` printed.
   */
  get needsLink(): boolean {
    return !!this.endpoint && !this.token && !this.tokenInConfig;
  }

  configure(config: KitchenEndpoint | undefined, token?: string): void {
    this.endpoint = config?.endpoint;
    this.tokenInConfig = config?.tokenInConfig === true;
    this.token = config ? token : undefined;
    this.status = 'idle';
    this.outcome = undefined;
  }

  async send(cookbook: Cookbook, fetcher?: typeof fetch): Promise<void> {
    const config = this.config;
    if (!config || this.status === 'sending') return;
    this.status = 'sending';
    this.outcome = undefined;
    const outcome = await sendToKitchen(config, cookbook, fetcher);
    this.outcome = outcome;
    this.status = outcome.ok ? 'sent' : 'failed';
  }
}

/** The app's one kitchen state, set from `planner.config.json`. */
export const kitchenState = new KitchenState();
