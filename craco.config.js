const SassResourcesLoader = require('craco-sass-resources-loader')

module.exports = {
  eslint: {
    enable: false,
    model: 'file',
  },
  plugins: [
    {
      plugin: SassResourcesLoader,
      options: {
        resources: './src/assets/css/vs.scss',
      },
    },
  ],
}
