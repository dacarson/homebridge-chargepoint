// Shim — Config UI X looks for homebridge-ui/server.js at runtime.
// The real implementation is compiled to dist/homebridge-ui/server.js.
module.exports = require('../dist/homebridge-ui/server');
