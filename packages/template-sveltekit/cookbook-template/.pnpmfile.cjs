module.exports = { hooks: { updateConfig(config) {
  if (!process.env.SMRT_ROOT) return config;
  return require(`${process.env.SMRT_ROOT}/packages/cli/scripts/source-checkout.cjs`)
    .configureLocalSmrt(config, __dirname, process.env.SMRT_ROOT);
} } };
