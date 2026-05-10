<script lang="ts">
import type {
  ContentGovernanceStateData,
  FactAuditStateData,
} from '../../mock-smrt-client';
import ContentGovernancePanel, {
  type ContentGovernancePanelSection,
} from './ContentGovernancePanel.svelte';

export type ContentGovernanceToolSection =
  | 'claimAudit'
  | 'facts'
  | 'reviews'
  | 'corrections'
  | 'versions'
  | 'transparency';

export interface Props {
  section: ContentGovernanceToolSection;
  apiBaseUrl?: string;
  contentId: string;
  onGovernanceStateChange?: (state: ContentGovernanceStateData | null) => void;
  onFactAuditChange?: (state: FactAuditStateData | null) => void;
}

let {
  section,
  apiBaseUrl = '/api/v1',
  contentId,
  onGovernanceStateChange = undefined,
  onFactAuditChange = undefined,
}: Props = $props();

const allPanelSections: ContentGovernancePanelSection[] = [
  'factAudit',
  'facts',
  'reviews',
  'transparency',
  'corrections',
  'versions',
];

const panelSection = $derived<ContentGovernancePanelSection>(
  section === 'claimAudit' ? 'factAudit' : section,
);
const hiddenSections = $derived(
  allPanelSections.filter((candidate) => candidate !== panelSection),
);
</script>

<ContentGovernancePanel
  {apiBaseUrl}
  {contentId}
  {hiddenSections}
  showFactCatalog={section === 'facts'}
  {onGovernanceStateChange}
  {onFactAuditChange}
/>
