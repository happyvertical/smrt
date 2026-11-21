export default {
  runtime: { profile: 'local' },
  consumer: {
    packages: [
      '@happyvertical/smrt-features',
      '@happyvertical/smrt-inference',
      '@happyvertical/smrt-jobs',
      '@happyvertical/smrt-preferences',
      '@happyvertical/smrt-profiles',
      '@happyvertical/smrt-secrets',
      '@happyvertical/smrt-subscriptions',
      '@happyvertical/smrt-tenancy',
      '@happyvertical/smrt-users',
    ],
  },
  knowledge: { enabled: false },
};
