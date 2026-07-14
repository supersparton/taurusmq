# Phase B: Endurance & Memory Leak Validation Report

This report documents the findings of the **TaurusMQ Phase B Endurance Test**, verifying memory stability, processing consistency, and zero job loss under continuous high-volume loads.

---

## Endurance Test Summary

* **Jobs Processed**: 39,645,000 (~39.6 Million)
* **Duration**: 2 hours 0 minutes 8 seconds (7,207.66 seconds)
* **Average Throughput**: 5,500.40 jobs/sec
* **Peak Throughput**: 5,755.53 jobs/sec
* **Memory RSS (Start)**: 51 MB (Pre-load baseline)
* **Memory RSS (End)**: 358 MB (Post-processing idle state)
* **Status**: **`PASS`**

---

## Health Telemetry Timeline (Key Checkpoints)

| Time | Processed Jobs | Throughput (jobs/s) | RSS Memory (MB) | V8 Heap Used (MB) | Wait Queue Depth | Active Jobs | Completed | Failed |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **0s** | 0 | 0 | 51 MB | 28 MB | 30,000 | 0 | 0 | 0 |
| **30s** | 151,050 | 5,035 | 342 MB | 171 MB | 33,603 | 2 | 151,397 | 0 |
| **30m (1801s)** | 10,079,419 | 5,629 | 357 MB | 90 MB | 30,543 | 4 | 10,079,421 | 0 |
| **1h (3601s)** | 19,870,653 | 5,369 | 362 MB | 83 MB | 34,111 | 21 | 19,870,888 | 0 |
| **1.5h (5401s)** | 29,722,855 | 5,579 | 358 MB | 87 MB | 32,105 | 10 | 29,722,896 | 0 |
| **2h (7202s)** | 39,618,229 | 5,567 | 360 MB | 211 MB | 26,725 | 0 | 39,618,265 | 0 |
| **End (7208s)** | 39,645,000 | 5,500 | 358 MB | 31 MB | 0 | 0 | 39,645,000 | 0 |

---

## Architectural Findings & Verification

### 1. Memory Leak Verification
* **RSS Profiling**: Physical memory (RSS) started at **51 MB** before load. Once the worker concurrency slots and Redis queue buffers were initialized, RSS rose to **342 MB** (at 30s) and remained completely flat between **338 MB and 362 MB** for the entire 2-hour run. There was **zero upward drift**.
* **Garbage Collection Efficiency**: The V8 heap peaked at **238 MB** during processing and was regularly GC-reclaimed down to **38–42 MB**, returning to a clean **31 MB** at the end of the run. This confirms that all finished jobs, database connection buffers, and telemetry memory allocations are cleanly collected.
* **Verdict**: **`PASS`** — Zero memory leaks.

### 2. Job Loss Verification
* **Expected Jobs**: 39,645,000
* **Completed**: 39,645,000
* **Failed**: 0
* **Remaining (Wait/Active)**: 0
* **Formula**: $\text{Expected} = \text{Completed} + \text{Failed}$
* **Verdict**: **`PASS`** — 100% processing rate with zero job loss or drops.

### 3. Throughput Stability Verification
* Throughput was consistently maintained between **5,035 jobs/s** and **5,755 jobs/s** with no degradation or speed drop-off over the 2-hour duration.
* **Verdict**: **`PASS`** — Non-degrading, stable event consumption.

### 4. System Crash Safety
* The library workers, scheduler daemon, and Redis connection pool completed the entire 39.6 million job workflow continuously without a single exception or crash.
* **Verdict**: **`PASS`** — 100% system reliability.

---

## How to Run a Custom Duration Test

To run an endurance test for any duration (e.g. 3 hours / 10,800 seconds) on your system, execute the following command:
```bash
# Run for 3 hours maintaining a 30k buffer in Redis
node benchmarks/endurance.js --duration=10800
```
Once completed, generate the corresponding plots:
```bash
python benchmarks/generate_endurance_charts.py
```
