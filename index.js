// Canonical public entry (package.json "main").
// Single facade: everything from src/index.js plus observability wiring.
const core = require('./src/index');
const { attachObservability } = require('./packages/observability');

module.exports = { ...core, attachObservability };
