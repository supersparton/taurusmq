# taurusmq/benchmarks/generate_charts.py
import json
import os
import matplotlib.pyplot as plt

# Set clean styling
plt.style.use('seaborn-v0_8-whitegrid' if 'seaborn-v0_8-whitegrid' in plt.style.available else 'default')
plt.rcParams['font.sans-serif'] = 'Arial'
plt.rcParams['font.family'] = 'sans-serif'
plt.rcParams['text.color'] = '#2c3e50'
plt.rcParams['axes.labelcolor'] = '#2c3e50'
plt.rcParams['xtick.color'] = '#2c3e50'
plt.rcParams['ytick.color'] = '#2c3e50'

# Load data
base_dir = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(base_dir, 'taurusmq-results.json')) as f:
    taurus_data = json.load(f)
with open(os.path.join(base_dir, 'bullmq-results.json')) as f:
    bull_data = json.load(f)

# Ensure charts directory exists
charts_dir = os.path.join(base_dir, 'charts')
os.makedirs(charts_dir, exist_ok=True)

# Stress test data extract
concurrencies = [s['concurrency'] for s in taurus_data['stress']]

taurus_tp = [s['consumerThroughput']['avg'] for s in taurus_data['stress']]
bull_tp = [s['consumerThroughput']['avg'] for s in bull_data['stress']]

taurus_lat = [s['avgLatencyMs']['avg'] / 1000.0 for s in taurus_data['stress']] # convert to seconds
bull_lat = [s['avgLatencyMs']['avg'] / 1000.0 for s in bull_data['stress']]

taurus_p95 = [s['p95Ms']['avg'] / 1000.0 for s in taurus_data['stress']]
bull_p95 = [s['p95Ms']['avg'] / 1000.0 for s in bull_data['stress']]

colors = {'taurus': '#ff4757', 'bull': '#2e86de'}

# Chart 1: Throughput vs Concurrency
plt.figure(figsize=(8, 5))
plt.plot(concurrencies, bull_tp, marker='o', color=colors['bull'], linewidth=2.5, label='BullMQ')
plt.plot(concurrencies, taurus_tp, marker='^', color=colors['taurus'], linewidth=2.5, label='TaurusMQ')
plt.title('Consumer Throughput vs Concurrency (Higher is Better)', fontsize=14, fontweight='bold', pad=15)
plt.xlabel('Concurrency (Workers)', fontsize=12)
plt.ylabel('Throughput (jobs/sec)', fontsize=12)
plt.xticks(concurrencies)
plt.legend(frameon=True, facecolor='white', edgecolor='#e2e8f0')
plt.tight_layout()
plt.savefig(os.path.join(charts_dir, 'throughput.png'), dpi=300)
plt.close()

# Chart 2: Average Latency vs Concurrency
plt.figure(figsize=(8, 5))
plt.plot(concurrencies, bull_lat, marker='o', color=colors['bull'], linewidth=2.5, label='BullMQ')
plt.plot(concurrencies, taurus_lat, marker='^', color=colors['taurus'], linewidth=2.5, label='TaurusMQ')
plt.title('Average Latency vs Concurrency (Lower is Better)', fontsize=14, fontweight='bold', pad=15)
plt.xlabel('Concurrency (Workers)', fontsize=12)
plt.ylabel('Average Latency (seconds)', fontsize=12)
plt.xticks(concurrencies)
plt.legend(frameon=True, facecolor='white', edgecolor='#e2e8f0')
plt.tight_layout()
plt.savefig(os.path.join(charts_dir, 'latency.png'), dpi=300)
plt.close()

# Chart 3: P95 Latency vs Concurrency
plt.figure(figsize=(8, 5))
plt.plot(concurrencies, bull_p95, marker='o', color=colors['bull'], linewidth=2.5, label='BullMQ')
plt.plot(concurrencies, taurus_p95, marker='^', color=colors['taurus'], linewidth=2.5, label='TaurusMQ')
plt.title('P95 Latency vs Concurrency (Lower is Better)', fontsize=14, fontweight='bold', pad=15)
plt.xlabel('Concurrency (Workers)', fontsize=12)
plt.ylabel('P95 Latency (seconds)', fontsize=12)
plt.xticks(concurrencies)
plt.legend(frameon=True, facecolor='white', edgecolor='#e2e8f0')
plt.tight_layout()
plt.savefig(os.path.join(charts_dir, 'p95_latency.png'), dpi=300)
plt.close()

# Chart 4: Enqueue Throughput Comparison
plt.figure(figsize=(6, 5))
labels = ['BullMQ', 'TaurusMQ']
enqueue_vals = [bull_data['performance']['enqueueThroughput']['avg'], taurus_data['performance']['enqueueThroughput']['avg']]
bars = plt.bar(labels, enqueue_vals, color=[colors['bull'], colors['taurus']], width=0.5)
plt.title('Enqueue Throughput Comparison (Higher is Better)', fontsize=14, fontweight='bold', pad=15)
plt.ylabel('Enqueue Throughput (jobs/sec)', fontsize=12)
for bar in bars:
    yval = bar.get_height()
    plt.text(bar.get_x() + bar.get_width()/2.0, yval + 500, f'{int(yval):,}', ha='center', va='bottom', fontweight='bold')
plt.tight_layout()
plt.savefig(os.path.join(charts_dir, 'enqueue_comparison.png'), dpi=300)
plt.close()

# Chart 5: CPU Time Comparison
plt.figure(figsize=(6, 5))
cpu_vals = [bull_data['performance']['cpuMs']['avg'] / 1000.0, taurus_data['performance']['cpuMs']['avg'] / 1000.0]
bars = plt.bar(labels, cpu_vals, color=[colors['bull'], colors['taurus']], width=0.5)
plt.title('Total CPU Time for 50,000 Jobs (Lower is Better)', fontsize=14, fontweight='bold', pad=15)
plt.ylabel('CPU Time (seconds)', fontsize=12)
for bar in bars:
    yval = bar.get_height()
    plt.text(bar.get_x() + bar.get_width()/2.0, yval + 0.2, f'{yval:.2f}s', ha='center', va='bottom', fontweight='bold')
plt.tight_layout()
plt.savefig(os.path.join(charts_dir, 'cpu.png'), dpi=300)
plt.close()

# Chart 6: Memory Comparison
plt.figure(figsize=(6, 5))
ram_vals = [bull_data['performance']['peakRssMB']['avg'], taurus_data['performance']['peakRssMB']['avg']]
bars = plt.bar(labels, ram_vals, color=[colors['bull'], colors['taurus']], width=0.5)
plt.title('Peak RSS Memory Usage (Lower is Better)', fontsize=14, fontweight='bold', pad=15)
plt.ylabel('Memory Usage (MB)', fontsize=12)
for bar in bars:
    yval = bar.get_height()
    plt.text(bar.get_x() + bar.get_width()/2.0, yval + 2, f'{int(yval)} MB', ha='center', va='bottom', fontweight='bold')
plt.tight_layout()
plt.savefig(os.path.join(charts_dir, 'memory.png'), dpi=300)
plt.close()

print('Charts successfully generated and written to taurusmq/benchmarks/charts/')
