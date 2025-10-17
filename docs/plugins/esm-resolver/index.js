module.exports = (_context, _options) => ({
  name: 'esm-resolver',
  configureWebpack(_config, _isServer) {
    return {
      resolve: {
        fullySpecified: false,
      },
      module: {
        rules: [
          {
            test: /\.m?js$/,
            resolve: {
              fullySpecified: false,
            },
          },
        ],
      },
    };
  },
});
