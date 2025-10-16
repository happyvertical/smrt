import { SmrtCollection } from '../../../core/smrt/src';
import { AssetStatus } from './asset-status';
export declare class AssetStatusCollection extends SmrtCollection<AssetStatus> {
    static readonly _itemClass: typeof AssetStatus;
    /**
     * Get or create an asset status by slug
     *
     * @param slug - The asset status slug
     * @param name - The display name (defaults to slug)
     * @param description - Optional description
     * @returns The existing or newly created AssetStatus
     */
    getOrCreate(slug: string, name?: string, description?: string): Promise<AssetStatus>;
    /**
     * Initialize common asset statuses
     *
     * Creates standard asset statuses if they don't exist:
     * - draft
     * - published
     * - archived
     * - deleted
     */
    initializeCommonStatuses(): Promise<void>;
}
//# sourceMappingURL=asset-statuses.d.ts.map