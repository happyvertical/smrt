<script lang="ts">
import * as Jobs from '@happyvertical/smrt-jobs/svelte';
import { JobStats, type JobStatsData, type JobStatsProps } from '@happyvertical/smrt-jobs/svelte';

const stats: JobStatsData = {
  total: 0, pending: 0, ready: 0, running: 0, completed: 0,
  failed: 0, cancelled: 0, avgDuration: null, successRate: null,
};
const props: JobStatsProps = { stats };
// @ts-expect-error A stats object must include all counters.
const missingCounters: JobStatsProps = { stats: { total: 0 } };
// @ts-expect-error Counters must remain numeric.
const invalidCounter: JobStatsProps = { stats: { ...stats, total: 'zero' } };
</script>

<Jobs.JobStats {stats} />
<JobStats {...props} />
