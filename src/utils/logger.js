// src/utils/logger.js
// Injectable logger — default pino-compatible, silent in tests.

const noop = () => {};

const defaultLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
};

function createLogger(options = {}) {
    if (options.logger) return options.logger;
    if (options.silent) return defaultLogger;

    // Try to use pino if available, else fall back to console
    try {
        const pino = require('pino');
        return pino({ name: 'taurusmq', level: options.logLevel || 'info' });
    } catch (_) {
        // pino not installed — use console wrapper
        const level = options.logLevel || 'info';
        const levels = { error: 0, warn: 1, info: 2, debug: 3 };
        const configuredLevel = levels[level] ?? 2;

        return {
            error: (...args) => { if (configuredLevel >= 0) console.error('[TaurusMQ]', ...args); },
            warn:  (...args) => { if (configuredLevel >= 1) console.warn('[TaurusMQ]', ...args); },
            info:  (...args) => { if (configuredLevel >= 2) console.log('[TaurusMQ]', ...args); },
            debug: (...args) => { if (configuredLevel >= 3) console.log('[TaurusMQ]', ...args); },
        };
    }
}

module.exports = { createLogger };
