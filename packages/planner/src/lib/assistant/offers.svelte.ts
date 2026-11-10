import type { LibraryCookbook } from '../library/types.ts';

export type OfferStatus =
  | 'pending'
  | 'applied'
  | 'declined'
  | 'replaced'
  | 'failed';

export interface Offer {
  id: string;
  cookbookId: string;
  status: OfferStatus;
  error: string;
}

/** What a chat message carries (`toolCallData`) to render its offer. */
export interface OfferRef {
  kind: 'cookbook-offer';
  offerId: string;
}

export const isOfferRef = (value: unknown): value is OfferRef =>
  !!value &&
  typeof value === 'object' &&
  (value as OfferRef).kind === 'cookbook-offer' &&
  typeof (value as OfferRef).offerId === 'string';

/** Applies a cookbook (the Cookbooks tab's path); returns an error or null. */
export type CookbookApplier = (cookbook: LibraryCookbook) => string | null;

/**
 * Cookbooks the assistant proposed. Applying one replaces the recipes, menu
 * and sample records, so an offer only ever applies from `accept`, which the
 * person's click calls. A newer offer replaces a pending one (latest wins).
 */
export class CookbookOffers {
  offers = $state<Record<string, Offer>>({});
  /** Set by the component that can reach the data source. */
  applier: CookbookApplier | null = null;
  private counter = 0;

  constructor(
    private readonly find: (id: string) => LibraryCookbook | undefined,
  ) {}

  pending(): Offer | undefined {
    return Object.values(this.offers).find((o) => o.status === 'pending');
  }

  /** Whether a cookbook is already applied or waiting for the person's click. */
  engaged(): boolean {
    return Object.values(this.offers).some(
      (o) => o.status === 'pending' || o.status === 'applied',
    );
  }

  /** Propose a cookbook. Returns null when the same one is already pending. */
  offer(cookbookId: string): OfferRef | null {
    const open = this.pending();
    if (open?.cookbookId === cookbookId) return null;
    if (open) open.status = 'replaced';
    const id = `offer-${++this.counter}`;
    this.offers[id] = { id, cookbookId, status: 'pending', error: '' };
    return { kind: 'cookbook-offer', offerId: id };
  }

  accept(offerId: string): void {
    const offer = this.offers[offerId];
    if (offer?.status !== 'pending') return;
    const cookbook = this.find(offer.cookbookId);
    const error = !cookbook
      ? 'Unknown cookbook.'
      : !this.applier
        ? 'Not ready yet.'
        : this.applier(cookbook);
    if (error || !cookbook) {
      offer.status = 'failed';
      offer.error = error ?? 'Could not set it up.';
      return;
    }
    offer.status = 'applied';
  }

  decline(offerId: string): void {
    const offer = this.offers[offerId];
    if (offer?.status === 'pending') offer.status = 'declined';
  }
}
