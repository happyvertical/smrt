export interface DevelopmentRequestView {
  id: string;
  title?: string;
  description: string;
  type: string;
  status: string;
  deliveryStatus?: string;
  visibility?: string;
  requesterLabel?: string;
  submittedAt?: Date | string;
}
export interface DeliveryEventView {
  id: string;
  sequence: number;
  type: string;
  label?: string;
  occurredAt: Date | string;
  detail?: string;
}
export interface PreviewApprovalView {
  id: string;
  previewId: string;
  previewUrl?: string;
  status: string;
}
export interface ServiceEvidenceView {
  id: string;
  context: string;
  participant: string;
  durationSeconds: number;
  status: string;
  chargeAmount?: number;
  compensationAmount?: number;
  currency?: string;
}
