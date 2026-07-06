// run-all-tests.js
'use strict';

const { execSync } = require('child_process');

const testSuites = [
    'test-queue-ops.js',
    'test-scheduler.js',
    'test-workers.js',
    'test-job-lifecycle.js',
    'test-priority-queue.js',
    'test-queue-events.js',
    'test-lock-renewal.js',
    'test-queue-getters.js',
    'test-job-updates.js',
    'test-repeatable-jobs.js',
    'test-addbulk-dedup.js',
    'test-rate-limiting.js',
    'test-flow-producer.js',
    'test-api-redesign.js',
    'test-security.js',
    'test-code-quality.js',
    'test-fault-tolerance.js'
];

console.log("====================================================");
    console.log("🚀 STARTING TAURUSMQ FULL INTEGRATION SUITE");
    console.log("====================================================\n");

let failed = false;

for (const suite of testSuites) {
    console.log(`\n📦 Running suite: ${suite}...`);
    try {
        execSync(`node tests/${suite}`, { stdio: 'inherit' });
        console.log(`✅ ${suite} passed!`);
    } catch (err) {
        console.error(`❌ ${suite} failed with error!`);
        failed = true;
        break;
    }
}

if (failed) {
    console.log("\n❌ SOME TEST SUITES FAILED!");
    process.exit(1);
} else {
    console.log("\n🎉 ALL 16 TEST SUITES PASSED FLAWLESSLY!");
    process.exit(0);
}
