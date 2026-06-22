/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular module/package dependencies reintroduce the peer fan-out and ' +
        'nominal-identity hazards behind happyvertical/smrt#1582. Break the cycle: ' +
        'extract a shared leaf, invert the edge, or use @crossPackageRef / registry ' +
        'indirection. (Tests are excluded below, so a test-only edge cannot trip this.)',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: ['\\.(spec|test|d)\\.ts$', '\\.svelte$', '/app/'],
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
