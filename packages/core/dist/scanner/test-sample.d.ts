import { SmrtObject } from '../object';
declare class Content extends SmrtObject {
    title: string;
    body?: string;
    status: string;
    published: boolean;
    category: string;
    tags: string[];
    generateSummary(maxLength: number): Promise<string>;
    static findByCategory(_category: string): never[];
}
declare class Category extends SmrtObject {
    name: string;
    description?: string;
    active: boolean;
    constructor(options: any);
}
declare class TestAgent extends SmrtObject {
    name: string;
    source: string;
    lastSynced?: Date;
    research(options?: any): Promise<any>;
    report(options?: any): Promise<any>;
    analyze(options?: any): Promise<any>;
}
export { Content, Category, TestAgent };
//# sourceMappingURL=test-sample.d.ts.map