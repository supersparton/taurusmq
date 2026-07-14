# Benchmarking Methodology

To ensure transparent, repeatable, and scientific performance assertions, this document outlines the exact execution path, metrics calculations, and profiling methodology used in our comparative tests.

---

## Benchmark Lifecycle Execution Path

```
   ┌────────────────────────────────┐
   │ 1. Warm Redis (FLUSHALL)       │
   └───────────────┬────────────────┘
                   │
                   ▼
   ┌────────────────────────────────┐
   │ 2. Initialize Workers          │
   └───────────────┬────────────────┘
                   │
                   ▼
   ┌────────────────────────────────┐
   │ 3. Start Timers / Metrics      │
   └───────────────┬────────────────┘
                   │
                   ▼
   ┌────────────────────────────────┐
   │ 4. Bulk Enqueue (50,000 jobs)  │
   └───────────────┬────────────────┘
                   │
                   ▼
   ┌────────────────────────────────┐
   │ 5. Process Jobs & Record Time  │
   └───────────────┬────────────────┘
                   │
                   ▼
   ┌────────────────────────────────┐
   │ 6. Collect Latency & Resources │
   └───────────────┬────────────────┘
                   │
                   ▼
   ┌────────────────────────────────┐
   │ 7. Stop Workers & Cleanup      │
   └────────────────────────────────┘
```

1. **Warm Redis**: Before each test, `FLUSHALL` is executed on Redis to clear residual memory states and key-spaces. A dry-run invocation ensures Lua scripts are pre-loaded (compiling SHA hashes).
2. **Start Workers**: Workers are booted up matching the target concurrency level ($C = 50$ for performance, or $C \in \{5, 10, 20, 50, 100\}$ for stress-testing).
3. **Start Timer**: Record starting timestamps, initial process CPU ticks, and base memory usage.
4. **Enqueue Jobs**: 50,000 jobs (each containing a 100-byte JSON payload) are enqueued in 50 chunks of 1,000 jobs using bulk write methods (`Queue.addBulk` for BullMQ, `Queue.addBulk` for TaurusMQ).
5. **Process Jobs**: Workers pull jobs and execute handler tasks. Each task simulates a minor CPU workload (calculating `Math.sin` 100 times) to replicate lightweight production handlers.
6. **Collect Metrics**: Listeners record completion events and exit once all 50,000 jobs are finalized.
7. **Stop Timer & Cleanup**: Stop worker loops, close connection handles, compile results, and write JSON reports.

---

## Metrics Definitions & Calculation Formulas

### 1. Enqueue Throughput
Measures how fast a producer can submit jobs to the Redis memory space:
$$\text{Enqueue Throughput} = \frac{\text{Total Jobs Enqueued}}{\text{Enqueue Duration (seconds)}}$$
*Measured from the start of the first batch push to the completion resolution of the final batch write.*

### 2. Consumer Throughput
Measures how fast workers pull, execute, and finalize jobs:
$$\text{Consumer Throughput} = \frac{\text{Total Jobs Processed}}{\text{Processing Duration (seconds)}}$$
*Measured from the startup of workers to the completion of the 50,000th job.*

### 3. Latency Measurement (Queue-to-Execution)
Latency measures the duration a job spends waiting in Redis before starting execution:
$$\text{Job Latency} = T_{\text{execution\_start}} - T_{\text{creation}}$$
*   **$T_{\text{creation}}$**: Recorded in the Redis database when the producer enqueues the job (`job.timestamp`).
*   **$T_{\text{execution\_start}}$**: Recorded in Node.js when the worker handler begins processing.

### 4. Percentiles (P50, P95, P99)
Rather than relying only on average values, the benchmark collects and sorts the latencies of all 50,000 jobs:
*   **P50 (Median)**: The middle latency value. 50% of the jobs were processed faster than this threshold.
*   **P95**: The 95th percentile latency. 95% of jobs were processed faster than this threshold. This highlights the experience of tail-end processing delays.
*   **P99**: The 99th percentile latency. Shows extreme outliers caused by garbage collection, event-loop starvation, or Redis connection queuing.

### 5. CPU Processing Time
Calculated using the process-level V8 execution clock:
$$\text{CPU Time} = \Delta \text{User CPU time} + \Delta \text{System CPU time}$$
*Captured using Node's `process.cpuUsage()`, which tracks microseconds spent executing user code vs. system kernel operations.*

### 6. Peak RSS Memory
Represents the maximum physical RAM occupied by the Node.js process during the run:
$$\text{Peak Memory} = \max(\text{Resident Set Size (RSS)})$$
*Measured in Megabytes (MB) via `process.memoryUsage().rss`. This captures the complete V8 heap, code segment, and call stack footprint.*
