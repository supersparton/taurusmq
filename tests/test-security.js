// test-security.js
// Integration test suite verifying:
// 1. Password hashing & heap clearance in SetupManager.
// 2. Custom header and Origin CSRF checks on mutating endpoints.
// 3. Redis-backed IP rate limiter on login route.
// 4. Removal of exposed JWT secret key from Settings response.
// 5. CORS preflight rejection of disallowed origins.

'use strict';

// Setup mock process env vars for testing BEFORE imports
process.env.TAURUSMQ_USERNAME = 'secadmin';
process.env.TAURUSMQ_PASSWORD = 'secpassword123';
delete process.env.TAURUSMQ_JWT_SECRET;
process.env.NODE_ENV = 'development';
process.env.OBS_ALLOWED_ORIGINS = 'http://trusted.com';

const assert = require('assert');
const http = require('http');
const Redis = require('ioredis');
const { SetupManager } = require('../packages/observability-core/SetupManager');
const { startObservabilityStack, server } = require('../packages/dashboard-api/server');

const PORT = 4050;

async function request(options, postData = '') {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ res, body }));
    });
    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING SECURITY INTEGRATION TESTS ---');

  // Test 1: SetupManager credential safety
  console.log('TEST 1: Verifying credential memory safety (no plaintext password stored)...');
  const setup = new SetupManager(__dirname);
  const creds = await setup.setup();
  
  assert.strictEqual(setup.username, 'secadmin');
  assert.strictEqual(setup.passwordPlain, null, 'Plain password must be cleared from memory');
  assert.ok(setup.passwordHash, 'Password must be hashed in SetupManager');
  assert.ok(creds.jwtSecret, 'JWT secret should be dynamically generated');
  
  const valid = await setup.verifyPassword('secpassword123');
  assert.strictEqual(valid, true, 'Should verify correct password');
  
  const invalid = await setup.verifyPassword('wrongpassword');
  assert.strictEqual(invalid, false, 'Should reject incorrect password');
  console.log('✅ TEST 1 PASSED: Credentials hashed and cleared from memory');

  // Start the server with a test Redis instance
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const testRedis = new Redis(redisUrl);
  await testRedis.flushall(); // start clean

  const stack = await startObservabilityStack(['test-queue'], setup, creds.jwtSecret, PORT);

  try {
    // Test 2: CORS Preflight Rejection
    console.log('TEST 2: Verifying CORS preflight...');
    // Disallowed origin preflight
    const optRes1 = await request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/queues',
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://malicious.com'
      }
    });
    assert.strictEqual(optRes1.res.statusCode, 400, 'OPTIONS from disallowed origin must be rejected with 400');
    assert.ok(!optRes1.res.headers['access-control-allow-origin'], 'Must not return Access-Control-Allow-Origin header');

    // Allowed origin preflight
    const optRes2 = await request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/queues',
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://trusted.com'
      }
    });
    assert.strictEqual(optRes2.res.statusCode, 204, 'OPTIONS from trusted origin must return 204');
    assert.strictEqual(optRes2.res.headers['access-control-allow-origin'], 'http://trusted.com');
    assert.strictEqual(optRes2.res.headers['access-control-allow-headers'], 'Content-Type, X-TaurusMQ-CSRF, X-Requested-With');
    console.log('✅ TEST 2 PASSED: CORS preflight successfully restricts access');

    // Test 3: Log in to get token
    console.log('TEST 3: Logging in and obtaining HTTP JWT cookie...');
    const loginRes = await request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({ username: 'secadmin', password: 'secpassword123' }));
    
    assert.strictEqual(loginRes.res.statusCode, 200);
    const cookieHeader = loginRes.res.headers['set-cookie'];
    assert.ok(cookieHeader && cookieHeader[0].includes('tmq_token='), 'Must set tmq_token cookie');
    const tokenCookie = cookieHeader[0].split(';')[0];
    console.log('✅ TEST 3 PASSED: Successful authentication cookie obtained');

    // Test 4: Settings Response verification
    console.log('TEST 4: Verifying GET /api/settings does not expose JWT secret key...');
    const settingsRes = await request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/settings',
      method: 'GET',
      headers: { 'Cookie': tokenCookie }
    });
    assert.strictEqual(settingsRes.res.statusCode, 200);
    const settings = JSON.parse(settingsRes.body);
    assert.strictEqual(settings.secretKey, undefined, 'Must not expose secretKey in response');
    console.log('✅ TEST 4 PASSED: secretKey is not leaked in GET /api/settings');

    // Test 5: CSRF blocking on mutating routes
    console.log('TEST 5: Verifying CSRF validation on POST requests...');
    // Attempt mutating action (pause-retries) WITHOUT custom header
    const csrfRes1 = await request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/queues/test-queue/actions/pause-retries',
      method: 'POST',
      headers: { 'Cookie': tokenCookie }
    });
    assert.strictEqual(csrfRes1.res.statusCode, 403, 'POST without custom header must return 403');
    assert.ok(csrfRes1.body.includes('CSRF validation failed'), 'Should return CSRF failure reason');

    // Attempt mutating action with untrusted Origin header
    const csrfRes2 = await request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/queues/test-queue/actions/pause-retries',
      method: 'POST',
      headers: {
        'Cookie': tokenCookie,
        'X-TaurusMQ-CSRF': '1',
        'Origin': 'http://malicious.com'
      }
    });
    assert.strictEqual(csrfRes2.res.statusCode, 403, 'POST with untrusted Origin must return 403');

    // Attempt mutating action WITH trusted Origin and custom CSRF header
    const csrfRes3 = await request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/queues/test-queue/actions/pause-retries',
      method: 'POST',
      headers: {
        'Cookie': tokenCookie,
        'X-TaurusMQ-CSRF': '1',
        'Origin': 'http://trusted.com'
      }
    });
    assert.strictEqual(csrfRes3.res.statusCode, 200, 'POST with custom header & trusted origin must return 200');
    console.log('✅ TEST 5 PASSED: CSRF validation blocks insecure requests');

    // Test 6: Rate Limiting
    console.log('TEST 6: Verifying Rate Limiting on authentication endpoint...');
    // We already made 1 successful login request. Let's make 5 more to trigger rate-limiting (max 5 per minute)
    let rateLimited = false;
    for (let i = 0; i < 6; i++) {
      const resData = await request({
        hostname: '127.0.0.1',
        port: PORT,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ username: 'secadmin', password: 'secpassword123' }));
      
      if (resData.res.statusCode === 429) {
        rateLimited = true;
        assert.ok(resData.res.headers['retry-after'], 'Should return Retry-After header');
        assert.ok(resData.body.includes('Too many login attempts'), 'Should return rate-limited error message');
        break;
      }
    }
    assert.ok(rateLimited, 'Authentication endpoint must be rate-limited after 5 requests/min');
    console.log('✅ TEST 6 PASSED: Rate limiter successfully throttles brute-force attempts');

  } finally {
    // Cleanup and close servers
    server.close();
    await testRedis.quit();
  }

  console.log('\n🎉 ALL SECURITY INTEGRATION TESTS PASSED CLEANLY! 🎉');
}

runTests().catch(err => {
  console.error('❌ SECURITY TEST SUITE FAILED:', err);
  process.exit(1);
});
