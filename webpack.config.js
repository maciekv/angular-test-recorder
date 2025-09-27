const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
// webpack.config.js (after removing panel entries)
module.exports = {
  mode: 'production',
  entry: {
    background: './src/background.js',
    contentScript: './src/contentScript.js',
    devtools: './src/devtools.js'    // Removed panel entry
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js'
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [ { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ } ]
  },
  plugins: [
    new CopyPlugin({
      patterns: [
      { from: 'src/devtools.html', to: 'devtools.html' },
      { from: 'src/panel.js', to: 'panel.js' },
      { from: 'src/panel.html', to: 'panel.html' },
      { from: 'manifest.json', to: 'manifest.json' },
      { from: 'icon16.png', to: 'icon16.png' },
      { from: 'icon48.png', to: 'icon48.png' },
      { from: 'icon128.png', to: 'icon128.png' }
      ]
    })
  ]
};
