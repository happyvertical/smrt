import type { FormRetryStatus } from '@happyvertical/smrt-ui/form-retry';
import type { Snippet } from 'svelte';
import type { HTMLFormAttributes } from 'svelte/elements';
import type { Asset } from '../../asset.js';

/** Authorized display projection of an Asset; intentionally excludes sourceUri. */
export interface AssetAttachmentVersion
  extends Pick<Asset, 'name' | 'mimeType'> {
  /** Asset or owning attachment-join identity. */
  id: string;
  /** Existing Asset version number, when relevant to this workflow. */
  version?: Asset['version'];
  /** Caller-localized timestamp or other recorded-date description. */
  recordedAtLabel?: string;
  /** Caller-localized correction reason or other version detail. */
  note?: string;
  /** Server-authorized view endpoint; never a storage path. */
  viewHref?: string;
  /** Server-authorized download endpoint; may differ from the view URL. */
  downloadHref?: string;
}

/** An authorized attachment plus optional caller-ordered version history. */
export interface AssetAttachment extends AssetAttachmentVersion {
  /** Caller-localized status, including unknown or application-specific states. */
  statusLabel?: string;
  /** Earlier versions already authorized by the caller. No history is fetched. */
  versions?: readonly AssetAttachmentVersion[];
}

/** Native hidden request value, preserving repeated names and original identity. */
export interface AttachmentRequestField {
  /** Native field name. */
  name: string;
  /** Value forwarded without normalization or rotation. */
  value: string;
}

/** Authorized attachment listing with private links and version metadata. */
export interface AttachmentListProps {
  /** Authorized attachments in display order. */
  attachments: readonly AssetAttachment[];
  /** Optional caller-localized heading. */
  title?: string;
  /** Whether to display supplied version history. */
  showHistory?: boolean;
  /** Caller-localized load/error state. */
  message?: string;
  /** Loading presentation; existing items remain visible. */
  loading?: boolean;
}

/** Native private upload transport, owned and authorized by the consumer. */
export interface AttachmentUploadProps {
  /** Authorized endpoint; supplied by the consumer, never constructed here. */
  action: string;
  /** Optional stable form identity for enhancement. */
  id?: string;
  /** Presentation capability only. The endpoint must authorize each request. */
  canUpload?: boolean;
  /** File input name, default file. */
  fileField?: string;
  /** Description input name, default description. */
  descriptionField?: string;
  /** Caller-retained description, including values from rejected submissions. */
  description?: string;
  /** Native accept hint; server must independently validate bytes and policy. */
  accept?: string;
  /** Caller-localized allowed types/size/help. No upload policy is hardcoded. */
  help?: string;
  /** Caller field-level file validation error. */
  fileError?: string;
  /** Caller field-level description validation error. */
  descriptionError?: string;
  /** Caller server error or uncertain-outcome message. */
  message?: string;
  /** Re-render recovery needs a new file selection; browsers cannot restore files. */
  reselectFile?: boolean;
  /** Pending caller request; disables submit without changing values. */
  pending?: boolean;
  /** Optional state from caller-owned smrt-ui/form-retry. */
  retryStatus?: FormRetryStatus;
  /** Request/tenant/revision fields, kept verbatim and repeated as provided. */
  hiddenFields?: readonly AttachmentRequestField[];
  /** Native submitter name, default intent. */
  intentField?: string;
  /** Native submitter value, default upload. */
  intent?: string;
  /** Optional caller-localized upload label. */
  submitLabel?: string;
  /** Extra consumer fields inside the multipart form. */
  children?: Snippet;
  /** Optional enhancement; native navigation is the default. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
}

/** Attachment display with an optional, independently authorized upload form. */
export interface AttachmentPanelProps extends AttachmentListProps {
  /** Omit when uploads are unavailable. */
  upload?: AttachmentUploadProps;
}
