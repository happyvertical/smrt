export interface SalesLeadListItem {
  id: string;
  name: string;
  email?: string;
  organization?: string;
  ownerName?: string | null;
  status: string;
  qualificationSummary?: string;
}

export interface SalesPipelineStageView {
  id: string;
  key: string;
  name: string;
  terminal?: boolean;
  outcome?: string;
}

export interface SalesBoardOpportunity {
  id: string;
  name: string;
  ownerName?: string | null;
  stageId: string;
  stageKey?: string;
  expectedValue: number;
  currency?: string;
  nextAction?: string;
  outcome?: string;
}

export interface SalesActivityView {
  id: string;
  type: string;
  summary: string;
  occurredAt: string;
  actorName?: string | null;
}

export interface SalesAcquisitionView {
  source: string;
  occurredAt: string;
  campaign?: string;
}

export interface SalesDetailRecord {
  lead: SalesLeadListItem;
  ownerName?: string | null;
  opportunity?: {
    id: string;
    name: string;
    stageId: string;
    stageName: string;
    stageKey?: string;
    expectedValue: number;
    currency?: string;
    nextAction?: string;
    outcome?: string;
  } | null;
  acquisitions?: SalesAcquisitionView[];
  activities?: SalesActivityView[];
  outcomes?: string[];
}
