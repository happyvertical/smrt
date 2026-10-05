/** Browser-safe inventory view contracts. Hosts supply authorized data and callbacks. */
export interface StockLevelData {
  id?: string;
  skuId: string;
  locationId: string;
  state: string;
  qty: number;
  reorderPoint?: number | null;
  reorderQuantity?: number | null;
}
export interface StockMovementData {
  id?: string;
  skuId: string;
  locationId: string;
  qty: number;
  reasonCode: string;
  actorProfileId?: string | null;
  sourceType?: string;
  sourceId?: string;
  note?: string;
  occurredAt?: Date | string;
}
export interface InventoryLocationData {
  id?: string;
  code: string;
  name: string;
  kind: string;
  placeId?: string;
  active: boolean;
}
export interface StockAdjustmentInput {
  skuId: string;
  locationId: string;
  delta: number;
  reasonCode: string;
  note: string;
}
