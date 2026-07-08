# TaurusMQ Core Library Reference

This reference documents the public APIs, configurations, extension hooks, lifecycle events, and directories of the TaurusMQ core library (`src/`).

---

## Directory Structure

* **`src/core/`**: Houses class implementations defining the public API and runtime loops.
  * `queue.js`: Job producer client. Handles enqueuing, retrieval, pause/resume, and removal.
  * `worker.js`: Job consumer client. Polling slots, handler execution, lock lease renewal, and retry backoff.
  * `scheduler.js`: Delayed job promotion loop and stalled lock reclamation watchdog.
  * `flowProducer.js`: Directed Acyclic Graph (DAG) dependency builder and cycle verification.
  * `job.js`: Serialization and state model of individual jobs.
  * `maintenance.js`: Asynchronous job deletion processor and long-lived zombie job sweeper.
  * `queue-events.js`: Pub/Sub subscriber that emits job lifecycle events out-of-process.
* **`src/lua/`**: High-performance, atomic Lua scripts loaded into Redis to prevent state race conditions.
* **`src/utils/`**: Utility scripts (e.g. `redis.js` wrapper to manage connection instantiation and Lua script registration).

---

## API Classes Reference

```typescript
import { Queue, Worker, Scheduler, FlowProducer, QueueEvents } from 'taurusmq';
```

### 1. `Queue`
The `Queue` class is responsible for producing jobs, fetching job details, checking statuses, and controlling queue state (e.g. pausing, resuming, draining).

#### Constructor Options
```typescript
interface QueueOptions {
  connection?: {
    host?: string;
    port?: number;
    password?: string;
    tls?: any;
  };
  prefix?: string;            // Default: 'taurusmq'
  removeOnComplete?: number;  // Retention limit for completed jobs. Default: 1000
  removeOnFail?: number;      // Retention limit for failed jobs. Default: 1000
  limiter?: {                 // Global rate limiter config
    max: number;              // Max jobs processed in window
    duration: number;         // Window duration in ms
  };
}
```

#### TypeScript/JavaScript API
```typescript
class Queue {
  constructor(name: string, options?: QueueOptions);

  /** Enqueues a job atomically */
  add(name: string, data: any, opts?: JobOptions): Promise<Job>;

  /** Bulk inserts multiple jobs atomically */
  addBulk(jobs: Array<{ name: string; data: any; opts?: JobOptions }>): Promise<Job[]>;

  /** Pauses the queue, stopping workers from pulling new jobs */
  pause(): Promise<void>;

  /** Resumes a paused queue */
  resume(): Promise<void>;

  /** Checks if the queue is currently paused */
  isPaused(): Promise<boolean>;

  /** Fetches a job by ID from either the jobs vault or the DLQ */
  getJob(jobId: string): Promise<Job | null>;

  /** Queues a job deletion task to be processed asynchronously */
  removeJob(jobId: string): Promise<void>;

  /** Atomically purges all lists, ZSETs, and hashes for this queue */
  drain(): Promise<void>;

  /** Moves a job from the DLQ back to the wait or prioritized list */
  retryJob(jobId: string): Promise<void>;

  /** Returns job counts broken down by state */
  getJobCounts(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    dlq: number;
  }>;

  /** Paginated job retrieval */
  getJobs(
    states: string[],
    start?: number,
    end?: number,
    asc?: boolean
  ): Promise<Job[]>;
}
```

#### Edge Cases & Performance Notes
* **Deduplication Gate**: If a caller-supplied `jobId` is provided in `opts`, TaurusMQ checks if the ID exists in the jobs vault hash using `HEXISTS`. If it exists, the duplicate job is ignored, and the existing job is returned. However, because completed and failed jobs remain in the jobs vault hash (until evicted by retention limits), deduplication applies across historical runs of that job ID.
* **Drain Operation**: Draining is an atomic operation. Under heavy load, calling `drain()` deletes multiple keys simultaneously in Redis, which blocks Redis briefly. For high-volume production queues, configure `removeOnComplete` and `removeOnFail` to limit backlog size rather than running full drains.

---

### 2. `Worker`
The `Worker` class is responsible for consuming jobs. It listens on wait queues, executes user-defined handlers, manages lock renewal, and handles backoffs on failures.

#### Constructor Options
```typescript
interface WorkerOptions {
  connection?: any;
  prefix?: string;
  concurrency?: number;         // Default: 1. Number of parallel slots.
  lockDuration?: number;        // Lock lease lifetime in ms. Default: 30000 (30s)
  lockRenewTime?: number;       // Interval between lock extensions. Default: 15000 (15s)
  removeOnComplete?: number;    // Eviction cap for completed jobs. Default: 1000
  removeOnFail?: number;        // Eviction cap for failed jobs. Default: 1000
  limiter?: {
    max: number;
    duration: number;
  };
  backoffStrategies?: Record<
    string,
    (attempts: number, delay: number) => number
  >;
}
```

#### TypeScript/JavaScript API
```typescript
type JobHandler = (job: Job) => Promise<any>;

class Worker extends EventEmitter {
  constructor(queuename: string, handler: JobHandler, options?: WorkerOptions);

  /** Establishes connections and starts the polling loops */
  start(): Promise<void>;

  /** Stops polling, waits up to shutdownTimeout (ms) for active handlers */
  stop(shutdownTimeout?: number): Promise<void>;
}
```

#### Lock Lease Lifecycle & Stalls
When a worker picks up a job, it registers the jobId in `taurusmq:active:<queue>` with a score equal to `Date.now() + lockDuration`. 
An internal lease-renewal timer runs every `lockRenewTime` ms to extend this score by another `lockDuration`. 
* **Worker Crash**: If the worker process crashes, the renewal loop terminates. When the score is surpassed, the `Scheduler` watchdog running on another instance will identify the job as stalled and recover it.
* **Graceful Shutdown Gotcha**: Calling `worker.stop()` immediately clears the renewal timers to facilitate shutdown. However, running jobs are permitted to continue executing for up to `shutdownTimeout` (default 30s). If a job takes longer than `lockRenewTime` to shut down, its lock is no longer renewed and may expire before completion, causing the Scheduler watchdog to reclaim and double-execute the job. To avoid this, set `shutdownTimeout` to a value lower than `lockRenewTime`.

#### Concurrency & Redis Connection Scaling
TaurusMQ workers implement concurrency by running independent slot loops. Each slot instantiates **its own blocking Redis client** to run `BLPOP`.
* **Important**: If you configure a worker with `concurrency: 20`, that single process will open 20 separate TCP connections to Redis. Ensure your Redis server configuration (`maxclients`) is sized to handle this scaling behavior.

---

### 3. `Scheduler`
The `Scheduler` class runs the background maintenance loops for delayed job promotion and stalled lock recovery.

#### Constructor Options
```typescript
interface SchedulerOptions {
  connection?: any;
  prefix?: string;
  watchdogInterval?: number; // Frequency of stall checks in ms. Default: 15000 (15s)
}
```

#### TypeScript/JavaScript API
```typescript
class Scheduler {
  constructor(queuename: string, options?: SchedulerOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

#### Watchdog Execution Behavior
1. **Delayed Promotion Loop**: Uses a blocking connection executing `BLPOP` on the `taurusmq:signal:delayed:<queue>` list. When signaled, it runs the `promote.lua` script to fetch jobs from `taurusmq:delayed:<queue>` whose execution timestamp is due, moving them to the wait/priority lists.
2. **Stalled Watchdog**: Runs periodically on a set interval (default 15s). It calls `recoverStalled.lua` with the current timestamp. Any job in the active ZSET with an expiration score less than or equal to the current time is considered stalled. It is either returned to the wait queue or moved to the DLQ if it has exceeded `maxretries`.

---

### 4. `FlowProducer`
The `FlowProducer` enables parent-child job tree configurations (DAGs).

#### TypeScript/JavaScript API
```typescript
interface FlowNode {
  name: string;
  queueName: string;
  data: any;
  opts?: JobOptions;
  children?: FlowNode[];
}

class FlowProducer {
  constructor(options?: { connection?: any; prefix?: string });

  /** Validates tree for cyclic dependencies and enqueues all nodes */
  add(flow: FlowNode): Promise<Job>;
}
```

#### Internal Cycle Checks & Promotion
* **Atomic DFS Validation**: Before committing the flow to Redis, `FlowProducer` executes a Depth-First Search cycle check. If a cyclic reference is found (e.g. Job A depends on Job B, which depends on Job A), it throws an error immediately.
* **Count Decrements**: When a child job completes, the worker executes `unblock.lua`, decrementing `${prefix}:job:${parentId}:count`. When this count hits 0, the parent job is atomically promoted from the blocked list to the wait list.

---

### 5. `QueueEvents`
Provides real-time event notification streaming by subscribing to the Redis Pub/Sub channel for a given queue.

#### TypeScript/JavaScript API
```typescript
class QueueEvents extends EventEmitter {
  constructor(queuename: string, options?: { connection?: any; prefix?: string });
}
```

#### Supported Lifecycle Events
* `waiting`: emitted when a job is enqueued.
* `active`: emitted when a worker starts processing a job.
* `completed`: emitted when a job completes successfully. Contains `{ jobId, returnvalue }`.
* `failed`: emitted when a job fails. Contains `{ jobId, failedReason }`.
* `stalled`: emitted when the scheduler watchdogs reclaim a stalled job.
* `drained`: emitted when a queue transitions to empty (no waiting or active jobs).

---

## Observability Integrations

Telemetry hooks are attached via `@taurusmq/observability` to intercept core runtime methods and pipe telemetry into the Observability Bus.

```javascript
const { attachObservability, bus } = require('./packages/observability');

const obs = attachObservability({
  queues: ['emails', 'reports'],
  redisOptions: { host: 'localhost', port: 6379 }
});
```

### Async Console Log Interception
When telemetry is attached, TaurusMQ patches `console.log`, `console.warn`, and `console.error` inside worker processing loops.
* **AsyncLocalStorage Binding**: Telemetry wraps the worker handler inside an `AsyncLocalStorage` context. Any log statements executed inside the handler are captured, formatted as structured JSON, and pushed to the Redis list `${prefix}:logs:${queueName}:${jobId}` with a 7-day TTL.
* **Direct Logging**: Jobs are injected with an async `job.log(message)` helper which writes messages directly to Redis, bypassing stdout.
