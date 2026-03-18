const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Enable package.json "exports" field resolution so three.js
// examples/jsm paths and three-stdlib resolve correctly in Metro.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
