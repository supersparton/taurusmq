// test-flow-chains.js
const Queue = require('./src/core/queue');
const Worker = require('./src/core/worker');

const orderQueue = new Queue('order-process');

const worker = new Worker('order-process', async (job) => {
    console.log(`[Worker] Executing: ${job.name} for Order: ${job.data.orderId}`);
    // Simulate varying work times
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1000));
}, { concurrency: 3 });

worker.start();

async function runFlowTest() {
    console.log("🚀 Starting E-Commerce Order Flow (Fan-out & Fan-in)...");

    // 1. Root Job: Payment (Triggers children on completion)
    const paymentId = await orderQueue.add('Payment-Process', { orderId: 'ORD-123' }, { flow: true });

    // 2. Parallel Children (Depend on Payment)
    // These also have flow: true so they can trigger their own parent (Fan-in)
    const invId = await orderQueue.add('Inventory-Check', { orderId: 'ORD-123' }, { parent: [paymentId], flow: true });
    const invcId = await orderQueue.add('Generate-Invoice', { orderId: 'ORD-123' }, { parent: [paymentId], flow: true });

    // 3. Final Step: Shipping (Depends on BOTH Inventory and Invoice finishing)
    await orderQueue.add('Shipping-Release', { orderId: 'ORD-123' }, { parent: [invId, invcId] });

    console.log("✅ Flow Queued. Observe the staggered execution!");
}

runFlowTest();
