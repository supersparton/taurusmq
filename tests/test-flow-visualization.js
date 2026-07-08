// tests/test-flow-visualization.js
//
// Real-data test script for TaurusMQ Redesigned Flow (DAG) Visualization.
// This script will:
//   1. Attach the live observability stack.
//   2. Create a unique parent-child tree using FlowProducer.
//   3. Wait for events to register.
//   4. Query GET /api/flows to verify the flow is listed.
//   5. Query GET /api/flows/:parentId to assert children references are resolved.
//   6. Query GET /api/flows/:childId to assert parent references are resolved.
//   7. Verify everything and exit.
//

'use strict';

const { Queue, Worker, Scheduler, FlowProducer } = require('../src/index');
const { attachObservability } = require('../packages/observability');
const redis = require('../src/utils/redis');
const http = require('http');

// Disable authentication verification for easy testing
process.env.TAURUSMQ_AUTH_DISABLED = 'true';

// Helper to make local HTTP requests
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('🚀 Starting Flow (DAG) Visualization Integration Test...');

  const parentQueueName = 'flow-test-parent-q';
  const childQueueName = 'flow-test-child-q';

  // Clean old Redis stats
  const keys = await redis.keys('taurusmq:*');
  const testKeys = keys.filter(k => k.includes(parentQueueName) || k.includes(childQueueName) || k.includes('dependent'));
  if (testKeys.length > 0) {
    await redis.del(...testKeys);
    console.log(`🧹 Cleaned ${testKeys.length} matching test keys in Redis`);
  }

  // 1. Attach Observability (starts Dashboard API on port 4000)
  await attachObservability({
    Queue,
    Worker,
    Scheduler,
    queues: [parentQueueName, childQueueName],
    port: 4000,
  });

  // 2. Add flow using FlowProducer
  const flowProducer = new FlowProducer();
  
  const flow = {
    name: 'root-parent-job',
    queueName: parentQueueName,
    data: { step: 'consolidate' },
    children: [
      { name: 'child-job-leaf-1', queueName: childQueueName, data: { value: 100 } },
      { name: 'child-job-leaf-2', queueName: childQueueName, data: { value: 200 } }
    ]
  };

  console.log('📤 Submitting DAG flow via FlowProducer...');
  const parentJobId = await flowProducer.add(flow);
  console.log(`✨ Flow registered! Parent Job ID: ${parentJobId}`);

  // Give internal setups a tick to register
  await new Promise(r => setTimeout(r, 1000));

  // 3. Verify GET /api/flows lists recent flows
  console.log('\n📡 Querying API: GET http://localhost:4000/api/flows');
  const recentFlows = await getJson('http://localhost:4000/api/flows');
  console.log(`Found ${recentFlows.length} flows in recent listing.`);
  
  const foundParent = recentFlows.find(f => f.id === parentJobId);
  if (!foundParent) {
    console.error('❌ FAILURE: Parent job was not listed in the flows endpoint.');
    process.exit(1);
  }
  console.log(`✅ Success: Parent Job is listed with state: ${foundParent.state}`);

  // 4. Query GET /api/flows/:parentId
  console.log(`\n📡 Querying Parent Flow details: GET http://localhost:4000/api/flows/${parentJobId}`);
  const parentFlow = await getJson(`http://localhost:4000/api/flows/${parentJobId}`);
  
  console.log('📊 Parent Flow response:');
  console.log(JSON.stringify(parentFlow, null, 2));

  // Assertions for Parent
  if (parentFlow.node.id !== parentJobId) {
    console.error('❌ FAILURE: Returned node ID does not match parent ID.');
    process.exit(1);
  }
  if (parentFlow.children.length !== 2) {
    console.error(`❌ FAILURE: Expected 2 children, got: ${parentFlow.children.length}`);
    process.exit(1);
  }
  console.log('✅ Success: Resolved parent node and both children.');

  const childId1 = parentFlow.children[0].id;
  const childId2 = parentFlow.children[1].id;

  // 5. Query GET /api/flows/:childId
  console.log(`\n📡 Querying Child 1 Flow details: GET http://localhost:4000/api/flows/${childId1}`);
  const childFlow = await getJson(`http://localhost:4000/api/flows/${childId1}`);

  console.log('📊 Child Flow response:');
  console.log(JSON.stringify(childFlow, null, 2));

  // Assertions for Child
  if (childFlow.node.id !== childId1) {
    console.error('❌ FAILURE: Returned node ID does not match child ID.');
    process.exit(1);
  }
  if (childFlow.parents.length !== 1 || childFlow.parents[0].id !== parentJobId) {
    console.error('❌ FAILURE: Parent reference was not resolved on child.');
    process.exit(1);
  }

  console.log('\n🎉 ALL FLOW VISUALIZATION INTEGRATION TESTS PASSED!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error running flow test:', err);
  process.exit(1);
});
