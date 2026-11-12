// Probe for run-with-env.test.mjs: exits 0 only when the helper set the variable.
process.exit(process.env.RUN_WITH_ENV_PROBE === 'yes' ? 0 : 3);
