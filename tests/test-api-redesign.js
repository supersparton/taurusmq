const assert = require('assert');
const { Queue, Worker, QueueEvents, FlowProducer } = require('./index');

async function testExports() {
    console.log("Testing root exports...");
    assert.ok(Queue, "Queue should be exported");
    assert.ok(Worker, "Worker should be exported");
    assert.ok(QueueEvents, "QueueEvents should be exported");
    assert.ok(FlowProducer, "FlowProducer should be exported");
    console.log("✓ Root exports passed.");
}

async function testFlowCycleDetection() {
    console.log("Testing FlowProducer circular dependency detection...");
    const flowProducer = new FlowProducer();
    
    // Cycle: A -> B -> A
    const childA = { name: 'childA', queue: 'q1', children: [] };
    const childB = { name: 'childB', queue: 'q2', children: [childA] };
    childA.children.push(childB);
    
    try {
        await flowProducer.add(childA);
        assert.fail("Should have thrown error on circular dependency");
    } catch (err) {
        assert.ok(err.message.includes("Circular dependency detected"), `Expected circular error, got: ${err.message}`);
    }

    // Malformed: missing queue/queueName
    const malformed = { name: 'noQueue' };
    try {
        await flowProducer.add(malformed);
        assert.fail("Should have thrown error on missing queueName");
    } catch (err) {
        assert.ok(err.message.includes("specify a queueName or queue"), `Expected schema error, got: ${err.message}`);
    }

    console.log("✓ FlowProducer validations passed.");
}

async function testServerSidePagination() {
    console.log("Testing Queue.getJobs server-side pagination...");
    const queueName = `test-pag-q-${Date.now()}`;
    const queue = new Queue(queueName);
    
    // Add 5 jobs
    await queue.add('job1', { val: 1 });
    await queue.add('job2', { val: 2 });
    await queue.add('job3', { val: 3 });
    await queue.add('job4', { val: 4 });
    await queue.add('job5', { val: 5 });

    // Fetch page 1 (0 to 2 -> 3 jobs)
    const page1 = await queue.getJobs('waiting', 0, 2);
    assert.strictEqual(page1.length, 3, `Expected 3 jobs, got ${page1.length}`);
    assert.strictEqual(page1[0].name, 'job1');
    assert.strictEqual(page1[1].name, 'job2');
    assert.strictEqual(page1[2].name, 'job3');

    // Fetch page 2 (3 to 4 -> 2 jobs)
    const page2 = await queue.getJobs('waiting', 3, 4);
    assert.strictEqual(page2.length, 2, `Expected 2 jobs, got ${page2.length}`);
    assert.strictEqual(page2[0].name, 'job4');
    assert.strictEqual(page2[1].name, 'job5');

    // Fetch page out of bounds (10 to 12 -> 0 jobs)
    const emptyPage = await queue.getJobs('waiting', 10, 12);
    assert.strictEqual(emptyPage.length, 0, `Expected 0 jobs, got ${emptyPage.length}`);

    await queue.close();
    console.log("✓ Server-side pagination passed.");
}

async function testWorkerEvents() {
    console.log("Testing Worker EventEmitter integration...");
    const queueName = `test-work-ev-q-${Date.now()}`;
    const queue = new Queue(queueName);
    
    let activeFired = false;
    let completedFired = false;
    let drainedFired = false;

    const worker = new Worker(queueName, async (job) => {
        return { success: true };
    });

    worker.on('active', ({ jobId }) => {
        activeFired = true;
    });

    worker.on('completed', ({ jobId, returnvalue }) => {
        completedFired = true;
        assert.deepStrictEqual(returnvalue, { success: true });
    });

    worker.on('drained', () => {
        drainedFired = true;
    });

    await worker.start();
    await queue.add('test-job', {});

    // Wait for worker to process and emit drained
    let limit = 0;
    while ((!completedFired || !drainedFired) && limit < 50) {
        await new Promise(r => setTimeout(r, 100));
        limit++;
    }

    assert.ok(activeFired, "active event should have fired");
    assert.ok(completedFired, "completed event should have fired");
    assert.ok(drainedFired, "drained event should have fired");

    await worker.stop();
    await queue.close();
    console.log("✓ Worker events passed.");
}

async function run() {
    try {
        await testExports();
        await testFlowCycleDetection();
        await testServerSidePagination();
        await testWorkerEvents();
        console.log("\nALL API DESIGN & CONSISTENCY TESTS PASSED SUCCESSFULLY!");
        process.exit(0);
    } catch (err) {
        console.error("Test execution failed:", err);
        process.exit(1);
    }
}

run();
