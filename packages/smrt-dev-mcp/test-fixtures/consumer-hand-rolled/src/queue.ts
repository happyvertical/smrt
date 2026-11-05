import { Queue } from 'bullmq';

export const reportQueue = new Queue('reports');

export async function enqueueReport(id: string) {
  await reportQueue.add('render', { id });
}
