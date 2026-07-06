// packages/observability-core/SetupManager.js
//
// Responsibility: Manage credentials and configuration in memory.
//
// In v2, this module does NOT create any files or folders on disk (e.g. .taurusmq/).
// Instead, it relies on either Environment Variables or explicit parameters
// passed at application runtime.
//

'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

class SetupManager {
  /**
   * @param {string} projectRoot  - absolute path to the user's project root
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.jwtSecret = null;
    this.username = null;
    this.passwordHash = null;
    this.passwordPlain = null;
  }

  /**
   * Initialize dashboard credentials in memory.
   *
   * @returns {{ jwtSecret: string, username: string, project: string }}
   */
  async setup() {
    if (process.env.TAURUSMQ_AUTH_DISABLED === 'true') {
      this.jwtSecret = process.env.TAURUSMQ_JWT_SECRET || 'disabled-secret-key-12345';
      this.username = 'anonymous';
      console.log('[obs] TaurusMQ Dashboard Authentication is DISABLED (TAURUSMQ_AUTH_DISABLED=true)');
      return { jwtSecret: this.jwtSecret, username: this.username, project: 'local' };
    }

    // 1. Check environment variables
    const envUsername = process.env.TAURUSMQ_USERNAME;
    const envPassword = process.env.TAURUSMQ_PASSWORD;
    const envSecret = process.env.TAURUSMQ_JWT_SECRET;

    if (envUsername && envPassword) {
      this.username = envUsername;
      // Hash password immediately to clear it from heap memory
      this.passwordHash = await bcrypt.hash(envPassword, 10);
      this.passwordPlain = null;
      if (!envSecret) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error('[TaurusMQ Error] TAURUSMQ_JWT_SECRET environment variable is required in production.');
        }
        // Generate secure dynamic random JWT secret
        this.jwtSecret = crypto.randomBytes(32).toString('hex');
      } else {
        this.jwtSecret = envSecret;
      }
      console.log('[obs] Credentials loaded from Environment Variables');
      console.log(`[obs] Dashboard user: ${this.username}`);
      return { jwtSecret: this.jwtSecret, username: this.username, project: 'local' };
    }

    // 2. No configuration provided — throw a clear setup error
    throw new Error(
      '\n[TaurusMQ Error] Dashboard authentication is not configured.\n' +
      'Please configure credentials using one of the following methods:\n' +
      '  1. Set environment variables:\n' +
      '     $env:TAURUSMQ_USERNAME="admin"\n' +
      '     $env:TAURUSMQ_PASSWORD="yoursecurepassword"\n' +
      '     $env:TAURUSMQ_JWT_SECRET="your-jwt-secret-key" (optional, but recommended for production)\n' +
      '  2. Disable authentication (for local development only):\n' +
      '     $env:TAURUSMQ_AUTH_DISABLED="true"\n'
    );
  }

  /**
   * Load current credentials (called on server start).
   */
  load() {
    return {
      jwtSecret: this.jwtSecret,
      username: this.username,
      project: 'local',
    };
  }

  /**
   * Verify a plaintext password.
   * @param {string} plaintext
   * @returns {Promise<boolean>}
   */
  async verifyPassword(plaintext) {
    if (process.env.TAURUSMQ_AUTH_DISABLED === 'true') {
      return true;
    }
    if (this.passwordPlain) {
      return plaintext === this.passwordPlain;
    }
    if (this.passwordHash) {
      return bcrypt.compare(plaintext, this.passwordHash);
    }
    return false;
  }
}

module.exports = { SetupManager };
