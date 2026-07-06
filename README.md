# TaurusMQ 

**A Production-Grade, Highly Available, Distributed Background Job Engine built with Node.js and Redis.**

TaurusMQ is an enterprise background task queue system inspired by the concepts of BullMQ, Sidekiq, and RabbitMQ. Built on top of Redis, it leverages Lua scripts to guarantee strict FIFO/Priority job transitions, parent-child task dependency graphs (DAGs), lock lease renewal fencings, and telemetry collection with zero data corruption.

---

## 🚀 Key Features

*   **Atomic State Management:** Guaranteed atomic enqueueing and dequeueing via robust Lua transactions.
*   **Flexible Dispatch Patterns:** Support for FIFO, LIFO, delayed jobs, and repeatable UTC cron triggers.
*   **Parent-Child Workflows (DAGs):** Complex parent-child dependency resolution via `FlowProducer`.
*   **Distributed Lock Fencing:** Automatic lock lease renewal and stall watchdogs to prevent duplicate executions or orphaned jobs.
*   **Unified Observability:** REST + WebSocket Dashboard API built-in with incident detection and capacity forecasting.
*   **Developer Onboarding:** Out-of-the-box npm workspace configuration and a single-command development dev stack.

---

## 📦 Prerequisites

*   **Node.js:** v18.0.0 or higher (common JS and workspace compatible).
*   **Redis:** v6.2.0 or higher (requires support for custom Lua commands and sorted sets).

---

## 🛠️ Getting Started

### 1. Installation

TaurusMQ is structured as a workspace package. Running the root install fetches all dependencies for both the library and the Next.js telemetry dashboard:

```bash
npm install
```

### 2. Configure Environment

Copy the example environment file and set your credentials:

```bash
cp .env.example .env
```

Ensure `.env` contains:
```env
TAURUSMQ_USERNAME=admin
TAURUSMQ_PASSWORD=yoursecurepassword
TAURUSMQ_JWT_SECRET=yoursecretkey
TAURUSMQ_AUTH_DISABLED=false
```

### 3. Spin Up Development Stack

Start the unified development stack. This automatically installs nested dashboard dependencies on the first run and concurrently spins up the background API and the telemetry web interface:

```bash
npm run dev
```

*   **Dashboard UI:** [http://localhost:3333](http://localhost:3333) (Next.js client)
*   **Dashboard API:** [http://localhost:4000](http://localhost:4000) (REST/WebSocket endpoint)

---

## 📖 Basic API Usage

### 1. Defining a Queue & Adding Jobs
```javascript
const { Queue } = require('taurusmq');

const myQueue = new Queue('image-processing');

async function run() {
  // Add a standard FIFO job
  const jobId = await myQueue.add('resize', { width: 800, height: 600 });
  console.log(`Job added: ${jobId}`);

  // Add a delayed job (runs after 5 seconds)
  await myQueue.add('compress', { quality: 80 }, { delay: 5000 });

  // Add a repeatable cron job (runs every minute)
  await myQueue.add('cleanup', {}, { repeat: '0 * * * * *' });
}
run();
```

### 2. Implementing a Worker Consumer
```javascript
const { Worker } = require('taurusmq');

const worker = new Worker('image-processing', async (job) => {
  console.log(`Processing job ${job.id} - ${job.name}`);
  
  // Custom job progress reporting
  await job.updateProgress(50);

  // Write isolated telemetry log statements
  await job.log('Starting image compression...');

  return { success: true };
}, {
  concurrency: 10 // Shared connection pool manages concurrent slots
});

worker.start();
```

### 3. Subscribing to Event Streams
```javascript
const { QueueEvents } = require('taurusmq');

const events = new QueueEvents('image-processing');

events.on('completed', ({ jobId, returnvalue }) => {
  console.log(`Job ${jobId} finished! Result:`, returnvalue);
});

events.on('failed', ({ jobId, failedReason }) => {
  console.error(`Job ${jobId} failed: ${failedReason}`);
});
```

### 4. Constructing Parent-Child Workflows (DAGs)
```javascript
const { FlowProducer } = require('taurusmq');

const flow = new FlowProducer();

async function createWorkflow() {
  await flow.add({
    name: 'generate-report', // Parent task (executes last)
    queueName: 'reports',
    children: [
      { name: 'fetch-users', queueName: 'database', data: { segment: 'active' } },
      { name: 'fetch-sales', queueName: 'database', data: { year: 2026 } }
    ]
  });
}
createWorkflow();
```

---

## 🔬 Observability & Instrumentation

To attach the telemetry observability engine to your application, invoke `attachObservability` at startup:

```javascript
const { Queue, Worker, attachObservability } = require('taurusmq');

async function bootstrap() {
  await attachObservability({
    Queue,
    Worker,
    queues: ['image-processing', 'reports'],
    port: 4000,
    patchConsole: true // Set to false to disable global console.log interception
  });
}
bootstrap();
```

---

## 🧪 Testing

Execute the comprehensive integration test suite locally:

```bash
# Run all tests
npm test

# Run tests with native Node.js coverage mapping
npm run test:coverage
```
