<script lang="ts">
import type {
  SmrtWebCollection,
  SmrtWebQueryTransport,
} from '@happyvertical/smrt-web';
import {
  type RemoteQueryBinding,
  remoteQuery,
} from '../remote-query.svelte.js';

interface Props {
  collection: SmrtWebCollection<Record<string, unknown>>;
  transport: SmrtWebQueryTransport;
  onReady: (view: RemoteQueryBinding<Record<string, unknown>>) => void;
}

const props: Props = $props();
// The harness intentionally creates one binding for its component lifetime.
// svelte-ignore state_referenced_locally
const view = remoteQuery(props.collection, props.transport);
// svelte-ignore state_referenced_locally
props.onReady(view);
</script>

<output data-testid="remote-query-state">
  {view.request?.requestId ?? 'none'}:{view.rows.map((row) => row.id).join(',')}
</output>
