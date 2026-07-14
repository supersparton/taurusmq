// tests/check-redis.js
const Redis = require('ioredis');
const client = new Redis('redis://127.0.0.1:6379');

async function check() {
  console.log('=== Redis State Inspection ===');
  const keys = await client.keys('taurusmq:*');
  console.log('Total keys:', keys.length);
  console.log('Keys list:', keys);

  await client.quit();
}

check().catch(console.error);
