import { ListRegisteredObjectsInput, RegisteredObjectInfo } from '../types.js';
/**
 * List registered objects with metadata
 */
export declare function listRegisteredObjects(input?: ListRegisteredObjectsInput): Promise<{
    objects: RegisteredObjectInfo[];
    total: number;
}>;
//# sourceMappingURL=list-registered-objects.d.ts.map