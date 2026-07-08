# TaurusMQ 🐂

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen.svg)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/redis-%3E%3D%206.2.0-red.svg)](https://redis.io/)

TaurusMQ is a high-performance, distributed, enterprise-grade job and message queue framework for Node.js, backed by Redis. Built from the ground up to solve complex orchestrations, TaurusMQ combines robust execution features with a native, real-time observability suite and dynamic management dashboard. 

TaurusMQ implements lock leases, priority sorting, delay schedulers, Cron schedules, repeatable jobs, and Directed Acyclic Graph (DAG) job dependency flows.

---

## Why TaurusMQ Exists

Distributed processing systems often force developers to choose between raw queue mechanics and observability. While existing solutions like BullMQ offer robust queue features, they lack unified real-time insights, native rate-limiting/monitoring engines, and integrated remediation guides. 

TaurusMQ bridges this gap by coupling a **highly resilient, Lua-driven job runner** with an **in-process telemetry engine**. Instead of relying on external monitoring tools, TaurusMQ's telemetry is native, generating deterministic analytics, proactive incident detection, capacity forecasts, and step-by-step mitigation playbooks directly out of the box.

### Key Problems Solved
* **Reliable Distributed Locks**: Prevents double-processing of jobs by using atomic lock leases renewed periodically during execution.
* **Complex Dependency Orchestration**: Solves parent-child batch coordination (DAGs) atomically in Redis, ensuring children block parent execution until completion.
* **Telemetry Fragmentation**: Replaces fragmented metrics collection with a unified observability bus, streaming events directly to a Redis stream.
* **Capacity Blindness**: Forecasts queue backlogs and worker deficits using pure mathematical algorithms rather than guesswork.
* **Stall and Crash Recovery**: Reclaims active jobs orphaned when worker pods crash, routing them back to the active queue or DLQ.

---

## Design Philosophy

1. **At-Least-Once Execution**: Every job must be successfully completed or safely moved to a Dead Letter Queue (DLQ). Workers maintain lock leases, which are automatically recovered by a scheduler watchdog if a worker crashes.
2. **Atomic State Transitions**: All queue operations (enqueue, dequeue, promotion, unblocking, finalization) are implemented via optimized Lua scripts. This eliminates race conditions and ensures transaction integrity in clustered Redis setups.
3. **Decoupled Observability**: Observability hooks patch standard queue runtime classes but operate asynchronously. Telemetry and aggregation workloads never block the critical job execution loop.
4. **Developer-First Ergonomics**: Comprehensive developer experience with full type-safety support, minimal configuration overhead, and a production-ready Web UI.

---

## Architecture

TaurusMQ's architecture is divided into two decoupled layers: the **Core Runtime** and the **Observability & Analytics Suite**.

### High-Level Architecture

```mermaid
graph TD
    subgraph Client Application
        Q[Queue Client]
        FP[FlowProducer]
    end

    subgraph Redis Cluster
        WaitList["taurusmq:wait LIST"]
        ActiveSet["taurusmq:active ZSET"]
        DelayedSet["taurusmq:delayed ZSET"]
        JobVault["taurusmq:jobs HASH"]
        EventStream["tmq:obs:events STREAM"]
        MaterializedMetrics["tmq:obs:materialized HASH"]
    end

    subgraph Worker Pool
        WorkerProcess["Worker Process"]
        SchedulerWatchdog["Scheduler Watchdog"]
    end

    subgraph Observability Suite
        ObsBus["Observability Bus"]
        MA["Metrics Aggregator"]
        IE["Incident Engine"]
        FE["Forecasting Engine"]
        RE["Recommendation Engine"]
    end

    subgraph Management Dashboard
        DashboardAPI["Dashboard API Server"]
        NextUI["Next.js Web UI"]
    end

    %% Enqueuing
    Q -->|Atomically Enqueue| WaitList
    Q -->|Store JSON| JobVault
    FP -->|Write Dependency Tree| JobVault

    %% Worker Loop
    WorkerProcess -->|BLPOP Signal| WaitList
    WorkerProcess -->|Execute Job & Renew Lock| ActiveSet
    WorkerProcess -->|Finalize Job| JobVault
    WorkerProcess -.->|Emit Events| ObsBus

    %% Scheduler
    SchedulerWatchdog -->|Promote Delayed| DelayedSet
    SchedulerWatchdog -->|Reclaim Stalled| ActiveSet

    %% Telemetry Pipeline
    ObsBus -->|Write Telemetry| EventStream
    EventStream -->|Read & Aggregate| MA
    MA -->|Write Live Metrics| MaterializedMetrics
    MaterializedMetrics -->|Evaluate Rules| IE
    MaterializedMetrics -->|Calculate Horizon| FE
    IE -->|Generate Playbooks| RE

    %% Dashboard Connection
    DashboardAPI -->|Read Live Stats| MaterializedMetrics
    DashboardAPI -->|Query History| EventStream
    DashboardAPI -->|SSE / WebSockets| NextUI
```

### Queue Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Active : "Initialize Queue"
    Active --> Paused : "Queue.pause()"
    Paused --> Active : "Queue.resume()"
    Active --> Drained : "No Active/Waiting Jobs"
    Drained --> Active : "New Job Enqueued"
    Active --> [*] : "Queue.close()"
```

### Job Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Waiting : "Enqueued"
    [*] --> Delayed : "Delay/Repeat Specified"
    Delayed --> Waiting : "Promotion (ZSET Score Reached)"
    Waiting --> Active : "Dequeued by Worker (BLPOP)"
    Active --> Completed : "Handler Resolved Successfully"
    Active --> Retrying : "Handler Failed (attempts less than maxRetries)"
    Retrying --> Delayed : "Rescheduled with Backoff"
    Active --> Dead : "Max Retries Exhausted / Stall Limit Hit"
    Dead --> DLQ : "Archived in Dead Letter Queue"
    Dead --> [*]
    Completed --> [*]
```

### Worker Execution Flow

```mermaid
sequenceDiagram
    autonumber
    participant W as Worker
    participant R as Redis
    participant H as Job Handler
    participant B as Telemetry Bus

    W->>R: BLPOP taurusmq:signal:queue
    Note over W: Blocks until signal list is populated
    R-->>W: Signal received
    W->>R: EVAL dequeue.lua - Move Job to Active ZSET with Lock
    R-->>W: Returns Job Payload
    W->>B: Emit job.active
    loop Lock Renewal Timer
        W->>R: Keep-Alive - Extend lock score in active ZSET
    end
    W->>H: Execute User Handler
    alt Success
        H-->>W: Return value
        W->>R: EVAL finalizeJob.lua - Move to Completed ZSET
        W->>B: Emit job.completed
    else Failure
        H-->>W: Throw Error
        alt attempts less than maxRetries
            W->>R: Reschedule Job - Set Delayed ZSET + Backoff
            W->>B: Emit job.failed with willRetry = true
        else attempts greater than or equal to maxRetries
            W->>R: EVAL finalizeJob.lua - Move to Failed ZSET & DLQ
            W->>B: Emit job.failed with willRetry = false
        end
    end
    Note over W: Clean up renewal timer & continue loop
```

### Dashboard Data Flow

```mermaid
sequenceDiagram
    autonumber
    participant C as Core Class (Queue/Worker)
    participant B as Observability Bus
    participant S as EventStreamWriter
    participant R as Redis Stream
    participant A as Metrics Aggregator
    participant D as Dashboard API Server
    participant U as Next.js Web UI

    C->>B: Emit Event - e.g. job.completed
    B->>S: Distribute Event to Wildcard Handler
    S->>R: XADD tmq:obs:events *
    Note over A: Metrics Aggregator ticks every 10s
    A->>R: XRANGE last seen timestamp
    A->>A: Compute Throughput, Latency Percentiles, Health Score
    A->>R: HSET tmq:obs:materialized
    D->>R: Read materialized metrics & active alerts
    D->>U: Stream updates via Server-Sent Events (SSE)
```

---

## Key Features

### 1. Supported Job Types
* **Immediate Jobs**: Processed as soon as a worker becomes available.
* **Delayed Jobs**: Scheduled to execute after a specific delay duration.
* **Repeatable (Cron) Jobs**: Runs according to cron syntax (rescheduled after each run).
* **Prioritized Jobs**: Executed before normal jobs, sorted using a normalized priority score.
* **Bulk/Batch Jobs**: Atomic insertion of multiple jobs that can share a `batchId` to track progress.

### 2. DAG Flow Producer
TaurusMQ provides a `FlowProducer` to build parent-child dependency trees.
* A parent job will **not** be processed until all its declared child jobs complete.
* If a child job fails and exhausts its retries, the parent job remains blocked and enters a stalled or failed-dependent state.
* The unblocking process is resolved atomically inside Redis via `unblock.lua` without worker polling.

### 3. Native Observability Suite
* **Real-time Metrics**: Tracks waiting/active/completed/failed counters, error rates, and latency percentiles (P50, P95, P99).
* **Incident Detection**: Evaluates built-in rules (stalls, latency spikes, backlog growth, OOM risks) and generates active incident records.
* **Capacity Forecasting**: Predicts time to overflow or full queue drain based on live enqueue/completion rates.
* **Actionable Playbooks**: Generates mitigation guides tailored to the exact metrics of the incident.

---

## BullMQ vs. TaurusMQ

TaurusMQ shares concepts with BullMQ but differs in its core design, architecture, and feature priorities.

### Comparison Table

| Feature / Attribute | BullMQ | TaurusMQ |
| :--- | :--- | :--- |
| **Primary Focus** | Feature completeness, high scale, configuration flexibility | Out-of-the-box reliability, native observability, simplicity |
| **Telemetry System** | Optional (requires third-party dashboard or custom events listener) | Built-in native Observability Bus, Redis Stream, and Aggregator |
| **Worker Dequeue Loop** | Single connection doing BRPOPLPUSH per worker | Dedicated connection per concurrency slot executing BLPOP |
| **Stall Recovery** | Lock renewal via script, external scheduler script | Heartbeat loop + Active ZSET recovery inside Scheduler watchdog |
| **Cron Support** | Managed in Redis using custom repeating indexes | Standard cron expression parsed via `cron-parser` and rescheduled |
| **Mitigation Engine** | None | Real-time Incident Engine + Playbook Recommendation Engine |
| **UI Dashboard** | Separate package (Bull Board) | Integrated Next.js + REST/WebSocket API Gateway |
| **DAG Resolution** | Complex parent-child dependency indexes | Dynamic parent count decrements using `unblock.lua` |

### Architectural Tradeoffs & Limitations
1. **Connection Overhead**: TaurusMQ workers create one blocking connection per concurrency slot (`this.concurrency`) to run `blpop`. In environments with high concurrency configs (e.g., 50+ slots per worker pod), this increases the Redis client connection count. BullMQ uses a single connection per worker, distributing jobs in-memory.
2. **Normal Failure DLQ Inconsistency**: When a job exhausts all retries under normal worker execution, it is updated to `dead` in the jobs vault hash and failed ZSET, but **not** appended to the `taurusmq:dlq:<queue>` hash. Only stalled jobs recovered by the Scheduler or zombie cleanups by the Maintenance class are added to the `taurusmq:dlq:<queue>` hash. The dashboard unified API queries both locations to display dead jobs.
3. **Asynchronous Maintenance**: Queue removals are queued to a maintenance stream and executed asynchronously by the Maintenance class. Immediate reads after removal may temporarily return stale results.

---

## Internal Design

### Project Structure
```
taurusmq/
├── src/                      # Core Queue Library
│   ├── core/                 # Queue, Worker, Scheduler, Job, FlowProducer, Maintenance
│   ├── lua/                  # Optimized atomic Lua scripts (dequeue, unblock, finalize, etc.)
│   └── utils/                # Shared Redis connection utility
├── packages/                 # Telemetry & Observability Packages
│   ├── observability.js      # Main entry point to attach telemetry to Core classes
│   ├── observability-core/   # SetupManager, EventStreamWriter, ObservabilityBus, patches
│   ├── metrics-engine/       # MetricsCollector, MetricsAggregator
│   ├── incident-engine/      # IncidentEngine, Rule definitions
│   ├── forecasting-engine/   # Capacity forecasting math formulas
│   ├── recommendation-engine/# Diagnostic playbook generation
│   └── dashboard-api/        # Express REST API, HTTP-cookie auth, and Event Stream gateway
└── dashboard/                # Next.js Management Web Dashboard
```

### Redis Key Design Schema

| Redis Key | Data Type | Description / Schema |
| :--- | :--- | :--- |
| `taurusmq:<queueName>` | `LIST` | Wait queue storing job IDs waiting for immediate execution. |
| `taurusmq:jobs:<queueName>` | `HASH` | Job Vault: `jobId` -> JSON representation of Job details and state. |
| `taurusmq:active:<queueName>` | `ZSET` | Active jobs: `jobId` -> score is lease expiration timestamp (unix ms). |
| `taurusmq:delayed:<queueName>` | `ZSET` | Delayed & Repeatable jobs: `jobId` -> score is next execution timestamp. |
| `taurusmq:prioritized:<queueName>`| `ZSET` | Priority jobs: `jobId` -> score is derived priority float. |
| `taurusmq:blocked:<queueName>` | `HASH` | Blocked parent jobs: `jobId` -> `1`. |
| `taurusmq:dlq:<queueName>` | `HASH` | Dead Letter Queue: `jobId` -> JSON of stalled/zombie dead jobs. |
| `taurusmq:completed:<queueName>` | `ZSET` | Completed job index: `jobId` -> score is completion timestamp. |
| `taurusmq:failed:<queueName>` | `ZSET` | Failed job index: `jobId` -> score is failure timestamp. |
| `taurusmq:signal:<queueName>` | `LIST` | Semaphore list for worker BLPOP blocking signals. |
| `taurusmq:signal:delayed:<queueName>`| `LIST` | Semaphore list for scheduler BLPOP blocking signals. |
| `tmq:obs:metrics:<queueName>:counters`| `HASH` | Real-time counters (created, completed, failed, latency totals). |
| `tmq:obs:metrics:<queueName>:latency`| `LIST` | Latency ring buffer storing last 1000 completion times. |
| `tmq:obs:materialized:<queueName>`| `HASH` | Hourly aggregated and computed metrics (errorRate, healthScore, avgLatency). |
| `tmq:obs:incidents` | `HASH` | Historical alerts: `incidentId` -> JSON payload of alerts. |
| `tmq:obs:alerts` | `HASH` | Active firing alerts: `incidentId` -> JSON payload of active alerts. |

---

## Installation

```bash
# Install dependencies in root folder
npm install

# Build workspace packages
npm run bootstrap
```

---

## Quick Start

### 1. Initialize Redis and Environment Variables
Create a `.env` file in the project root:
```env
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
TAURUSMQ_USERNAME=admin
TAURUSMQ_PASSWORD=supersecurepassword
TAURUSMQ_JWT_SECRET=supersecurejwtsecretkey
```

### 2. Basic Example: Producer and Consumer
Create `index.js`:
```javascript
const { Queue, Worker } = require('./src');

// 1. Create a Queue
const emailQueue = new Queue('emails', {
  connection: { host: '127.0.0.1', port: 6379 }
});

// 2. Enqueue an Immediate Job
async function run() {
  const job = await emailQueue.add('sendWelcomeEmail', {
    to: 'user@example.com',
    template: 'welcome_v1'
  });
  console.log(`Job enqueued with ID: ${job.id}`);
}

// 3. Define a Worker to process jobs
const emailWorker = new Worker('emails', async (job) => {
  console.log(`Processing email job ${job.id} for ${job.data.to}`);
  // Perform email sending logic...
  return { sent: true, provider: 'smtp-relay' };
}, {
  concurrency: 5,
  connection: { host: '127.0.0.1', port: 6379 }
});

emailWorker.on('completed', ({ jobId, returnvalue }) => {
  console.log(`Job ${jobId} completed successfully with:`, returnvalue);
});

run();
```

---

## Advanced Developer Guide

### 1. Delayed Jobs
Add a job that will execute after 10 seconds:
```javascript
await queue.add('generateReport', { reportId: 456 }, {
  delay: 10000 // duration in milliseconds
});
```

### 2. Repeatable (Cron) Jobs
Schedule a cleanup job to run every minute:
```javascript
await queue.add('dbCleanup', { tables: ['sessions'] }, {
  repeat: '* * * * *' // cron expression
});
```

### 3. Priority Jobs
Jobs are normally processed FIFO. Setting priority changes the execution order:
```javascript
// Priority 1 is high priority and will execute before Priority 10
await queue.add('vipNotification', { userId: 1 }, { priority: 1 });
await queue.add('normalNewsletter', { listId: 9 }, { priority: 10 });
```

### 4. DAG dependency flow
Enqueuing jobs where parents await children:
```javascript
const { FlowProducer } = require('./src');
const producer = new FlowProducer({ connection: { host: '127.0.0.1', port: 6379 } });

// Parent job 'render-video' will execute ONLY after 'transcode-1' and 'transcode-2' complete
await producer.add({
  name: 'render-video',
  queueName: 'rendering',
  data: { output: 'final.mp4' },
  children: [
    { name: 'transcode-1', queueName: 'transcoding', data: { chunk: 1 } },
    { name: 'transcode-2', queueName: 'transcoding', data: { chunk: 2 } }
  ]
});
```

### 5. Attaching Observability
To enable the metrics, incident, and recommendation engines, start the observability suite:
```javascript
const { attachObservability } = require('./packages/observability');

// Attaches event interceptors to all Queue, Worker, and Scheduler instances
const obsInstance = attachObservability({
  queues: ['emails', 'rendering', 'transcoding'],
  redisOptions: { host: '127.0.0.1', port: 6379 },
  apiPort: 3001 // Starts Express Dashboard API Gateway
});
```

---

## Production Best Practices

### Redis Configuration
* **Memory Limits**: Configure Redis maxmemory with `noeviction` policy:
  ```redis
  maxmemory 4gb
  maxmemory-policy noeviction
  ```
  *Warning: Eviction policies like `allkeys-lru` may delete active job hashes or waiting lists, leading to queue corruption.*
* **Network Isolation**: Secure Redis using TLS and deploy workers in the same subnet/private network to reduce BLPOP roundtrip latencies.

### Worker Scaling
* **Concurrency vs. Connections**: Each concurrency slot creates a dedicated blocking Redis client. Keep concurrency within bounds (e.g. 5–15 per process) and scale horizontally by deploying more worker processes across containers.
* **Lease Expirations**: Set worker `lockDuration` safely. If a job handler makes an external API call that takes up to 60s, ensure `lockDuration` is at least 30s with `lockRenewTime` set to 10s.

### Error Handling & Retries
* **Unrecoverable Errors**: If a job fails due to an invalid input payload, mark it as unrecoverable by throwing an error with name `Unrecoverable` in the handler. This bypasses retries and moves the job directly to the failed status.
  ```javascript
  const worker = new Worker('process', async (job) => {
    if (!job.data.userId) {
      const err = new Error('Invalid User ID');
      err.name = 'Unrecoverable';
      throw err;
    }
  });
  ```

---

## Management Dashboard

TaurusMQ includes a built-in Next.js management dashboard:

```bash
# Start Dashboard API server (Observability port)
node packages/observability.js

# Build and start Next.js Dashboard Client
cd dashboard
npm run build
npm run start
```

### Features Overview
* **Interactive Job Views**: Inspect jobs in wait, active, completed, failed, delayed, and dead states.
* **Job Log Viewer**: Read intercepted `console.log` statements linked directly to the job execution context via `AsyncLocalStorage`.
* **Telemetry Charts**: Visualize throughput rates and latency fluctuations over time.
* **Incident Recommendations**: Review active system problems accompanied by CLI mitigation scripts.

---

## License

TaurusMQ is licensed under the [MIT License](LICENSE).
