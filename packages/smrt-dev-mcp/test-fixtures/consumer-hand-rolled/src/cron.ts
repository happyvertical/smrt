import cron from 'node-cron';

export function startNightlySync(run: () => Promise<void>) {
  cron.schedule('0 3 * * *', () => {
    void run();
  });
}
