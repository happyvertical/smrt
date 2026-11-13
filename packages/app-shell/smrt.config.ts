export default {
  runtime: { profile: 'local' },
  consumer: {
    packages: [
      '@happyvertical/smrt-inference',
      '@happyvertical/smrt-preferences',
      '@happyvertical/smrt-profiles',
      '@happyvertical/smrt-secrets',
      '@happyvertical/smrt-tenancy',
      '@happyvertical/smrt-users',
    ],
  },
  knowledge: { enabled: false },
};
