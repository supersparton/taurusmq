# Benchmarking Environment Specifications

The performance benchmarks and scaling audits comparing **TaurusMQ** and **BullMQ** were conducted on the following environment:

## Hardware Specifications
* **CPU**: AMD Ryzen 7 5800H (8 Cores, 16 Threads)
* **RAM**: 16 GB DDR4
* **Disk**: high-speed NVMe SSD

## Software Specifications
* **Operating System**: Windows 11 Home (64-bit)
* **Node.js Runtime**: v22.16.0 (V8 Engine)
* **Redis Server**: v8.8.0

## Redis Configuration
To isolate the benchmark and measure the true memory-bound enqueue and processing speed of the queue architectures, Redis persistence was disabled to prevent disk write bottlenecks:
```ini
appendonly no
save ""
```
* **Network Binding**: Localhost loopback (`127.0.0.1:6379`)
* **Network Latency**: Near-zero (~0.05ms)

## Test Parameters
* **Job Count**: 50,000 jobs (bulk enqueued)
* **Payload Size**: 100 bytes (structured JSON data payload)
* **Worker Concurrency**: 50 active processing threads
* **Test Iterations**: 5 consecutive runs per library
* **Reporting Model**: Statistical mean (average), median, min, max, and standard deviation ($\sigma$).
