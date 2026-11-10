export default {
  runtime: { profile: 'local' },
  consumer: {
    packages: [
      '@happyvertical/smrt-profiles',
      '@happyvertical/smrt-tenancy',
      '@happyvertical/smrt-users',
    ],
  },
  knowledge: { enabled: false },
};
