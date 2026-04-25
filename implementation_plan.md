# TaurusMQ — Implementation Roadmap

TaurusMQ is a distributed background job processing system built from first principles in Node.js and Redis. This plan outlines the journey from a basic message passer to a production-grade workflow engine.

## User Review Required

> [!IMPORTANT]
> **Learning Curve:** This project involves writing Redis Lua scripts and managing complex state machines. It is technically more difficult than a standard CRUD app.
> **Database Requirement:** You will need a Redis instance running locally (via Docker is recommended) to begin Phase 1.

---

## Phase 1: Core Engine (The "Heartbeat")
**Goal:** Successfully enqueue a job in Redis and have a separate worker process pick it up and execute it.

### [NEW] Project Setup
*   Initialize Node.js project.
*   Setup `ioredis` connection.
*   Create the `Queue` class (for producers).
*   Create the `Worker` class (for consumers).

### [NEW] The Basic Loop
*   **Producer:** `queue.add(name, data)` -> `RPUSH` to Redis.
*   **Worker:** Simple polling with `BLPOP` to wait for jobs.
*   **Interview Point:** "Why `BLPOP`? Because it blocks the connection and prevents high CPU usage when the queue is empty (Zero-overhead polling)."

---

## Phase 2: Reliability Layer (The "Safety")
**Goal:** Ensure no job is ever lost, even if a worker crashes or an external API fails.

### [MODIFY] Atomic Dequeueing
*   Replace `BLPOP` with a **Lua Script**.
*   **The Script:** Atomically moves a job from `waiting` list to an `active` set while adding a timestamp.
*   **Interview Point:** "We use Lua to prevent race conditions where two workers grab the same job at the microsecond level."

### [NEW] Error Handling
*   **Exponential Backoff:** If a job fails, calculate the next retry time (2, 4, 8, 16 seconds).
*   **DLQ:** Move jobs to a `Dead Letter Queue` after X failures.
*   **Lease/Visibility Timeout:** A watchdog process that checks if a worker died and moves "stuck" jobs back to the `waiting` list.

---

## Phase 3: Time-Based Scheduling (The "Calendar")
**Goal:** Handle delayed execution and recurring schedules.

### [NEW] Delayed Jobs
*   Use a Redis **Sorted Set** (`ZSET`) where the score is the UTC timestamp.
*   Implement a "Scheduler" process that polls the ZSET and promotes jobs to the active queue.

### [NEW] Recurring (Cron) Jobs
*   Integrate `cron-parser`.
*   Logic: After a cron-job finishes, calculate the next tick and re-enqueue it as a delayed job.
*   **Interview Point:** "We store everything in UTC to avoid server-local timezone conflicts."

---

## Phase 4: Complex Workflows (The "Brains")
**Goal:** Support dependencies and grouping.

### [NEW] Chain Tasks (DAGs)
*   Implement `job.addDependency(parentId)`.
*   Jobs start in a `paused` state.
*   **Interlock:** When a parent job completes, it issues a signal to its children to "unfreeze."

### [NEW] Batch Tasks
*   Implement `Queue.addBatch([jobs])`.
*   Maintain an atomic counter in Redis for the batch size.
*   Final "Summary" job executes once the counter hits zero.

---

## Phase 5: Visibility & API Layer (The "Eyes")
**Goal:** Monitor the system in real-time.

### [NEW] REST API (Express)
*   Endpoints to view queue depth, inspect failed jobs, and manually retry jobs.
*   **Zod** validation for job data.

### [NEW] Live Dashboard (React)
*   **WebSockets:** Push notifications when a job completes or fails.
*   **Recharts:** Graph showing throughput (Jobs per second).

---

## Phase 6: Production & Scale (The "Final Polish")
**Goal:** Prepare Hermes for the real world.

### [NEW] Dev Ops
*   `docker-compose.yml` to spin up Hermes + Redis + Postgres.
*   GitHub Actions for automated testing.

### [NEW] Benchmarking
*   Script to enqueue 10,000 "dummy" jobs.
*   Measure: **Latency** (time to start) and **Throughput** (jobs per second).
*   **Resume Stat:** "Hermes handled 1.2k job completions per second on a single-core instance."

---

## Verification Plan

### Automated Tests
*   `npm test` using Jest.
*   Concurrency test: Run 10 workers on 1 job—verify only 1 execution.
*   Crash test: Kill a worker mid-job—verify the lease system recovers it.

### Manual Verification
*   Use the Dashboard to watch a cron job re-trigger itself every minute.
*   Use Postman to trigger a "Chain" of 3 jobs and observe the order of execution.
