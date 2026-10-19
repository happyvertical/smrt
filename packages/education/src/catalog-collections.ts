import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  CatalogAcquisition,
  CatalogProvider,
  CatalogResource,
  CatalogSelection,
  CatalogSyncState,
} from './catalog-models.js';

export class CatalogProviderCollection extends SmrtCollection<CatalogProvider> {
  static readonly _itemClass = CatalogProvider;
}
export class CatalogResourceCollection extends SmrtCollection<CatalogResource> {
  static readonly _itemClass = CatalogResource;
}
export class CatalogSyncStateCollection extends SmrtCollection<CatalogSyncState> {
  static readonly _itemClass = CatalogSyncState;
}
export class CatalogSelectionCollection extends SmrtCollection<CatalogSelection> {
  static readonly _itemClass = CatalogSelection;
}
export class CatalogAcquisitionCollection extends SmrtCollection<CatalogAcquisition> {
  static readonly _itemClass = CatalogAcquisition;
}
