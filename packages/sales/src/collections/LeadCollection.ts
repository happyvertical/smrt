import { SmrtCollection } from '@happyvertical/smrt-core';
import { Lead } from '../models/Lead.js';

export class LeadCollection extends SmrtCollection<Lead> {
  static readonly _itemClass = Lead;

  async findByOwner(ownerId: string): Promise<Lead[]> {
    return this.list({ where: { ownerId } });
  }

  async findByEmail(email: string): Promise<Lead[]> {
    return this.list({ where: { email } });
  }

  async findActive(): Promise<Lead[]> {
    return this.list({
      where: { 'status in': ['new', 'qualified', 'converted'] },
    });
  }

  async findMergedInto(targetLeadId: string): Promise<Lead[]> {
    return this.list({ where: { mergedIntoLeadId: targetLeadId } });
  }
}
